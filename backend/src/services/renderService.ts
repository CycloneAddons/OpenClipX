import { existsSync } from 'node:fs'
import { rm, stat, writeFile } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import type {
  ClipTrackingResult,
  RenderQuality,
  TrackingFrameSample,
  VideoMetadata
} from '../types/index.ts'
import { ensureDir } from '../utils/fsSafe.ts'
import { getAdaptiveProcessingProfile } from '../utils/memoryMonitor.ts'
import {
  extractClipThumbnail,
  resolveFfmpegBin,
  runCancellableSpawn
} from './ffmpegService.ts'

const QUALITY_MAP: Record<RenderQuality, { crf: number; maxrate: string; bufsize: string; preset: string }> = {
  low: { crf: 26, maxrate: '2500k', bufsize: '5000k', preset: 'veryfast' },
  medium: { crf: 22, maxrate: '4500k', bufsize: '9000k', preset: 'veryfast' },
  high: { crf: 18, maxrate: '7500k', bufsize: '15000k', preset: 'faster' },
  ultra: { crf: 16, maxrate: '11000k', bufsize: '22000k', preset: 'fast' }
}

function makeEven(n: number): number {
  const r = Math.round(n)
  return r % 2 === 0 ? r : Math.max(2, r - 1)
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

function pickCropBox(f: TrackingFrameSample, useSecondary: boolean) {
  return useSecondary && f.cropSecondary ? f.cropSecondary : f.cropPrimary
}

function nearestModeFrame(
  frames: TrackingFrameSample[],
  t: number,
  modeFilter: 'single' | 'dual_split'
): TrackingFrameSample | null {
  let prev: TrackingFrameSample | null = null
  let next: TrackingFrameSample | null = null
  for (const f of frames) {
    if (f.layoutMode !== modeFilter) continue
    if (f.timeSec <= t) prev = f
    else {
      next = f
      break
    }
  }
  if (!prev) return next
  if (!next) return prev
  return next.timeSec - t <= t - prev.timeSec ? next : prev
}

function sampleInterpolatedCrop(
  frames: TrackingFrameSample[],
  t: number,
  useSecondary: boolean,
  modeFilter?: 'single' | 'dual_split'
): { x: number; y: number; w: number; h: number } {
  if (frames.length === 0) {
    return { x: 0.34, y: 0, w: 0.3164, h: 1 }
  }

  if (modeFilter) {
    const firstMatch = frames.find((f) => f.layoutMode === modeFilter)
    if (!firstMatch) return pickCropBox(frames[0]!, useSecondary)
  }

  const first = frames[0]!
  const last = frames[frames.length - 1]!

  if (t <= first.timeSec) {
    const target = modeFilter && first.layoutMode !== modeFilter
      ? nearestModeFrame(frames, t, modeFilter) ?? first
      : first
    return pickCropBox(target, useSecondary)
  }
  if (t >= last.timeSec) {
    const target = modeFilter && last.layoutMode !== modeFilter
      ? nearestModeFrame(frames, t, modeFilter) ?? last
      : last
    return pickCropBox(target, useSecondary)
  }

  // Binary search enclosing frames
  let lo = 0
  let hi = frames.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (frames[mid]!.timeSec <= t) lo = mid
    else hi = mid
  }

  const a = frames[lo]!
  const b = frames[hi]!

  if (modeFilter) {
    if (a.layoutMode !== modeFilter || b.layoutMode !== modeFilter) {
      if (b.layoutMode === modeFilter && t >= b.timeSec - 1e-4) {
        return pickCropBox(b, useSecondary)
      }
      const target = nearestModeFrame(frames, t, modeFilter)
      return pickCropBox(target ?? (a.layoutMode === modeFilter ? a : b), useSecondary)
    }
  }

  const ca = pickCropBox(a, useSecondary)
  const cb = pickCropBox(b, useSecondary)
  if (b.sceneCut || b.timeSec <= a.timeSec) {
    return b.timeSec - t < 1e-4 ? cb : ca
  }

  const alpha = (t - a.timeSec) / (b.timeSec - a.timeSec)
  return {
    x: ca.x + (cb.x - ca.x) * alpha,
    y: ca.y + (cb.y - ca.y) * alpha,
    w: ca.w + (cb.w - ca.w) * alpha,
    h: ca.h + (cb.h - ca.h) * alpha
  }
}

export function extractDualSplitIntervals(
  frames: TrackingFrameSample[],
  durationSec: number
): Array<{ startSec: number; endSec: number }> {
  const intervals: Array<{ startSec: number; endSec: number }> = []
  let i = 0
  while (i < frames.length) {
    const f = frames[i]!
    const isDual = f.layoutMode === 'dual_split' && f.cropSecondary != null
    if (!isDual) {
      i++
      continue
    }
    let j = i + 1
    while (
      j < frames.length &&
      frames[j]!.layoutMode === 'dual_split' &&
      frames[j]!.cropSecondary != null
    ) {
      j++
    }
    const startSec = i === 0 ? 0 : Math.max(0, f.timeSec - 0.002)
    const endSec =
      j < frames.length
        ? Math.max(startSec + 0.01, frames[j]!.timeSec - 0.002)
        : durationSec + 0.25
    intervals.push({ startSec, endSec })
    i = j
  }
  return intervals
}

export function buildSendcmdCropScript(params: {
  tracking: ClipTrackingResult
  targetName: string
  durationSec: number
  fps: number
  useSecondary?: boolean
  modeFilter?: 'single' | 'dual_split'
}): { script: string; initX: number; initY: number; cropW: number; cropH: number } {
  const {
    tracking,
    targetName,
    durationSec,
    fps,
    useSecondary = false,
    modeFilter
  } = params
  const srcW = tracking.sourceWidth
  const srcH = tracking.sourceHeight

  const refFrame =
    (modeFilter
      ? tracking.frames.find((f) => f.layoutMode === modeFilter)
      : tracking.frames[0]) ?? tracking.frames[0]
  const refBox = refFrame
    ? pickCropBox(refFrame, useSecondary)
    : sampleInterpolatedCrop(tracking.frames, 0, useSecondary, modeFilter)

  const cropW = Math.max(64, Math.min(makeEven(srcW), makeEven(refBox.w * srcW)))
  const cropH = Math.max(64, Math.min(makeEven(srcH), makeEven(refBox.h * srcH)))
  const maxX = Math.max(0, srcW - cropW)
  const maxY = Math.max(0, srcH - cropH)

  const firstSample = sampleInterpolatedCrop(tracking.frames, 0, useSecondary, modeFilter)
  const initX = clamp(Math.round(firstSample.x * srcW), 0, maxX)
  const initY = clamp(Math.round(firstSample.y * srcH), 0, maxY)

  const lines: string[] = []
  const gridFps = Math.max(15, Math.min(60, fps))
  const step = 1 / gridFps
  let prevX = -1
  let prevY = -1

  for (let frameIdx = 0; ; frameIdx++) {
    const t = frameIdx * step
    if (t > durationSec + step * 0.5) break
    const c = sampleInterpolatedCrop(tracking.frames, t, useSecondary, modeFilter)
    const px = clamp(Math.round(c.x * srcW), 0, maxX)
    const py = clamp(Math.round(c.y * srcH), 0, maxY)
    if (px !== prevX || py !== prevY) {
      // Subtract 1ms after t=0 so exact frame PTS matches >= cmd timestamp cleanly despite float rounding
      const cmdT = frameIdx === 0 ? 0 : Math.max(0, t - 0.001)
      lines.push(`${cmdT.toFixed(4)} ${targetName} x ${px}, ${targetName} y ${py};`)
      prevX = px
      prevY = py
    }
  }

  return {
    script: lines.join('\n') + '\n',
    initX,
    initY,
    cropW,
    cropH
  }
}

export async function renderVerticalShort(params: {
  sourceVideoPath: string
  metadata: VideoMetadata
  startTimeSec: number
  endTimeSec: number
  tracking: ClipTrackingResult
  assSubtitlePath?: string | null
  outputMp4Path: string
  thumbnailJpgPath?: string | null
  quality: RenderQuality
  targetFps?: number | null
  backgroundAudioPath?: string | null
  backgroundAudioVolume?: number
  dubbedAudioPath?: string | null
  signal?: AbortSignal
  trackChild?: (child: ChildProcess) => () => void
  onProgress?: (percent: number, detail: string) => void
}): Promise<{ outputPath: string; sizeBytes: number; thumbnailPath: string | null }> {
  const {
    sourceVideoPath,
    metadata,
    startTimeSec,
    endTimeSec,
    tracking,
    assSubtitlePath,
    outputMp4Path,
    thumbnailJpgPath,
    quality,
    targetFps,
    backgroundAudioPath,
    backgroundAudioVolume = 0.15,
    dubbedAudioPath,
    signal,
    trackChild,
    onProgress
  } = params

  await ensureDir(path.dirname(outputMp4Path))
  const ffmpeg = await resolveFfmpegBin()
  const profile = getAdaptiveProcessingProfile()

  const durationSec = Math.max(0.5, endTimeSec - startTimeSec)
  const outFps = targetFps && targetFps > 0 ? Math.min(60, targetFps) : Math.min(60, Math.max(24, metadata.fps || 30))
  const qCfg = QUALITY_MAP[quality] || QUALITY_MAP.high

  const tempCmdFiles: string[] = []
  const hasSourceAudio = Boolean(metadata.audioCodec)
  const hasDubbedAudio = Boolean(dubbedAudioPath && existsSync(dubbedAudioPath))
  const hasBgAudio = Boolean(backgroundAudioPath && existsSync(backgroundAudioPath))

  try {
    let filterComplex = ''
    const subtitleChain = assSubtitlePath && existsSync(assSubtitlePath)
      ? `,ass='${escapeFilterPath(assSubtitlePath)}'`
      : ''

    const dualIntervals = extractDualSplitIntervals(tracking.frames, durationSec)
    const hasSingleFrames = tracking.frames.some((f) => f.layoutMode !== 'dual_split')

    if (dualIntervals.length > 0 && hasSingleFrames) {
      // Dynamic mixed composition: smoothly switch between full 9:16 single frames and 2-up top/bottom split
      const singleCmd = buildSendcmdCropScript({
        tracking,
        targetName: 'crop@main',
        durationSec,
        fps: outFps,
        useSecondary: false,
        modeFilter: 'single'
      })
      const topCmd = buildSendcmdCropScript({
        tracking,
        targetName: 'crop@top',
        durationSec,
        fps: outFps,
        useSecondary: false,
        modeFilter: 'dual_split'
      })
      const botCmd = buildSendcmdCropScript({
        tracking,
        targetName: 'crop@bot',
        durationSec,
        fps: outFps,
        useSecondary: true,
        modeFilter: 'dual_split'
      })

      const singleCmdPath = `${outputMp4Path}.main.cmd.txt`
      const topCmdPath = `${outputMp4Path}.top.cmd.txt`
      const botCmdPath = `${outputMp4Path}.bot.cmd.txt`
      tempCmdFiles.push(singleCmdPath, topCmdPath, botCmdPath)
      await Promise.all([
        writeFile(singleCmdPath, singleCmd.script, 'utf8'),
        writeFile(topCmdPath, topCmd.script, 'utf8'),
        writeFile(botCmdPath, botCmd.script, 'utf8')
      ])

      const enableExpr = dualIntervals
        .map((iv) => `between(t,${iv.startSec.toFixed(4)},${iv.endSec.toFixed(4)})`)
        .join('+')

      filterComplex = [
        `[0:v]setpts=PTS-STARTPTS,fps=${outFps.toFixed(3)},split=3[vs][vt][vb]`,
        `[vs]sendcmd=f='${escapeFilterPath(singleCmdPath)}',crop@main=w=${singleCmd.cropW}:h=${singleCmd.cropH}:x=${singleCmd.initX}:y=${singleCmd.initY}:exact=1,scale=1080:1920:flags=lanczos,setsar=1[single_v]`,
        `[vt]sendcmd=f='${escapeFilterPath(topCmdPath)}',crop@top=w=${topCmd.cropW}:h=${topCmd.cropH}:x=${topCmd.initX}:y=${topCmd.initY}:exact=1,scale=1080:960:flags=lanczos,setsar=1[top_v]`,
        `[vb]sendcmd=f='${escapeFilterPath(botCmdPath)}',crop@bot=w=${botCmd.cropW}:h=${botCmd.cropH}:x=${botCmd.initX}:y=${botCmd.initY}:exact=1,scale=1080:960:flags=lanczos,setsar=1[bot_v]`,
        `[top_v][bot_v]vstack=inputs=2[dual_v]`,
        `[single_v][dual_v]overlay=0:0:enable='${enableExpr}':eof_action=pass,setsar=1,format=yuv420p${subtitleChain}[vout]`
      ].join(';')
    } else if (dualIntervals.length > 0 || tracking.compositionModeResolved === 'dual_split') {
      const topCmd = buildSendcmdCropScript({
        tracking,
        targetName: 'crop@top',
        durationSec,
        fps: outFps,
        useSecondary: false,
        modeFilter: 'dual_split'
      })
      const botCmd = buildSendcmdCropScript({
        tracking,
        targetName: 'crop@bot',
        durationSec,
        fps: outFps,
        useSecondary: true,
        modeFilter: 'dual_split'
      })

      const topCmdPath = `${outputMp4Path}.top.cmd.txt`
      const botCmdPath = `${outputMp4Path}.bot.cmd.txt`
      tempCmdFiles.push(topCmdPath, botCmdPath)
      await Promise.all([
        writeFile(topCmdPath, topCmd.script, 'utf8'),
        writeFile(botCmdPath, botCmd.script, 'utf8')
      ])

      filterComplex = [
        `[0:v]split=2[vt][vb]`,
        `[vt]sendcmd=f='${escapeFilterPath(topCmdPath)}',crop@top=w=${topCmd.cropW}:h=${topCmd.cropH}:x=${topCmd.initX}:y=${topCmd.initY}:exact=1,scale=1080:960:flags=lanczos,setsar=1[top]`,
        `[vb]sendcmd=f='${escapeFilterPath(botCmdPath)}',crop@bot=w=${botCmd.cropW}:h=${botCmd.cropH}:x=${botCmd.initX}:y=${botCmd.initY}:exact=1,scale=1080:960:flags=lanczos,setsar=1[bot]`,
        `[top][bot]vstack=inputs=2,fps=${outFps.toFixed(3)},format=yuv420p${subtitleChain}[vout]`
      ].join(';')
    } else {
      const singleCmd = buildSendcmdCropScript({
        tracking,
        targetName: 'crop@main',
        durationSec,
        fps: outFps,
        useSecondary: false,
        modeFilter: 'single'
      })
      const cmdPath = `${outputMp4Path}.cmd.txt`
      tempCmdFiles.push(cmdPath)
      await writeFile(cmdPath, singleCmd.script, 'utf8')

      filterComplex = `[0:v]sendcmd=f='${escapeFilterPath(cmdPath)}',crop@main=w=${singleCmd.cropW}:h=${singleCmd.cropH}:x=${singleCmd.initX}:y=${singleCmd.initY}:exact=1,scale=1080:1920:flags=lanczos,fps=${outFps.toFixed(3)},setsar=1,format=yuv420p${subtitleChain}[vout]`
    }

    const args: string[] = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-progress',
      'pipe:2',
      '-threads',
      String(profile.ffmpegThreads),
      '-ss',
      startTimeSec.toFixed(3),
      '-t',
      durationSec.toFixed(3),
      '-i',
      sourceVideoPath
    ]

    let nextInputIdx = 1
    let dubInputIdx: number | null = null
    if (hasDubbedAudio && dubbedAudioPath) {
      dubInputIdx = nextInputIdx++
      args.push('-t', durationSec.toFixed(3), '-i', dubbedAudioPath)
    }

    const hasMainAudio = hasDubbedAudio || hasSourceAudio
    let bgInputIdx: number | null = null
    if (hasBgAudio && backgroundAudioPath) {
      bgInputIdx = nextInputIdx++
      args.push('-stream_loop', '-1', '-t', durationSec.toFixed(3), '-i', backgroundAudioPath)
    }

    if (hasBgAudio && bgInputIdx !== null) {
      if (hasMainAudio) {
        const bgVol = clamp(backgroundAudioVolume, 0.02, 0.8)
        const mainFilter =
          dubInputIdx !== null
            ? `[${dubInputIdx}:a]aresample=48000,volume=1.0[main_a]`
            : `[0:a]aresample=async=1:first_pts=0,volume=1.0[main_a]`
        filterComplex += `;${mainFilter};[${bgInputIdx}:a]aresample=48000,volume=${bgVol.toFixed(2)}[bg_a];[main_a][bg_a]amix=inputs=2:duration=first:dropout_transition=2[aout]`
      } else {
        const bgVol = clamp(backgroundAudioVolume, 0.05, 1.0)
        filterComplex += `;[${bgInputIdx}:a]aresample=48000,volume=${bgVol.toFixed(2)}[aout]`
      }
    } else if (hasMainAudio) {
      if (dubInputIdx !== null) {
        filterComplex += `;[${dubInputIdx}:a]aresample=48000[aout]`
      } else {
        filterComplex += `;[0:a]aresample=async=1:first_pts=0[aout]`
      }
    }

    args.push(
      '-filter_complex',
      filterComplex,
      '-map',
      '[vout]'
    )

    if (hasMainAudio || hasBgAudio) {
      args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000')
    } else {
      args.push('-an')
    }

    args.push(
      '-c:v',
      'libx264',
      '-preset',
      qCfg.preset,
      '-crf',
      String(qCfg.crf),
      '-maxrate',
      qCfg.maxrate,
      '-bufsize',
      qCfg.bufsize,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-shortest',
      outputMp4Path
    )

    await runCancellableSpawn(ffmpeg, args, {
      signal,
      trackChild,
      onStderrLine: (line) => {
        if (line.startsWith('out_time_us=')) {
          const us = Number(line.split('=')[1])
          if (Number.isFinite(us) && durationSec > 0) {
            const pct = Math.min(99, Math.round((us / 1_000_000 / durationSec) * 100))
            onProgress?.(pct, `Encoding 9:16 MP4 (${pct}%)`)
          }
        }
      }
    })

    const fileStat = await stat(outputMp4Path)
    let thumbOut: string | null = null
    if (thumbnailJpgPath) {
      try {
        thumbOut = await extractClipThumbnail({
          videoPath: outputMp4Path,
          outJpgPath: thumbnailJpgPath,
          seekSec: Math.min(1.2, durationSec * 0.25),
          signal,
          trackChild
        })
      } catch {
        thumbOut = null
      }
    }

    onProgress?.(100, 'Rendered 9:16 Short')
    return {
      outputPath: outputMp4Path,
      sizeBytes: fileStat.size,
      thumbnailPath: thumbOut
    }
  } finally {
    await Promise.all(
      tempCmdFiles.map((f) => rm(f, { force: true }).catch(() => {}))
    )
  }
}

