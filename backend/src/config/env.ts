import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Resolves to ClipForge root whether running from src/config or dist/config
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
export const BACKEND_ROOT = path.resolve(__dirname, '..', '..')

// Load .env from repo root or backend directory
for (const candidate of [
  path.join(REPO_ROOT, '.env'),
  path.join(BACKEND_ROOT, '.env')
]) {
  if (existsSync(candidate)) {
    dotenv.config({ path: candidate })
  }
}

function resolveProjectPath(raw: string | undefined, fallbackRelative: string): string {
  if (raw && raw.trim().length > 0) {
    return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw)
  }
  return path.join(REPO_ROOT, fallbackRelative)
}

function parseIntEnv(key: string, fallback: number, min = 1): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= min ? n : fallback
}

function detectPythonBin(): string {
  if (process.env.PYTHON_BIN?.trim()) {
    return process.env.PYTHON_BIN.trim()
  }
  const venvPython = path.join(REPO_ROOT, 'cv', '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  return 'python3'
}

export const env = {
  port: parseIntEnv('PORT', 4000, 1),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  repoRoot: REPO_ROOT,
  dataDir: resolveProjectPath(process.env.DATA_DIR, 'data'),
  modelsDir: resolveProjectPath(process.env.MODELS_DIR, 'models'),
  cvDir: path.join(REPO_ROOT, 'cv'),
  frontendDistDir: path.join(REPO_ROOT, 'frontend', 'dist'),

  pythonBin: detectPythonBin(),
  ffmpegPath: process.env.FFMPEG_PATH?.trim() || '',
  ffprobePath: process.env.FFPROBE_PATH?.trim() || '',

  ai: {
    baseUrl: (process.env.AI_BASE_URL || 'https://antigravity-reversed.vercel.app/v1').replace(/\/+$/, ''),
    apiKey: process.env.AI_API_KEY?.trim() || '',
    model: process.env.AI_MODEL?.trim() || '',
    visionModel: process.env.AI_VISION_MODEL?.trim() || ''
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY?.trim() || '',
    ttsModel: process.env.GEMINI_TTS_MODEL?.trim() || 'gemini-3.8-flash-tts'
  },

  memory: {
    maxConcurrentJobs: parseIntEnv('MAX_CONCURRENT_JOBS', 1, 1),
    normalRamTargetMb: parseIntEnv('NORMAL_RAM_TARGET_MB', 900, 256),
    peakRamBudgetMb: parseIntEnv('PEAK_RAM_BUDGET_MB', 1500, 512),
    emergencyRamCeilingMb: parseIntEnv('EMERGENCY_RAM_CEILING_MB', 1700, 512)
  },

  processing: {
    ffmpegThreads: parseIntEnv('FFMPEG_THREADS', 2, 1),
    cvAnalysisWidth: parseIntEnv('CV_ANALYSIS_WIDTH', 640, 160),
    cvBaseFps: parseIntEnv('CV_BASE_FPS', 5, 1),
    cvBoostFps: parseIntEnv('CV_BOOST_FPS', 12, 2),
    whisperModel: process.env.WHISPER_MODEL?.trim() || 'base-q5_1',
    whisperThreads: parseIntEnv('WHISPER_THREADS', 2, 1)
  }
} as const
