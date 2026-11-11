import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { detectFfmpegBinary } from 'ytora'
import { env } from '../config/env.ts'
import type { VideoMetadata } from '../types/index.ts'
import { ensureDir } from '../utils/fsSafe.ts'
import { log } from '../utils/logger.ts'
import { getAdaptiveProcessingProfile } from '../utils/memoryMonitor.ts'

const execFileAsync = promisify(execFile)

let cachedFfmpegBin: string | null = null
let cachedFfprobeBin: string | null = null

export async function resolveFfmpegBin(): Promise<string> {
  if (cachedFfmpegBin) return cachedFfmpegBin
  if (env.ffmpegPath && existsSync(env.ffmpegPath)) {
    cachedFfmpegBin = env.ffmpegPath
    return cachedFfmpegBin
  }
  const detected = await detectFfmpegBinary()
  if (detected?.bin) {
    cachedFfmpegBin = detected.bin
    return cachedFfmpegBin
  }
  cachedFfmpegBin = 'ffmpeg'
  return cachedFfmpegBin
}

export async function resolveFfprobeBin(): Promise<string> {
  if (cachedFfprobeBin) return cachedFfprobeBin
  if (env.ffprobePath && existsSync(env.ffprobePath)) {
    cachedFfprobeBin = env.ffprobePath
    return cachedFfprobeBin
  }
  try {
    await execFileAsync('ffprobe', ['-version'], { timeout: 5000 })
    cachedFfprobeBin = 'ffprobe'
    return cachedFfprobeBin
  } catch {
    const ff = await resolveFfmpegBin()
    const sibling = path.join(path.dirname(ff), 'ffprobe')
    cachedFfprobeBin = existsSync(sibling) ? sibling : 'ffprobe'
    return cachedFfprobeBin
  }
}

export function runCancellableSpawn(
  bin: string,
  args: string[],
  options?: {
    signal?: AbortSignal
    trackChild?: (child: ChildProcess) => () => void
    onStderrLine?: (line: string) => void
  }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(new Error('Process aborted before launch'))
      return
    }

    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const untrack = options?.trackChild?.(child)

    let stdout = ''
    let stderr = ''
    let stderrCarry = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 2 * 1024 * 1024) {
        stdout += chunk.toString('utf8')
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (stderr.length < 2 * 1024 * 1024) {
        stderr += text
      }
      if (options?.onStderrLine) {
        stderrCarry += text
        const lines = stderrCarry.split(/\r?\n/)
        stderrCarry = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) options.onStderrLine(line.trim())
        }
      }
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
    options?.signal?.addEventListener('abort', onAbort, { once: true })

    child.once('error', (err) => {
      options?.signal?.removeEventListener('abort', onAbort)
      untrack?.()
      reject(err)
    })

    child.once('close', (code) => {
      options?.signal?.removeEventListener('abort', onAbort)
      untrack?.()
      if (options?.signal?.aborted) {
        reject(new Error('Process cancelled'))
        return
      }
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        const tail = stderr.trim().split(/\r?\n/).slice(-8).join('\n')
        reject(new Error(`${path.basename(bin)} exited with code ${code}: ${tail}`))
      }
    })
  })
}

function parseFrameRate(raw: string | undefined): number {
  if (!raw) return 30
  if (raw.includes('/')) {
    const [numStr, denStr] = raw.split('/')
    const num = Number(numStr)
    const den = Number(denStr)
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Math.round((num / den) * 1000) / 1000
    }
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30
}

export async function probeVideoMetadata(
  videoPath: string,
  extra?: Partial<VideoMetadata>
): Promise<VideoMetadata> {
  const ffprobe = await resolveFfprobeBin()
  const { stdout } = await execFileAsync(
    ffprobe,
    [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      videoPath
    ],
    { timeout: 15000 }
  )

  const parsed = JSON.parse(stdout) as {
    format?: {
      duration?: string
      bit_rate?: string
      size?: string
      tags?: Record<string, string>
    }
    streams?: Array<{
      codec_type?: string
      codec_name?: string
      width?: number
      height?: number
      avg_frame_rate?: string
      r_frame_rate?: string
      duration?: string
      tags?: Record<string, string>
      side_data_list?: Array<{ rotation?: number }>
    }>
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video')
  if (!videoStream) {
    throw new Error('No video stream found in media file')
  }
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio')

  let rotationDeg = 0
  if (videoStream.tags?.rotate) {
    rotationDeg = Number(videoStream.tags.rotate) || 0
  } else if (Array.isArray(videoStream.side_data_list)) {
    const rotEntry = videoStream.side_data_list.find((d) => typeof d.rotation === 'number')
    if (rotEntry && typeof rotEntry.rotation === 'number') {
      rotationDeg = rotEntry.rotation
    }
  }

  let width = Number(videoStream.width || 0)
  let height = Number(videoStream.height || 0)
  const normRot = ((Math.round(rotationDeg) % 360) + 360) % 360
  if (normRot === 90 || normRot === 270) {
    ;[width, height] = [height, width]
  }

  const durationSec =
    Number(parsed.format?.duration || videoStream.duration || 0) ||
    extra?.durationSec ||
    0
  const fps = parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate)
  const fileStat = await stat(videoPath).catch(() => null)

  return {
    videoId: extra?.videoId,
    title: extra?.title || parsed.format?.tags?.title || path.basename(videoPath),
    author: extra?.author || parsed.format?.tags?.artist || '',
    durationSec,
    width,
    height,
    fps,
    rotationDeg,
    codec: videoStream.codec_name || 'unknown',
    audioCodec: audioStream?.codec_name,
    bitrateBps: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : undefined,
    sizeBytes: fileStat?.size ?? (parsed.format?.size ? Number(parsed.format.size) : undefined),
    thumbnailUrl: extra?.thumbnailUrl ?? null
  }
}

export async function extractAudioWav16k(params: {
  videoPath: string
  outWavPath: string
  signal?: AbortSignal
  trackChild?: (child: ChildProcess) => () => void
}): Promise<string> {
  const ffmpeg = await resolveFfmpegBin()
  const profile = getAdaptiveProcessingProfile()
  await ensureDir(path.dirname(params.outWavPath))

  await runCancellableSpawn(
    ffmpeg,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      String(profile.ffmpegThreads),
      '-i',
      params.videoPath,
      '-vn',
      '-acodec',
      'pcm_s16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      params.outWavPath
    ],
    {
      signal: params.signal,
      trackChild: params.trackChild
    }
  )

  return params.outWavPath
}

export async function extractSampledKeyframes(params: {
  videoPath: string
  durationSec: number
  tempFramesDir: string
  maxFrames?: number
  maxWidth?: number
  signal?: AbortSignal
  trackChild?: (child: ChildProcess) => () => void
}): Promise<Array<{ timestampSec: number; base64Jpeg: string; filePath: string }>> {
  const ffmpeg = await resolveFfmpegBin()
  const profile = getAdaptiveProcessingProfile()
  await ensureDir(params.tempFramesDir)

  const maxFrames = Math.max(2, Math.min(params.maxFrames ?? 8, 12))
  const maxWidth = params.maxWidth ?? 512
  const interval = Math.max(1, params.durationSec / (maxFrames + 1))

  const results: Array<{ timestampSec: number; base64Jpeg: string; filePath: string }> = []
  for (let i = 1; i <= maxFrames; i++) {
    if (params.signal?.aborted) break
    const ts = Math.min(Math.max(0.5, i * interval), Math.max(0.5, params.durationSec - 0.5))
    const outPath = path.join(params.tempFramesDir, `keyframe_${i}.jpg`)
    try {
      await runCancellableSpawn(
        ffmpeg,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-threads',
          String(profile.ffmpegThreads),
          '-ss',
          ts.toFixed(2),
          '-i',
          params.videoPath,
          '-frames:v',
          '1',
          '-vf',
          `scale='min(${maxWidth},iw)':-2`,
          '-q:v',
          '6',
          outPath
        ],
        {
          signal: params.signal,
          trackChild: params.trackChild
        }
      )
      if (existsSync(outPath)) {
        const buf = await readFile(outPath)
        results.push({
          timestampSec: Math.round(ts * 10) / 10,
          base64Jpeg: buf.toString('base64'),
          filePath: outPath
        })
      }
    } catch (err) {
      log('warn', 'FFmpeg', `Failed extracting keyframe at ${ts.toFixed(1)}s: ${(err as Error).message}`)
    }
  }

  return results
}

export async function extractClipThumbnail(params: {
  videoPath: string
  outJpgPath: string
  seekSec?: number
  signal?: AbortSignal
  trackChild?: (child: ChildProcess) => () => void
}): Promise<string> {
  const ffmpeg = await resolveFfmpegBin()
  const profile = getAdaptiveProcessingProfile()
  await ensureDir(path.dirname(params.outJpgPath))

  await runCancellableSpawn(
    ffmpeg,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      String(profile.ffmpegThreads),
      '-ss',
      (params.seekSec ?? 1.0).toFixed(2),
      '-i',
      params.videoPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=540:-2',
      '-q:v',
      '4',
      params.outJpgPath
    ],
    {
      signal: params.signal,
      trackChild: params.trackChild
    }
  )

  return params.outJpgPath
}

