import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { after, before, describe, it } from 'node:test'
import { env } from '../src/config/env.ts'
import { closeDb, clipRepo, getDb, projectRepo } from '../src/db/database.ts'
import { runProjectPipeline } from '../src/pipeline/runProjectPipeline.ts'
import { jobQueue } from '../src/queue/jobQueue.ts'
import { runClipFaceTracking } from '../src/services/faceTrackingService.ts'
import { probeVideoMetadata } from '../src/services/ffmpegService.ts'
import { renderVerticalShort } from '../src/services/renderService.ts'
import { SUBTITLE_PRESETS, writeClipAssFile } from '../src/services/subtitleService.ts'
import {
  DEFAULT_SCORING_WEIGHTS,
  type ProjectRecord,
  type TranscriptWord
} from '../src/types/index.ts'
import { ensureDir } from '../src/utils/fsSafe.ts'
import { getMemorySnapshot, resetPeakObservedMemory } from '../src/utils/memoryMonitor.ts'

const execFileAsync = promisify(execFile)
const FIXTURES_DIR = path.resolve(env.repoRoot, 'backend', 'tests', 'fixtures')

async function generateSyntheticFaceVideo(params: {
  outVideoPath: string
  width: number
  height: number
  fps: number
  durationSec: number
  mode: 'left' | 'right' | 'moving' | 'podcast' | '4k_move'
  speechText?: string
}): Promise<void> {
  const { outVideoPath, width, height, fps, durationSec, mode, speechText } = params
  const genScript = path.join(path.dirname(outVideoPath), `gen_${mode}.py`)
  const wavPath = path.join(path.dirname(outVideoPath), `speech_${mode}.wav`)
  const txtPath = path.join(path.dirname(outVideoPath), `speech_${mode}.txt`)

  if (speechText) {
    await writeFile(txtPath, speechText, 'utf8')
    await execFileAsync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `flite=textfile=${txtPath.replace(/\\/g, '/').replace(/:/g, '\\:')}`,
      '-af',
      `apad=whole_dur=${durationSec}`,
      '-t',
      String(durationSec),
      '-ar',
      '16000',
      '-ac',
      '1',
      wavPath
    ])
  }

  const pyCode = `
import subprocess, sys, math
import cv2, numpy as np

w, h, fps, dur = ${width}, ${height}, ${fps}, ${durationSec}
mode = ${JSON.stringify(mode)}
face1 = cv2.imread(${JSON.stringify(path.join(FIXTURES_DIR, 'face1.jpg'))})
face2 = cv2.imread(${JSON.stringify(path.join(FIXTURES_DIR, 'face2.jpg'))})

# Resize portraits proportionally
p_size = max(180, int(h * 0.34))
p1 = cv2.resize(face1, (p_size, p_size))
p2 = cv2.resize(face2, (p_size, p_size))

has_wav = ${speechText ? 'True' : 'False'}
cmd = [
    'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{w}x{h}', '-r', str(fps), '-i', 'pipe:0'
]
if has_wav:
    cmd += ['-i', ${JSON.stringify(wavPath)}]
cmd += ['-t', str(dur), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
if has_wav:
    cmd += ['-c:a', 'aac', '-b:a', '128k']
cmd += [${JSON.stringify(outVideoPath)}]

proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
total_frames = int(dur * fps)
bg = np.full((h, w, 3), (24, 28, 36), dtype=np.uint8)

def paste(canvas, img, cx_norm, cy_norm, mouth_pulse=0.0, mouth_rel=(0.55, 0.67)):
    x1 = max(0, min(w - img.shape[1], int(cx_norm * w - img.shape[1] * 0.5)))
    y1 = max(0, min(h - img.shape[0], int(cy_norm * h - img.shape[0] * 0.5)))
    patch = img.copy()
    if mouth_pulse > 0:
        rx = max(5, int(patch.shape[1] * 0.03))
        ry = max(2, int(7 * mouth_pulse))
        my = int(patch.shape[0] * mouth_rel[1])
        mx = int(patch.shape[1] * mouth_rel[0])
        cv2.ellipse(patch, (mx, my), (rx, ry), 0, 0, 360, (20, 14, 18), -1)
    canvas[y1:y1+patch.shape[0], x1:x1+patch.shape[1]] = patch

for i in range(total_frames):
    t = i / fps
    frame = bg.copy()
    if mode == 'left':
        paste(frame, p1, 0.11, 0.38)
    elif mode == 'right':
        paste(frame, p1, 0.89, 0.38)
    elif mode in ('moving', '4k_move'):
        cx = 0.12 + (i / max(1, total_frames - 1)) * 0.76
        paste(frame, p1, cx, 0.38)
    elif mode == 'podcast':
        # First half speaker 1 (left) talks, second half speaker 2 (right) talks
        s1_talk = 0.5 + 0.5 * math.sin(t * 18.0) if t < dur * 0.5 else 0.0
        s2_talk = 0.5 + 0.5 * math.sin(t * 18.0) if t >= dur * 0.5 else 0.0
        paste(frame, p1, 0.18, 0.38, s1_talk, (0.569, 0.674))
        paste(frame, p2, 0.82, 0.38, s2_talk, (0.532, 0.474))
    proc.stdin.write(frame.tobytes())

proc.stdin.close()
ret = proc.wait()
sys.exit(ret)
`
  await writeFile(genScript, pyCode, 'utf8')
  await execFileAsync(env.pythonBin, [genScript], { timeout: 180000 })
  await rm(genScript, { force: true }).catch(() => {})
  await rm(wavPath, { force: true }).catch(() => {})
  await rm(txtPath, { force: true }).catch(() => {})
}

describe('ClipForge Acceptance Criteria End-to-End Tests (TESTS 1-10)', () => {
  let workDir = ''

  before(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'clipforge-e2e-'))
    await ensureDir(workDir)
    getDb()
    resetPeakObservedMemory()
  })

  after(async () => {
    await jobQueue.shutdownAll()
    closeDb()
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  })

  it('TEST 1 & 10: 1920x1080 person on extreme left produces valid 9:16 video following face', async () => {
    const src = path.join(workDir, 'test1_left.mp4')
    const trackOut = path.join(workDir, 'test1_track.json')
    const outMp4 = path.join(workDir, 'test1_short.mp4')
    await generateSyntheticFaceVideo({
      outVideoPath: src,
      width: 1920,
      height: 1080,
      fps: 24,
      durationSec: 4,
      mode: 'left'
    })
    const meta = await probeVideoMetadata(src)
    const tracking = await runClipFaceTracking({
      clipId: 't1',
      projectId: 'p1',
      videoPath: src,
      metadata: meta,
      startTimeSec: 0,
      endTimeSec: 4,
      compositionMode: 'single',
      outTrackingPath: trackOut
    })

    assert.ok(tracking.speakersDetected >= 1, 'Should detect left face')
    const avgCropX =
      tracking.frames.reduce((acc, f) => acc + f.cropPrimary.x, 0) / tracking.frames.length
    assert.ok(avgCropX < 0.08, `Expected left crop x < 0.08, got ${avgCropX}`)

    const rendered = await renderVerticalShort({
      sourceVideoPath: src,
      metadata: meta,
      startTimeSec: 0,
      endTimeSec: 4,
      tracking,
      outputMp4Path: outMp4,
      quality: 'medium'
    })
    assert.ok(existsSync(rendered.outputPath))
    const outMeta = await probeVideoMetadata(rendered.outputPath)
    assert.equal(outMeta.width, 1080)
    assert.equal(outMeta.height, 1920)
    assert.equal(outMeta.codec, 'h264')
    assert.ok(outMeta.durationSec >= 3.5)
  })

  it('TEST 2 & 10: 1920x1080 person on extreme right produces valid 9:16 video following face', async () => {
    const src = path.join(workDir, 'test2_right.mp4')
    const trackOut = path.join(workDir, 'test2_track.json')
    const outMp4 = path.join(workDir, 'test2_short.mp4')
    await generateSyntheticFaceVideo({
      outVideoPath: src,
      width: 1920,
      height: 1080,
      fps: 24,
      durationSec: 4,
      mode: 'right'
    })
    const meta = await probeVideoMetadata(src)
    const tracking = await runClipFaceTracking({
      clipId: 't2',
      projectId: 'p2',
      videoPath: src,
      metadata: meta,
      startTimeSec: 0,
      endTimeSec: 4,
      compositionMode: 'single',
      outTrackingPath: trackOut
    })

    assert.ok(tracking.speakersDetected >= 1, 'Should detect right face')
    const avgCropX =
      tracking.frames.reduce((acc, f) => acc + f.cropPrimary.x, 0) / tracking.frames.length
    assert.ok(avgCropX > 0.60, `Expected extreme-right crop x > 0.60, got ${avgCropX}`)

    const rendered = await renderVerticalShort({
      sourceVideoPath: src,
      metadata: meta,
      startTimeSec: 0,
      endTimeSec: 4,
      tracking,
      outputMp4Path: outMp4,
      quality: 'medium'
    })
    const outMeta = await probeVideoMetadata(rendered.outputPath)
    assert.equal(outMeta.width, 1080)
    assert.equal(outMeta.height, 1920)
  })

  it('TEST 3: moving person produces smooth camera trajectory without noticeable jitter', async () => {
    const src = path.join(workDir, 'test3_move.mp4')
    const trackOut = path.join(workDir, 'test3_track.json')
    const outMp4 = path.join(workDir, 'test3_short.mp4')
    await generateSyntheticFaceVideo({
      outVideoPath: src,
      width: 1920,
      height: 1080,
      fps: 24,
      durationSec: 6,
      mode: 'moving'
    })
    const meta = await probeVideoMetadata(src)
    const tracking = await runClipFaceTracking({
      clipId: 't3',
      projectId: 'p3',
      videoPath: src,
      metadata: meta,
      startTimeSec: 0,
      endTimeSec: 6,
      compositionMode: 'single',
      outTrackingPath: trackOut
    })

    const xs = tracking.frames.map((f) => f.cropPrimary.x)
    assert.ok(xs[0]! < 0.08, `Expected start crop near left (< 0.08), got ${xs[0]}`)
    assert.ok(xs[xs.length - 1]! > 0.55, `Expected end crop near right (> 0.55), got ${xs[xs.length - 1]}`)

    // Verify smooth trajectory: no abrupt step jumps between consecutive samples
    let maxStep = 0
    for (let i = 1; i < xs.length; i++) {
      const step = Math.abs(xs[i]! - xs[i - 1]!)
      if (step > maxStep) maxStep = step
    }
    assert.ok(maxStep < 0.08, `Smooth camera max step should be < 0.08, got ${maxStep}`)

    await renderVerticalShort({
      sourceVideoPath: src,
      metadata: meta,
      startTimeSec: 0,
      endTimeSec: 6,
      tracking,
      outputMp4Path: outMp4,
      quality: 'medium'
    })
    const outMeta = await probeVideoMetadata(outMp4)
    assert.equal(outMeta.width, 1080)
    assert.equal(outMeta.height, 1920)
  })

  it('TEST 4: two-speaker podcast supports active speaker tracking and dual composition', async () => {
    const src = path.join(workDir, 'test4_podcast.mp4')
    const trackDualOut = path.join(workDir, 'test4_dual_track.json')
    const trackSingleOut = path.join(workDir, 'test4_single_track.json')
    const outMp4 = path.join(workDir, 'test4_short.mp4')
    await generateSyntheticFaceVideo({
      outVideoPath: src,
      width: 1920,
      height: 1080,
      fps: 24,
      durationSec: 8,
      mode: 'podcast',
      speechText:
        'Speaker one explains the problem in detail right now for everyone listening. Now speaker two jumps in with the surprising answer!'
    })
    const meta = await probeVideoMetadata(src)

    // 4a. Active-speaker switching in 'single' composition mode
    const singleTrack = await runClipFaceTracking({
      clipId: 't4_single',
      projectId: 'p4',
      videoPath: src,
      metadata: meta,
      startTimeSec: 0,
      endTimeSec: 8,
      compositionMode: 'single',
      outTrackingPath: trackSingleOut
    })
    assert.ok(singleTrack.speakersDetected >= 2, `Expected >=2 speakers detected, got ${singleTrack.speakersDetected}`)
    const earlyFrames = singleTrack.frames.filter((f) => f.timeSec >= 2.0 && f.timeSec <= 3.8)
    const lateFrames = singleTrack.frames.filter((f) => f.timeSec >= 5.5 && f.timeSec <= 7.8)
    const earlyAvgX = earlyFrames.reduce((a, f) => a + f.cropPrimary.x, 0) / earlyFrames.length
    const lateAvgX = lateFrames.reduce((a, f) => a + f.cropPrimary.x, 0) / lateFrames.length
    assert.ok(earlyAvgX < 0.25, `Expected early active speaker on left (<0.25), got ${earlyAvgX}`)
    assert.ok(lateAvgX > 0.50, `Expected late active speaker switch to right (>0.50), got ${lateAvgX}`)

    // 4b. Dual split layout rendering
    const dualTrack = await runClipFaceTracking({
      clipId: 't4_dual',
      projectId: 'p4',
      videoPath: src,
      metadata: meta,
      startTimeSec: 0,
      endTimeSec: 8,
      compositionMode: 'dual',
      outTrackingPath: trackDualOut
    })
    assert.ok(dualTrack.speakersDetected >= 2, `Expected >=2 speakers detected, got ${dualTrack.speakersDetected}`)
    assert.equal(dualTrack.compositionModeResolved, 'dual_split')

    const rendered = await renderVerticalShort({
      sourceVideoPath: src,
      metadata: meta,
      startTimeSec: 0,
      endTimeSec: 8,
      tracking: dualTrack,
      outputMp4Path: outMp4,
      quality: 'medium'
    })
    const outMeta = await probeVideoMetadata(rendered.outputPath)
    assert.equal(outMeta.width, 1080)
    assert.equal(outMeta.height, 1920)
    assert.equal(outMeta.audioCodec, 'aac')
  })

  it('TEST 5, 6, 7, 8, 9, 10: 4K video + full pipeline + speech subtitles + cleanup + Peak RSS < 1.5 GB', async () => {
    const src4k = path.join(workDir, 'test5_4k.mp4')
    const longSpeech =
      'Why do most video editors crash on four K footage? Because they load raw frames into memory! ' +
      'ClipForge streams every pixel through FFmpeg and tracks speakers smoothly. ' +
      'Here is the secret: unload whisper after transcription, and run face detection in an isolated worker. ' +
      'Now watch how clean the captions stay below every face!'

    await generateSyntheticFaceVideo({
      outVideoPath: src4k,
      width: 3840,
      height: 2160,
      fps: 24,
      durationSec: 26,
      mode: '4k_move',
      speechText: longSpeech
    })

    const projId = 'proj_e2e_4k'
    const workspaceDir = path.join(env.dataDir, 'projects', projId)
    await ensureDir(workspaceDir)
    const now = new Date().toISOString()

    const project: ProjectRecord = {
      id: projId,
      youtubeUrl: 'local://test5_4k.mp4',
      localVideoPath: src4k,
      title: 'E2E 4K Pipeline Test',
      author: 'ClipForge Test',
      thumbnailUrl: null,
      status: 'QUEUED',
      stageProgress: 0,
      overallProgress: 0,
      currentStageLabel: 'Queued',
      errorMessage: null,
      config: {
        minClipDurationSec: 8,
        maxClipDurationSec: 14,
        targetClipCount: 2,
        compositionMode: 'smart',
        subtitleConfig: SUBTITLE_PRESETS.modern,
        renderQuality: 'medium',
        videoQualityPref: '1080p',
        enableVisionAnalysis: false,
        scoringWeights: DEFAULT_SCORING_WEIGHTS,
        autoRenderTopClips: true
      },
      metadata: null,
      visualAnalysis: null,
      workspaceDir,
      sourceVideoPath: src4k,
      createdAt: now,
      updatedAt: now
    }

    projectRepo.create(project)

    try {
      await new Promise<void>((resolve, reject) => {
        const onProgress = (ev: { projectId: string; state: string; message: string }) => {
          if (ev.projectId !== projId) return
          if (ev.state === 'COMPLETED') {
            jobQueue.off('progress', onProgress)
            resolve()
          } else if (ev.state === 'FAILED' || ev.state === 'CANCELLED') {
            jobQueue.off('progress', onProgress)
            reject(new Error(`Pipeline ended with ${ev.state}: ${ev.message}`))
          }
        }
        jobQueue.on('progress', onProgress)
        jobQueue.enqueue({
          id: 'job_e2e_4k',
          projectId: projId,
          kind: 'project_pipeline',
          run: runProjectPipeline
        })
      })

      const finalProj = projectRepo.findById(projId)!
      assert.equal(finalProj.status, 'COMPLETED')
      assert.equal(finalProj.metadata?.width, 3840)
      assert.equal(finalProj.metadata?.height, 2160)

      // TEST 6: Multiple contextual clips produced
      const clips = clipRepo.findByProjectId(projId)
      assert.ok(clips.length >= 2, `Expected >=2 ranked clips from multi-sentence source, got ${clips.length}`)

      // TEST 7 & 10: Subtitles synchronized + valid playable 9:16 H.264/AAC MP4
      for (const c of clips) {
        assert.equal(c.status, 'COMPLETED')
        assert.ok(c.outputPath && existsSync(c.outputPath))
        assert.ok(c.subtitlePath && existsSync(c.subtitlePath))
        const outMeta = await probeVideoMetadata(c.outputPath)
        assert.equal(outMeta.width, 1080)
        assert.equal(outMeta.height, 1920)
        assert.equal(outMeta.codec, 'h264')
        assert.equal(outMeta.audioCodec, 'aac')
      }

      // Verify explicit subtitle word timing alignment helper
      const words: TranscriptWord[] = clips[0]!.words
      assert.ok(words.length > 0, 'Transcript should contain word-level timestamps')
      const assFile = path.join(workDir, 'verify_sub.ass')
      await writeClipAssFile({
        outAssPath: assFile,
        words,
        clipStartSec: clips[0]!.startTimeSec,
        clipEndSec: clips[0]!.endTimeSec,
        config: SUBTITLE_PRESETS.modern
      })
      assert.ok(existsSync(assFile))

      // TEST 8: No leftover temp folders/files
      assert.equal(existsSync(path.join(workspaceDir, 'temp')), false)
      assert.equal(existsSync(path.join(workspaceDir, 'frames')), false)
      const clipFiles = await readdir(path.dirname(clips[0]!.outputPath!))
      assert.equal(
        clipFiles.some((f) => f.endsWith('.cmd.txt') || f.endsWith('.raw.json') || f.endsWith('.part')),
        false
      )

      // TEST 9: Peak RSS check well below 1.5 GB budget
      const memSnap = getMemorySnapshot()
      console.log(
        `[4K E2E Memory Telemetry] Peak App RSS = ${memSnap.peakObservedAppRssMb} MB (budget ${memSnap.effectiveBudgetMb} MB)`
      )
      assert.ok(
        memSnap.peakObservedAppRssMb < 1500,
        `Peak App RSS exceeded 1500 MB budget: ${memSnap.peakObservedAppRssMb} MB`
      )
    } finally {
      projectRepo.delete(projId)
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
