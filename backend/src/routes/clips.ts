import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Router } from 'express'
import { z } from 'zod'
import { env } from '../config/env.ts'
import { clipRepo, projectRepo } from '../db/database.ts'
import { runClipReRender } from '../pipeline/runProjectPipeline.ts'
import { jobQueue } from '../queue/jobQueue.ts'
import {
  getDubTargetLanguage,
  getVoiceEntry,
  isEnglishSourceLanguage
} from '../services/voiceCatalog.ts'
import { sanitizeId } from '../utils/fsSafe.ts'
import { resolveProjectSourceLanguage, streamVideoWithRange } from './projects.ts'

export const clipsRouter = Router()

const renderPatchSchema = z.object({
  compositionMode: z.enum(['single', 'dual', 'smart']).optional(),
  renderQuality: z.enum(['low', 'medium', 'high', 'ultra']).optional(),
  targetFps: z.number().int().min(15).max(60).nullable().optional(),
  startTimeSec: z.number().min(0).optional(),
  endTimeSec: z.number().min(0.5).optional(),
  approved: z.boolean().optional(),
  backgroundAudioPath: z.string().trim().nullable().optional(),
  backgroundAudioVolume: z.number().min(0).max(1).optional(),
  subtitleConfig: z
    .object({
      preset: z
        .enum(['modern', 'minimal', 'bold', 'podcast', 'gaming', 'educational'])
        .optional(),
      fontName: z.string().trim().min(1).max(80).optional(),
      fontSize: z.number().int().min(24).max(140).optional(),
      primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      highlightColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      outlineWidth: z.number().min(0).max(15).optional(),
      shadowDepth: z.number().min(0).max(10).optional(),
      position: z.enum(['auto', 'bottom', 'middle', 'top']).optional(),
      safeMarginBottomPx: z.number().int().min(80).max(700).optional(),
      safeMarginTopPx: z.number().int().min(80).max(600).optional(),
      highlightKeywords: z.boolean().optional(),
      maxWordsPerLine: z.number().int().min(1).max(8).optional()
    })
    .optional(),
  dubbingConfig: z
    .object({
      enabled: z.boolean(),
      targetLanguage: z.string().trim().min(2).max(12),
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
    .optional(),
  regenerateDub: z.boolean().optional()
})

function validateDubbingRequest(params: {
  clip: NonNullable<ReturnType<typeof clipRepo.findById>>
  dubbingConfig: z.infer<typeof renderPatchSchema>['dubbingConfig']
  regenerateDub?: boolean
  startTimeSec: number
  endTimeSec: number
  isRender: boolean
}): string | null {
  const { clip, dubbingConfig, regenerateDub, startTimeSec, endTimeSec, isRender } = params
  if (!dubbingConfig?.enabled) return null

  const lang = getDubTargetLanguage(dubbingConfig.targetLanguage)
  if (!lang) {
    return `Unsupported dubbing target language: ${dubbingConfig.targetLanguage}`
  }

  for (const ov of dubbingConfig.speakerOverrides ?? []) {
    if (ov.voiceName && !getVoiceEntry(ov.voiceName)) {
      return `Unsupported Gemini voice name: ${ov.voiceName}`
    }
  }

  const rawProject = projectRepo.findById(clip.projectId)
  const project = rawProject ? resolveProjectSourceLanguage(rawProject) : null
  if (project?.sourceLanguage && !isEnglishSourceLanguage(project.sourceLanguage)) {
    return `AI Dubbing currently supports English source videos only (detected: ${project.sourceLanguage}).`
  }

  if (isRender && !env.gemini.apiKey) {
    // Check if an identical cached dubbed_audio.wav already covers this request
    const planMatches =
      !regenerateDub &&
      clip.dubbingPlan != null &&
      clip.dubbingPlan.targetLanguage === lang.code &&
      Math.abs(clip.dubbingPlan.clipStartSec - startTimeSec) < 0.05 &&
      Math.abs(clip.dubbingPlan.clipEndSec - endTimeSec) < 0.05 &&
      Boolean(clip.dubbedAudioPath && existsSync(clip.dubbedAudioPath)) &&
      (dubbingConfig.speakerOverrides ?? []).every((ov) => {
        const sp = clip.dubbingPlan?.speakers.find((s) => s.speakerId === ov.speakerId)
        if (!sp) return true
        if (ov.gender && ov.gender !== sp.gender) return false
        if (ov.voiceName && ov.voiceName.toLowerCase() !== sp.voiceName.toLowerCase()) return false
        return true
      })

    if (!planMatches) {
      return 'GEMINI_API_KEY is not set in .env — required for Gemini 3.8 Flash TTS dubbing.'
    }
  }

  return null
}

clipsRouter.get('/:id', (req, res) => {
  const id = sanitizeId(req.params.id)
  const clip = clipRepo.findById(id)
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' })
    return
  }
  const rawProject = projectRepo.findById(clip.projectId)
  const project = rawProject ? resolveProjectSourceLanguage(rawProject) : null
  res.json({ clip, project })
})

clipsRouter.patch('/:id', (req, res) => {
  const id = sanitizeId(req.params.id)
  const existing = clipRepo.findById(id)
  if (!existing) {
    res.status(404).json({ error: 'Clip not found' })
    return
  }

  const parsed = renderPatchSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid clip update payload', details: parsed.error.flatten() })
    return
  }

  const p = parsed.data
  const start = p.startTimeSec ?? existing.startTimeSec
  const end = p.endTimeSec ?? existing.endTimeSec
  if (end <= start + 1) {
    res.status(400).json({ error: 'Clip endTimeSec must be at least 1s greater than startTimeSec' })
    return
  }

  if (p.dubbingConfig !== undefined) {
    const dubErr = validateDubbingRequest({
      clip: existing,
      dubbingConfig: p.dubbingConfig,
      startTimeSec: start,
      endTimeSec: end,
      isRender: false
    })
    if (dubErr) {
      res.status(400).json({ error: dubErr })
      return
    }
  }

  const updated = clipRepo.update(id, {
    compositionMode: p.compositionMode ?? existing.compositionMode,
    renderQuality: p.renderQuality ?? existing.renderQuality,
    targetFps: p.targetFps !== undefined ? p.targetFps : existing.targetFps,
    startTimeSec: start,
    endTimeSec: end,
    durationSec: Math.round((end - start) * 100) / 100,
    approved: p.approved ?? existing.approved,
    backgroundAudioPath:
      p.backgroundAudioPath !== undefined ? p.backgroundAudioPath : existing.backgroundAudioPath,
    backgroundAudioVolume: p.backgroundAudioVolume ?? existing.backgroundAudioVolume,
    dubbingConfig:
      p.dubbingConfig !== undefined
        ? p.dubbingConfig
          ? {
              ...p.dubbingConfig,
              targetLanguage: p.dubbingConfig.targetLanguage.trim().toLowerCase()
            }
          : null
        : existing.dubbingConfig,
    subtitleConfig: p.subtitleConfig
      ? { ...existing.subtitleConfig, ...p.subtitleConfig }
      : existing.subtitleConfig
  })

  res.json({ clip: updated })
})

clipsRouter.post('/:id/render', (req, res) => {
  const id = sanitizeId(req.params.id)
  const clip = clipRepo.findById(id)
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' })
    return
  }

  const parsed = renderPatchSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid render options', details: parsed.error.flatten() })
    return
  }

  const patch = parsed.data
  const start = patch.startTimeSec ?? clip.startTimeSec
  const end = patch.endTimeSec ?? clip.endTimeSec
  if (end <= start + 1) {
    res.status(400).json({ error: 'endTimeSec must exceed startTimeSec by at least 1s' })
    return
  }

  const effectiveDubCfg =
    patch.dubbingConfig !== undefined ? patch.dubbingConfig : clip.dubbingConfig
  const dubErr = validateDubbingRequest({
    clip,
    dubbingConfig: effectiveDubCfg,
    regenerateDub: patch.regenerateDub,
    startTimeSec: start,
    endTimeSec: end,
    isRender: true
  })
  if (dubErr) {
    res.status(400).json({ error: dubErr })
    return
  }

  const normalizedPatch = {
    ...patch,
    ...(patch.dubbingConfig !== undefined
      ? {
          dubbingConfig: patch.dubbingConfig
            ? {
                ...patch.dubbingConfig,
                targetLanguage: patch.dubbingConfig.targetLanguage.trim().toLowerCase()
              }
            : null
        }
      : {})
  }

  try {
    clipRepo.update(id, { status: 'PENDING', errorMessage: null })
    const { position } = jobQueue.enqueue({
      id: `render_${id}_${Date.now()}`,
      projectId: clip.projectId,
      clipId: id,
      kind: 'clip_render',
      run: (ctx) =>
        runClipReRender({
          clipId: id,
          patch: normalizedPatch,
          ctx
        })
    })
    res.status(202).json({
      clipId: id,
      projectId: clip.projectId,
      status: 'QUEUED',
      queuePosition: position
    })
  } catch (err) {
    res.status(409).json({
      error: err instanceof Error ? err.message : 'Unable to enqueue clip render'
    })
  }
})

clipsRouter.post('/:id/cancel', (req, res) => {
  const id = sanitizeId(req.params.id)
  const clip = clipRepo.findById(id)
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' })
    return
  }
  const cancelled = jobQueue.cancelByProjectOrClip(clip.projectId, id)
  if (!cancelled && ['TRACKING_FACES', 'DUBBING', 'GENERATING_SUBTITLES', 'RENDERING'].includes(clip.status)) {
    clipRepo.update(id, { status: 'CANCELLED' })
  }
  res.json({ clipId: id, cancelled: true })
})

clipsRouter.get('/:id/download', (req, res) => {
  const id = sanitizeId(req.params.id)
  const clip = clipRepo.findById(id)
  if (!clip || !clip.outputPath || !existsSync(clip.outputPath)) {
    res.status(404).json({ error: 'Rendered clip file not found' })
    return
  }
  const safeName =
    clip.title.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || clip.id
  res.download(clip.outputPath, `${safeName}_9x16.mp4`)
})

clipsRouter.get('/:id/video', (req, res) => {
  const id = sanitizeId(req.params.id)
  const clip = clipRepo.findById(id)
  if (!clip || !clip.outputPath) {
    res.status(404).json({ error: 'Rendered clip video not found' })
    return
  }
  streamVideoWithRange(req, res, clip.outputPath)
})

clipsRouter.get('/:id/thumbnail', (req, res) => {
  const id = sanitizeId(req.params.id)
  const clip = clipRepo.findById(id)
  if (!clip || !clip.thumbnailPath || !existsSync(clip.thumbnailPath)) {
    res.status(404).json({ error: 'Clip thumbnail not found' })
    return
  }
  res.sendFile(path.resolve(clip.thumbnailPath))
})

clipsRouter.get('/:id/tracking', async (req, res) => {
  const id = sanitizeId(req.params.id)
  const clip = clipRepo.findById(id)
  if (!clip || !clip.trackingPath || !existsSync(clip.trackingPath)) {
    res.status(404).json({ error: 'Face tracking trajectory not available yet' })
    return
  }
  const raw = await readFile(clip.trackingPath, 'utf8')
  res.type('application/json').send(raw)
})

