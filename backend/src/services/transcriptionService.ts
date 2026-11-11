import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../config/env.ts'
import type { TranscriptData } from '../types/index.ts'
import { ensureDir } from '../utils/fsSafe.ts'
import { log } from '../utils/logger.ts'
import { getAdaptiveProcessingProfile } from '../utils/memoryMonitor.ts'

export interface AudioEnergyData {
  sampleRate: number
  hopMs: number
  durationSec: number
  speechThreshold: number
  rms: number[]
}

export async function runTranscriptionStage(params: {
  wavPath: string
  outTranscriptPath: string
  outEnergyPath: string
  modelName?: string
  signal?: AbortSignal
  trackChild?: (child: ChildProcess) => () => void
  onProgress?: (percent: number, detail: string) => void
  projectId?: string
}): Promise<{ transcript: TranscriptData; energy: AudioEnergyData }> {
  const {
    wavPath,
    outTranscriptPath,
    outEnergyPath,
    modelName = env.processing.whisperModel,
    signal,
    trackChild,
    onProgress,
    projectId
  } = params

  await ensureDir(path.dirname(outTranscriptPath))
  await ensureDir(env.modelsDir)

  const profile = getAdaptiveProcessingProfile()
  const threads = Math.min(env.processing.whisperThreads, Math.max(1, profile.ffmpegThreads))
  const scriptPath = path.join(env.cvDir, 'transcribe.py')

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Transcription aborted before starting'))
      return
    }

    const child = spawn(
      env.pythonBin,
      [
        scriptPath,
        '--wav',
        wavPath,
        '--out-transcript',
        outTranscriptPath,
        '--out-energy',
        outEnergyPath,
        '--models-dir',
        env.modelsDir,
        '--model',
        modelName,
        '--threads',
        String(threads)
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
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
            onProgress?.(parsed.percent ?? 0, parsed.detail ?? 'Transcribing...')
          }
        } catch {
          log('debug', 'WhisperWorker', trimmed, projectId)
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const txt = chunk.toString('utf8')
      stderrTail = (stderrTail + txt).slice(-4096)
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
        reject(new Error('Transcription cancelled'))
        return
      }
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`whisper.cpp worker exited with code ${code}: ${stderrTail.trim()}`))
      }
    })
  })

  const [transcriptRaw, energyRaw] = await Promise.all([
    readFile(outTranscriptPath, 'utf8'),
    readFile(outEnergyPath, 'utf8')
  ])

  return {
    transcript: JSON.parse(transcriptRaw) as TranscriptData,
    energy: JSON.parse(energyRaw) as AudioEnergyData
  }
}

