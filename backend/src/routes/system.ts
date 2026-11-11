import { existsSync } from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import { env } from '../config/env.ts'
import { clipRepo, projectRepo } from '../db/database.ts'
import { jobQueue } from '../queue/jobQueue.ts'
import { inspectAiCapabilities } from '../services/aiClient.ts'
import { SUBTITLE_PRESETS } from '../services/subtitleService.ts'
import {
  DUB_TARGET_LANGUAGES,
  FEMALE_VOICES,
  MALE_VOICES
} from '../services/voiceCatalog.ts'
import {
  cleanupTempFilesInProject,
  ensureDir,
  getDirectorySizeBytes
} from '../utils/fsSafe.ts'
import { getMemorySnapshot } from '../utils/memoryMonitor.ts'

export const systemRouter = Router()

const audioUploadDir = path.join(env.dataDir, 'uploads', 'audio')
const audioStorage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await ensureDir(audioUploadDir)
      cb(null, audioUploadDir)
    } catch (err) {
      cb(err as Error, audioUploadDir)
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp3'
    const safeExt = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(ext)
      ? ext
      : '.mp3'
    cb(null, `bgm_${Date.now()}_${Math.random().toString(16).slice(2, 8)}${safeExt}`)
  }
})

const uploadAudio = multer({
  storage: audioStorage,
  limits: { fileSize: 25 * 1024 * 1024 }
})

systemRouter.get('/stats', async (_req, res) => {
  const projects = projectRepo.listAll(200)
  const clips = clipRepo.listRecent(500)
  const storageBytes = await getDirectorySizeBytes(env.dataDir)

  const completedProjects = projects.filter((p) => p.status === 'COMPLETED').length
  const failedProjects = projects.filter((p) => p.status === 'FAILED').length
  const renderedClips = clips.filter((c) => c.status === 'COMPLETED')
  const avgScore =
    clips.length > 0
      ? Math.round(
          (clips.reduce((acc, c) => acc + c.overallScore, 0) / clips.length) * 10
        ) / 10
      : 0

  res.json({
    memory: getMemorySnapshot(),
    queue: jobQueue.getStatus(),
    counts: {
      totalProjects: projects.length,
      completedProjects,
      failedProjects,
      totalClips: clips.length,
      renderedClips: renderedClips.length,
      averageClipScore: avgScore
    },
    storage: {
      dataDir: env.dataDir,
      totalBytes: storageBytes
    }
  })
})

systemRouter.get('/capabilities', async (req, res) => {
  const forceRefresh = req.query.refresh === '1'
  const ai = await inspectAiCapabilities(forceRefresh)

  const whisperModelPath = path.join(
    env.modelsDir,
    `ggml-${env.processing.whisperModel}.bin`
  )
  const yunetPath = path.join(env.modelsDir, 'face_detection_yunet_2023mar.onnx')
  const landmarkerPath = path.join(env.modelsDir, 'face_landmarker.task')

  res.json({
    ai,
    localModels: {
      whisperModel: env.processing.whisperModel,
      whisperModelReady: existsSync(whisperModelPath),
      yunetReady: existsSync(yunetPath),
      faceLandmarkerReady: existsSync(landmarkerPath)
    },
    subtitlePresets: SUBTITLE_PRESETS,
    dubbing: {
      configured: Boolean(env.gemini.apiKey),
      model: env.gemini.ttsModel,
      englishSourceOnly: true,
      languages: DUB_TARGET_LANGUAGES.map(({ code, name, nativeName }) => ({
        code,
        name,
        nativeName
      })),
      voices: {
        male: MALE_VOICES,
        female: FEMALE_VOICES
      }
    }
  })
})

systemRouter.post('/cleanup', async (_req, res) => {
  const projects = projectRepo.listAll(200)
  let reclaimedBytes = 0
  for (const p of projects) {
    reclaimedBytes += await cleanupTempFilesInProject(p.workspaceDir)
  }
  res.json({ reclaimedBytes })
})

systemRouter.post('/audio/upload', uploadAudio.single('audio'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No audio file uploaded' })
    return
  }
  res.status(201).json({
    audioPath: req.file.path,
    originalName: req.file.originalname,
    sizeBytes: req.file.size
  })
})

