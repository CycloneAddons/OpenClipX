import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { log } from '../utils/logger.ts'
import {
  getMemorySnapshot,
  registerChildPid,
  unregisterChildPid
} from '../utils/memoryMonitor.ts'
import { clipRepo, projectRepo } from '../db/database.ts'
import type { JobState, PipelineProgressEvent } from '../types/index.ts'

export interface QueuedTask {
  id: string
  projectId: string
  clipId?: string
  kind: 'project_pipeline' | 'clip_render'
  run: (ctx: JobExecutionContext) => Promise<void>
}

export interface JobExecutionContext {
  projectId: string
  clipId?: string
  signal: AbortSignal
  throwIfAborted: () => void
  trackChildProcess: (child: ChildProcess) => () => void
  reportProgress: (
    state: JobState,
    stageProgress: number,
    overallProgress: number,
    message: string,
    clipId?: string
  ) => void
}

export class JobCancelledError extends Error {
  constructor(message = 'Job cancelled by user') {
    super(message)
    this.name = 'JobCancelledError'
  }
}

class LocalJobQueue extends EventEmitter {
  private readonly queue: QueuedTask[] = []
  private currentTask: {
    task: QueuedTask
    abortController: AbortController
    children: Set<ChildProcess>
  } | null = null
  private draining = false

  constructor() {
    super()
    this.setMaxListeners(100)
  }

  public enqueue(task: QueuedTask): { position: number } {
    // Prevent duplicate pending tasks for the same project+clip
    const duplicate =
      (this.currentTask?.task.projectId === task.projectId &&
        this.currentTask?.task.clipId === task.clipId &&
        this.currentTask?.task.kind === task.kind) ||
      this.queue.some(
        (t) =>
          t.projectId === task.projectId &&
          t.clipId === task.clipId &&
          t.kind === task.kind
      )

    if (duplicate) {
      throw new Error('A job for this target is already queued or running')
    }

    this.queue.push(task)
    const position = this.queue.length + (this.currentTask ? 1 : 0)
    log('info', 'JobQueue', `Enqueued ${task.kind} (queue position ${position})`, task.projectId)
    void this.drain()
    return { position }
  }

  public isBusy(): boolean {
    return this.currentTask !== null || this.queue.length > 0
  }

  public getStatus(): {
    active: { id: string; projectId: string; clipId?: string; kind: string } | null
    queuedCount: number
    queued: Array<{ id: string; projectId: string; clipId?: string; kind: string }>
  } {
    return {
      active: this.currentTask
        ? {
            id: this.currentTask.task.id,
            projectId: this.currentTask.task.projectId,
            clipId: this.currentTask.task.clipId,
            kind: this.currentTask.task.kind
          }
        : null,
      queuedCount: this.queue.length,
      queued: this.queue.map((t) => ({
        id: t.id,
        projectId: t.projectId,
        clipId: t.clipId,
        kind: t.kind
      }))
    }
  }

  public cancelByProjectOrClip(projectId: string, clipId?: string): boolean {
    let cancelled = false

    // Remove queued matching tasks and update their persisted state immediately
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const item = this.queue[i]
      if (!item) continue
      if (item.projectId === projectId && (!clipId || item.clipId === clipId)) {
        this.queue.splice(i, 1)
        if (item.kind === 'project_pipeline') {
          projectRepo.update(item.projectId, {
            status: 'CANCELLED',
            currentStageLabel: 'Cancelled while queued'
          })
          projectRepo.appendLog(item.projectId, 'warn', 'CANCELLED', 'Cancelled while queued')
        } else if (item.clipId) {
          clipRepo.update(item.clipId, { status: 'CANCELLED' })
        }
        this.emitProgress({
          projectId: item.projectId,
          clipId: item.clipId,
          state: 'CANCELLED',
          stageProgress: 0,
          overallProgress: 0,
          message: 'Cancelled while queued',
          memory: getMemorySnapshot(),
          timestamp: new Date().toISOString()
        })
        cancelled = true
      }
    }

    // Abort active task if matching
    if (
      this.currentTask &&
      this.currentTask.task.projectId === projectId &&
      (!clipId || this.currentTask.task.clipId === clipId)
    ) {
      this.currentTask.abortController.abort(new JobCancelledError())
      if (this.currentTask.task.kind === 'project_pipeline') {
        projectRepo.update(projectId, {
          status: 'CANCELLED',
          currentStageLabel: 'Cancelling...'
        })
      } else if (this.currentTask.task.clipId) {
        clipRepo.update(this.currentTask.task.clipId, { status: 'CANCELLED' })
      }
      for (const child of this.currentTask.children) {
        try {
          child.kill('SIGTERM')
          setTimeout(() => {
            try {
              if (!child.killed) child.kill('SIGKILL')
            } catch {}
          }, 1500).unref()
        } catch {}
      }
      cancelled = true
    }

    return cancelled
  }

  public async shutdownAll(): Promise<void> {
    this.queue.length = 0
    if (this.currentTask) {
      this.currentTask.abortController.abort(new Error('Server shutting down'))
      for (const child of this.currentTask.children) {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
    }
  }

  public emitProgress(event: PipelineProgressEvent): void {
    this.emit(`progress:${event.projectId}`, event)
    this.emit('progress', event)
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true

    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!
        const abortController = new AbortController()
        const children = new Set<ChildProcess>()
        this.currentTask = { task, abortController, children }

        const ctx: JobExecutionContext = {
          projectId: task.projectId,
          clipId: task.clipId,
          signal: abortController.signal,
          throwIfAborted: () => {
            if (abortController.signal.aborted) {
              throw new JobCancelledError()
            }
          },
          trackChildProcess: (child: ChildProcess) => {
            children.add(child)
            registerChildPid(child.pid)
            const cleanup = () => {
              children.delete(child)
              unregisterChildPid(child.pid)
            }
            child.once('exit', cleanup)
            child.once('error', cleanup)
            return cleanup
          },
          reportProgress: (state, stageProgress, overallProgress, message, clipId) => {
            const clampedStage = Math.max(0, Math.min(100, Math.round(stageProgress)))
            const clampedOverall = Math.max(0, Math.min(100, Math.round(overallProgress)))

            if (task.kind === 'project_pipeline') {
              projectRepo.update(task.projectId, {
                status: state,
                stageProgress: clampedStage,
                overallProgress: clampedOverall,
                currentStageLabel: message
              })
            }
            projectRepo.appendLog(task.projectId, 'info', state, message)
            log('info', state, message, task.projectId)

            this.emitProgress({
              projectId: task.projectId,
              clipId: clipId ?? task.clipId,
              state,
              stageProgress: clampedStage,
              overallProgress: clampedOverall,
              message,
              memory: getMemorySnapshot(),
              timestamp: new Date().toISOString()
            })
          }
        }

        try {
          await task.run(ctx)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const isCancel =
            err instanceof JobCancelledError || abortController.signal.aborted
          const finalState: JobState = isCancel ? 'CANCELLED' : 'FAILED'
          log(isCancel ? 'warn' : 'error', 'JobQueue', `${task.kind} ${finalState}: ${message}`, task.projectId)
          projectRepo.appendLog(task.projectId, isCancel ? 'warn' : 'error', finalState, message)

          if (task.kind === 'project_pipeline') {
            projectRepo.update(task.projectId, {
              status: finalState,
              currentStageLabel: isCancel ? 'Cancelled by user' : `Failed: ${message}`,
              errorMessage: isCancel ? null : message
            })
          }

          this.emitProgress({
            projectId: task.projectId,
            clipId: task.clipId,
            state: finalState,
            stageProgress: 0,
            overallProgress: 0,
            message: isCancel ? 'Cancelled by user' : message,
            memory: getMemorySnapshot(),
            timestamp: new Date().toISOString()
          })
        } finally {
          for (const child of children) {
            try {
              if (!child.killed) child.kill('SIGKILL')
            } catch {}
            unregisterChildPid(child.pid)
          }
          children.clear()
          this.currentTask = null
        }
      }
    } finally {
      this.draining = false
    }
  }
}

export const jobQueue = new LocalJobQueue()

