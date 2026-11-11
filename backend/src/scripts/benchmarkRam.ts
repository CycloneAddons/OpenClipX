import dns from 'node:dns'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { env } from '../config/env.ts'
import { closeDb, clipRepo, getDb, projectRepo } from '../db/database.ts'
import { runProjectPipeline } from '../pipeline/runProjectPipeline.ts'
import { jobQueue } from '../queue/jobQueue.ts'
import { probeVideoMetadata } from '../services/ffmpegService.ts'
import { SUBTITLE_PRESETS } from '../services/subtitleService.ts'
import { DEFAULT_SCORING_WEIGHTS, type ProjectRecord } from '../types/index.ts'
import { ensureDir } from '../utils/fsSafe.ts'
import { getMemorySnapshot, resetPeakObservedMemory } from '../utils/memoryMonitor.ts'

dns.setDefaultResultOrder('ipv4first')
const execFileAsync = promisify(execFile)

async function create4kTestVideo(outPath: string, facePath: string, durationSec: number): Promise<void> {
  const wavPath = `${outPath}.wav`
  const txtPath = `${outPath}.txt`
  const scriptPath = `${outPath}.py`

  await writeFile(
    txtPath,
    'Benchmarking OpenClipX ultra lightweight four K streaming pipeline under one point five gigabytes of memory. Notice smooth tracking and clean captions.',
    'utf8'
  )

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

  const py = `
import subprocess, sys
import cv2, numpy as np
w, h, fps, dur = 3840, 2160, 24, ${durationSec}
face = cv2.resize(cv2.imread(${JSON.stringify(facePath)}), (700, 700))
cmd = [
  'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{w}x{h}', '-r', str(fps), '-i', 'pipe:0',
  '-i', ${JSON.stringify(wavPath)}, '-t', str(dur),
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  ${JSON.stringify(outPath)}
]
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
bg = np.full((h, w, 3), (20, 24, 30), dtype=np.uint8)
total = int(dur * fps)
for i in range(total):
  fr = bg.copy()
  cx = int((0.12 + (i / max(1, total - 1)) * 0.76) * w)
  x1 = max(0, min(w - 700, cx - 350))
  y1 = int(h * 0.22)
  fr[y1:y1+700, x1:x1+700] = face
  proc.stdin.write(fr.tobytes())
proc.stdin.close()
sys.exit(proc.wait())
`
  await writeFile(scriptPath, py, 'utf8')
  await execFileAsync(env.pythonBin, [scriptPath], { timeout: 60000 })
  await rm(scriptPath, { force: true }).catch(() => {})
  await rm(wavPath, { force: true }).catch(() => {})
  await rm(txtPath, { force: true }).catch(() => {})
}

async function main() {
  getDb()
  resetPeakObservedMemory()

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'clipforge-bench-'))
  const src4k = path.join(tmpDir, 'bench_4k.mp4')
  const faceFixture = path.join(env.repoRoot, 'backend', 'tests', 'fixtures', 'face1.jpg')

  let peakAppRssMb = 0
  let peakNodeRssMb = 0
  let peakChildTreeRssMb = 0
  let sampler: NodeJS.Timeout | undefined

  const projId = `bench_${Date.now()}`
  const workspaceDir = path.join(env.dataDir, 'projects', projId)

  try {
    console.log('Generating 4K (3840x2160) benchmark source video...')
    await create4kTestVideo(src4k, faceFixture, 14)

    resetPeakObservedMemory()
    sampler = setInterval(() => {
      const snap = getMemorySnapshot()
      if (snap.totalAppRssMb > peakAppRssMb) peakAppRssMb = snap.totalAppRssMb
      if (snap.processRssMb > peakNodeRssMb) peakNodeRssMb = snap.processRssMb
      if (snap.childTreeRssMb > peakChildTreeRssMb) peakChildTreeRssMb = snap.childTreeRssMb
    }, 200)

    await ensureDir(workspaceDir)
    const now = new Date().toISOString()
    const project: ProjectRecord = {
      id: projId,
      youtubeUrl: 'local://bench_4k.mp4',
      localVideoPath: src4k,
      title: 'Ultra-Lightweight (<1.5 GB RAM) 4K Benchmark',
      author: 'Benchmark',
      thumbnailUrl: null,
      status: 'QUEUED',
      stageProgress: 0,
      overallProgress: 0,
      currentStageLabel: 'Queued',
      errorMessage: null,
      config: {
        minClipDurationSec: 8,
        maxClipDurationSec: 14,
        targetClipCount: 1,
        compositionMode: 'smart',
        subtitleConfig: SUBTITLE_PRESETS.modern,
        renderQuality: 'medium',
        videoQualityPref: '2160p',
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

    const t0 = Date.now()
    await new Promise<void>((resolve, reject) => {
      const onProgress = (ev: { projectId: string; state: string; message: string }) => {
        if (ev.projectId !== projId) return
        console.log(`  [${ev.state}] ${ev.message}`)
        if (ev.state === 'COMPLETED') {
          jobQueue.off('progress', onProgress)
          resolve()
        } else if (ev.state === 'FAILED' || ev.state === 'CANCELLED') {
          jobQueue.off('progress', onProgress)
          reject(new Error(ev.message))
        }
      }
      jobQueue.on('progress', onProgress)
      jobQueue.enqueue({
        id: `job_${projId}`,
        projectId: projId,
        kind: 'project_pipeline',
        run: runProjectPipeline
      })
    })
    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(2)

    const clips = clipRepo.findByProjectId(projId)
    const firstClip = clips[0]
    if (!firstClip?.outputPath || !existsSync(firstClip.outputPath)) {
      throw new Error('Benchmark clip output missing')
    }
    const outMeta = await probeVideoMetadata(firstClip.outputPath)
    const snap = getMemorySnapshot()

    console.log('\n=== OPENCLIPX RAM BENCHMARK REPORT ===')
    console.log(`Duration:          ${elapsedSec} s`)
    console.log(`Peak Node RSS:     ${peakNodeRssMb.toFixed(1)} MB`)
    console.log(`Peak Child RSS:    ${peakChildTreeRssMb.toFixed(1)} MB`)
    console.log(`Peak Total App:    ${Math.max(peakAppRssMb, snap.peakObservedAppRssMb).toFixed(1)} MB`)
    console.log(`Output Video:      ${outMeta.width}x${outMeta.height} ${outMeta.codec}/${outMeta.audioCodec}`)
  } finally {
    if (sampler) clearInterval(sampler)
    projectRepo.delete(projId)
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => {})
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    await jobQueue.shutdownAll()
    closeDb()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
