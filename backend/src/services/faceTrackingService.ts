import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../config/env.ts'
import type {
  ClipTrackingResult,
  CompositionMode,
  VideoMetadata
} from '../types/index.ts'
import { ensureDir } from '../utils/fsSafe.ts'
import { log } from '../utils/logger.ts'
import { getAdaptiveProcessingProfile } from '../utils/memoryMonitor.ts'
import { resolveFfmpegBin } from './ffmpegService.ts'
import { buildSmoothTrajectory, type RawTrackingPayload } from './trajectoryEngine.ts'

export async function runClipFaceTracking(params: {
  clipId: string
  projectId: string
  videoPath: string
  metadata: VideoMetadata
  startTimeSec: number
  endTimeSec: number
  compositionMode: CompositionMode
  outTrackingPath: string
  energyJsonPath?: string | null
  transcriptJsonPath?: string | null
  signal?: AbortSignal
  trackChild?: (child: ChildProcess) => () => void
  onProgress?: (percent: number, detail: string) => void
}): Promise<ClipTrackingResult> {
  const {
    clipId,
    projectId,
    videoPath,
    metadata,
    startTimeSec,
    endTimeSec,
    compositionMode,
    outTrackingPath,
    energyJsonPath,
    transcriptJsonPath,
    signal,
    trackChild,
    onProgress
  } = params

  await ensureDir(path.dirname(outTrackingPath))
  const rawJsonPath = `${outTrackingPath}.raw.json`
  const ffmpegBin = await resolveFfmpegBin()
  const profile = getAdaptiveProcessingProfile()
  const scriptPath = path.join(env.cvDir, 'face_track.py')
  const durationSec = Math.max(0.5, endTimeSec - startTimeSec)

  const cliArgs = [
    scriptPath,
    '--video',
    videoPath,
    '--start-sec',
    startTimeSec.toFixed(3),
    '--duration-sec',
    durationSec.toFixed(3),
    '--source-width',
    String(metadata.width),
    '--source-height',
    String(metadata.height),
    '--source-fps',
    String(metadata.fps || 30),
    '--analysis-width',
    String(profile.cvAnalysisWidth),
    '--base-fps',
    String(profile.cvBaseFps),
    '--boost-fps',
    String(profile.cvBoostFps),
    '--models-dir',
    env.modelsDir,
    '--out-json',
    rawJsonPath,
    '--ffmpeg-bin',
    ffmpegBin,
    '--ffmpeg-threads',
    String(profile.ffmpegThreads),
    '--use-mediapipe',
    profile.allowMediaPipeMouth ? '1' : '0'
  ]

  if (energyJsonPath) {
    cliArgs.push('--energy-json', energyJsonPath)
  }
  if (transcriptJsonPath) {
    cliArgs.push('--transcript-json', transcriptJsonPath)
  }

  try {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Face tracking aborted before starting'))
        return
      }

      const child = spawn(env.pythonBin, cliArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const untrack = trackChild?.(child)

      let stdoutCarry = ''
      let stderrTail = ''

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutCarry += chunk.toString('utf8')
        const lines = stdoutCarry.split(/\r?\n/)
        stdoutCarry = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const parsed = JSON.parse(trimmed) as {
              event?: string
              percent?: number
              detail?: string
            }
            if (parsed.event === 'progress') {
              onProgress?.(parsed.percent ?? 0, parsed.detail ?? 'Tracking faces...')
            } else if (parsed.event === 'warn') {
              log('warn', 'FaceTrackWorker', parsed.detail || trimmed, projectId)
            }
          } catch {
            log('debug', 'FaceTrackWorker', trimmed, projectId)
          }
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096)
      })

      const onAbort = () => {
        try {
          child.kill('SIGTERM')
          setTimeout(() => {
            try {
              if (!child.killed) child.kill('SIGKILL')
            } catch {}
          }, 1200).unref()
        } catch {}
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      child.once('error', (err) => {
        signal?.removeEventListener('abort', onAbort)
        untrack?.()
        reject(err)
      })

      child.once('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        untrack?.()
        if (signal?.aborted) {
          reject(new Error('Face tracking cancelled'))
          return
        }
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`face_track.py exited with code ${code}: ${stderrTail.trim()}`))
        }
      })
    })

    const raw = JSON.parse(await readFile(rawJsonPath, 'utf8')) as RawTrackingPayload
    const trajectory = buildSmoothTrajectory({
      clipId,
      raw,
      sourceFps: metadata.fps || 30,
      compositionMode
    })

    await writeFile(outTrackingPath, JSON.stringify(trajectory), 'utf8')
    return trajectory
  } finally {
    await rm(rawJsonPath, { force: true }).catch(() => {})
  }
}

