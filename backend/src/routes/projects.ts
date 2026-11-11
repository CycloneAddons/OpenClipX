import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { env } from '../config/env.ts'
import { clipRepo, projectRepo } from '../db/database.ts'
import { runProjectPipeline } from '../pipeline/runProjectPipeline.ts'
import { jobQueue } from '../queue/jobQueue.ts'
import { previewYouTubeVideo } from '../services/downloader.ts'
import { SUBTITLE_PRESETS } from '../services/subtitleService.ts'
import { getDubTargetLanguage } from '../services/voiceCatalog.ts'
import {
  DEFAULT_SCORING_WEIGHTS,
  type ProjectConfig,
  type ProjectRecord,
  type SubtitlePresetName
} from '../types/index.ts'
import {
  ensureDir,
  removeSafePath,
  resolveSafeDataPath,
  sanitizeId
} from '../utils/fsSafe.ts'
import { logEvents } from '../utils/logger.ts'
import { getMemorySnapshot } from '../utils/memoryMonitor.ts'

export const projectsRouter = Router()

const previewSchema = z.object({
  youtubeUrl: z.string().trim().min(3).max(500)
})

const createProjectSchema = z.object({
  youtubeUrl: z.string().trim().min(1).max(500),
  localVideoPath: z.string().trim().optional(),
  title: z.string().trim().max(200).optional(),
  author: z.string().trim().max(150).optional(),
  thumbnailUrl: z.string().trim().url().optional().nullable(),
  autoStart: z.boolean().optional().default(true),
  config: z
    .object({
      minClipDurationSec: z.number().min(5).max(180).default(20),
      maxClipDurationSec: z.number().min(10).max(180).default(60),
      targetClipCount: z.number().int().min(1).max(15).default(5),
      compositionMode: z.enum(['single', 'dual', 'smart']).default('smart'),
      subtitlePreset: z
        .enum(['modern', 'minimal', 'bold', 'podcast', 'gaming', 'educational'])
        .default('modern'),
      renderQuality: z.enum(['low', 'medium', 'high', 'ultra']).default('high'),
      videoQualityPref: z
        .enum(['1080p', '720p', '1440p', '2160p', 'best'])
        .default('1080p'),
      enableVisionAnalysis: z.boolean().default(true),
      aiModel: z.string().trim().optional(),
      aiVisionModel: z.string().trim().optional(),
      whisperModel: z.string().trim().optional(),
      autoRenderTopClips: z.boolean().default(true),
      backgroundAudioPath: z.string().trim().optional().nullable(),
      backgroundAudioVolume: z.number().min(0).max(1).optional().default(0.15),
      scoringWeights: z
        .object({
          hookStrength: z.number().min(0).max(1),
          storyCompleteness: z.number().min(0).max(1),
          emotionalImpact: z.number().min(0).max(1),
          informationValue: z.number().min(0).max(1),
          audienceInterest: z.number().min(0).max(1),
          endingPayoff: z.number().min(0).max(1),
          visualQuality: z.number().min(0).max(1)
        })
        .optional(),
      dubbingConfig: z
        .object({
          enabled: z.boolean().default(false),
          targetLanguage: z.string().trim().min(2).max(12).default('es'),
          speakerOverrides: z
            .array(
              z.object({
                speakerId: z.string().trim().min(1).max(40),
                gender: z.enum(['male', 'female']).optional(),
                voiceName: z.string().trim().min(1).max(60).optional()
              })
            )
            .optional()
        })
        .nullable()
        .optional()
    })
    .optional()
})

export function streamVideoWithRange(req: Request, res: Response, filePath: string): void {
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'Video file not found' })
    return
  }
  const st = statSync(filePath)
  const fileSize = st.size
  const ext = path.extname(filePath).toLowerCase()
  const contentType =
    ext === '.webm' ? 'video/webm' : ext === '.mkv' ? 'video/x-matroska' : 'video/mp4'
  const range = req.headers.range

  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/)
    if (!match) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end()
      return
    }
    const start = Number.parseInt(match[1]!, 10)
    const end = match[2] ? Math.min(fileSize - 1, Number.parseInt(match[2], 10)) : fileSize - 1
    if (start >= fileSize || end < start) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end()
      return
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType
    })
    createReadStream(filePath, { start, end }).pipe(res)
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType
    })
    createReadStream(filePath).pipe(res)
  }
}

projectsRouter.post('/preview', async (req, res) => {
  const parsed = previewSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid YouTube URL', details: parsed.error.flatten() })
    return
  }
  try {
    const preview = await previewYouTubeVideo(parsed.data.youtubeUrl)
    res.json(preview)
  } catch (err) {
    res.status(422).json({
      error: err instanceof Error ? err.message : 'Failed to resolve YouTube URL'
    })
  }
})

projectsRouter.get('/', (_req, res) => {
  const projects = projectRepo.listAll(50).map((p) => {
    const clips = clipRepo.findByProjectId(p.id)
    return {
      ...p,
      clipCount: clips.length,
      renderedCount: clips.filter((c) => c.status === 'COMPLETED').length
    }
  })
  res.json({ projects })
})

projectsRouter.post('/', async (req, res) => {
  const parsed = createProjectSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid project payload', details: parsed.error.flatten() })
    return
  }

  const input = parsed.data
  const rawCfg = input.config
  if (rawCfg?.dubbingConfig?.enabled && !getDubTargetLanguage(rawCfg.dubbingConfig.targetLanguage)) {
    res.status(400).json({
      error: `Unsupported dubbing target language: ${rawCfg.dubbingConfig.targetLanguage}`
    })
    return
  }

  const minDur = rawCfg?.minClipDurationSec ?? 20
  const maxDur = Math.max(minDur + 5, rawCfg?.maxClipDurationSec ?? 60)
  const presetKey: SubtitlePresetName = rawCfg?.subtitlePreset ?? 'modern'
  const preset = SUBTITLE_PRESETS[presetKey] ?? SUBTITLE_PRESETS.modern

  const projectConfig: ProjectConfig = {
    minClipDurationSec: minDur,
    maxClipDurationSec: maxDur,
    targetClipCount: rawCfg?.targetClipCount ?? 5,
    compositionMode: rawCfg?.compositionMode ?? 'smart',
    subtitleConfig: { ...preset },
    renderQuality: rawCfg?.renderQuality ?? 'high',
    videoQualityPref: rawCfg?.videoQualityPref ?? '1080p',
    enableVisionAnalysis: rawCfg?.enableVisionAnalysis ?? true,
    aiModel: rawCfg?.aiModel || env.ai.model || undefined,
    aiVisionModel: rawCfg?.aiVisionModel || env.ai.visionModel || undefined,
    whisperModel: rawCfg?.whisperModel || undefined,
    scoringWeights: rawCfg?.scoringWeights ?? { ...DEFAULT_SCORING_WEIGHTS },
    autoRenderTopClips: rawCfg?.autoRenderTopClips ?? true,
    backgroundAudioPath: rawCfg?.backgroundAudioPath ?? null,
    backgroundAudioVolume: rawCfg?.backgroundAudioVolume ?? 0.15,
    dubbingConfig: rawCfg?.dubbingConfig?.enabled
      ? {
          enabled: true,
          targetLanguage: rawCfg.dubbingConfig.targetLanguage.trim().toLowerCase(),
          speakerOverrides: rawCfg.dubbingConfig.speakerOverrides
        }
      : null
  }

  // Validate optional local video path only if explicitly inside dataDir or readable
  let localVideoPath: string | null = null
  if (input.localVideoPath) {
    const resolvedLocal = path.resolve(input.localVideoPath)
    if (!existsSync(resolvedLocal)) {
      res.status(400).json({ error: 'Provided local video file does not exist' })
      return
    }
    localVideoPath = resolvedLocal
  }

  const id = `proj_${randomUUID().slice(0, 12)}`
  const workspaceDir = resolveSafeDataPath('projects', id)
  await ensureDir(workspaceDir)

  const now = new Date().toISOString()
  const project: ProjectRecord = {
    id,
    youtubeUrl: input.youtubeUrl,
    localVideoPath,
    title: input.title || input.youtubeUrl,
    author: input.author || '',
    thumbnailUrl: input.thumbnailUrl ?? null,
    status: 'QUEUED',
    stageProgress: 0,
    overallProgress: 0,
    currentStageLabel: input.autoStart ? 'Queued for processing...' : 'Project created',
    errorMessage: null,
    config: projectConfig,
    metadata: null,
    visualAnalysis: null,
    workspaceDir,
    sourceVideoPath: localVideoPath,
    audioWavPath: null,
    transcriptPath: null,
    audioEnergyPath: null,
    createdAt: now,
    updatedAt: now
  }

  projectRepo.create(project)

  if (input.autoStart) {
    const { position } = jobQueue.enqueue({
      id: `job_${id}`,
      projectId: id,
      kind: 'project_pipeline',
      run: runProjectPipeline
    })
    res.status(201).json({ project, queuePosition: position })
    return
  }

  res.status(201).json({ project })
})

projectsRouter.post('/:id/analyze', (req, res) => {
  const id = sanitizeId(req.params.id)
  const project = projectRepo.findById(id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  try {
    projectRepo.update(id, {
      status: 'QUEUED',
      stageProgress: 0,
      overallProgress: 0,
      currentStageLabel: 'Queued for analysis...',
      errorMessage: null
    })
    const { position } = jobQueue.enqueue({
      id: `job_${id}_${Date.now()}`,
      projectId: id,
      kind: 'project_pipeline',
      run: runProjectPipeline
    })
    res.status(202).json({ projectId: id, status: 'QUEUED', queuePosition: position })
  } catch (err) {
    res.status(409).json({
      error: err instanceof Error ? err.message : 'Unable to enqueue analysis job'
    })
  }
})

projectsRouter.post('/:id/cancel', (req, res) => {
  const id = sanitizeId(req.params.id)
  const project = projectRepo.findById(id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  const cancelled = jobQueue.cancelByProjectOrClip(id)
  if (!cancelled && ['QUEUED', 'DOWNLOADING', 'EXTRACTING', 'TRANSCRIBING', 'ANALYZING', 'SELECTING_CLIPS', 'TRACKING_FACES', 'DUBBING', 'GENERATING_SUBTITLES', 'RENDERING'].includes(project.status)) {
    projectRepo.update(id, {
      status: 'CANCELLED',
      currentStageLabel: 'Cancelled'
    })
  }
  res.json({ projectId: id, cancelled: true })
})

export function resolveProjectSourceLanguage(project: ProjectRecord): ProjectRecord {
  if (project.sourceLanguage) return project
  if (project.transcriptPath && existsSync(project.transcriptPath)) {
    try {
      const parsed = JSON.parse(readFileSync(project.transcriptPath, 'utf8')) as {
        language?: string
      }
      if (parsed?.language) {
        return (
          projectRepo.update(project.id, { sourceLanguage: parsed.language }) ?? {
            ...project,
            sourceLanguage: parsed.language
          }
        )
      }
    } catch {
      // ignore parse failures
    }
  }
  return project
}

projectsRouter.get('/:id', (req, res) => {
  const id = sanitizeId(req.params.id)
  const rawProject = projectRepo.findById(id)
  if (!rawProject) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  const project = resolveProjectSourceLanguage(rawProject)
  const clips = clipRepo.findByProjectId(id)
  const logs = projectRepo.getLogs(id, 100)
  res.json({ project, clips, logs })
})

projectsRouter.get('/:id/status', (req, res) => {
  const id = sanitizeId(req.params.id)
  const project = projectRepo.findById(id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  const logs = projectRepo.getLogs(id, 100)
  res.json({
    projectId: project.id,
    status: project.status,
    stageProgress: project.stageProgress,
    overallProgress: project.overallProgress,
    currentStageLabel: project.currentStageLabel,
    errorMessage: project.errorMessage,
    memory: getMemorySnapshot(),
    queue: jobQueue.getStatus(),
    logs
  })
})

projectsRouter.get('/:id/events', (req, res) => {
  const id = sanitizeId(req.params.id)
  const project = projectRepo.findById(id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  // Send immediate snapshot
  sendEvent('progress', {
    projectId: project.id,
    state: project.status,
    stageProgress: project.stageProgress,
    overallProgress: project.overallProgress,
    message: project.currentStageLabel,
    memory: getMemorySnapshot(),
    timestamp: new Date().toISOString()
  })

  const onProgress = (ev: unknown) => sendEvent('progress', ev)
  const onLog = (entry: unknown) => sendEvent('log', entry)

  jobQueue.on(`progress:${id}`, onProgress)
  logEvents.on(`log:${id}`, onLog)

  const memTimer = setInterval(() => {
    sendEvent('memory', getMemorySnapshot())
  }, 1500)

  req.on('close', () => {
    clearInterval(memTimer)
    jobQueue.off(`progress:${id}`, onProgress)
    logEvents.off(`log:${id}`, onLog)
  })
})

projectsRouter.get('/:id/clips', (req, res) => {
  const id = sanitizeId(req.params.id)
  const project = projectRepo.findById(id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  res.json({ clips: clipRepo.findByProjectId(id) })
})

projectsRouter.get('/:id/source-video', (req, res) => {
  const id = sanitizeId(req.params.id)
  const project = projectRepo.findById(id)
  if (!project || !project.sourceVideoPath) {
    res.status(404).json({ error: 'Source video not found' })
    return
  }
  streamVideoWithRange(req, res, project.sourceVideoPath)
})

projectsRouter.delete('/:id', async (req, res) => {
  const id = sanitizeId(req.params.id)
  const project = projectRepo.findById(id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  jobQueue.cancelByProjectOrClip(id)
  // Give spawned process a short moment to unwind before deleting folder
  await new Promise((r) => setTimeout(r, 250))

  projectRepo.delete(id)
  await removeSafePath(project.workspaceDir)
  res.json({ deleted: true, projectId: id })
})

