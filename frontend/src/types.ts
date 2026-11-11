export type JobState =
  | 'QUEUED'
  | 'DOWNLOADING'
  | 'EXTRACTING'
  | 'TRANSCRIBING'
  | 'ANALYZING'
  | 'SELECTING_CLIPS'
  | 'TRACKING_FACES'
  | 'DUBBING'
  | 'GENERATING_SUBTITLES'
  | 'RENDERING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export type CompositionMode = 'single' | 'dual' | 'smart'
export type SubtitlePresetName =
  | 'modern'
  | 'minimal'
  | 'bold'
  | 'podcast'
  | 'gaming'
  | 'educational'
export type RenderQuality = 'low' | 'medium' | 'high' | 'ultra'

export interface ScoringWeights {
  hookStrength: number
  storyCompleteness: number
  emotionalImpact: number
  informationValue: number
  audienceInterest: number
  endingPayoff: number
  visualQuality: number
}

export interface SubtitleConfig {
  preset: SubtitlePresetName
  fontName: string
  fontSize: number
  primaryColor: string
  highlightColor: string
  outlineColor: string
  outlineWidth: number
  shadowDepth: number
  position: 'auto' | 'bottom' | 'middle' | 'top'
  safeMarginBottomPx: number
  safeMarginTopPx: number
  highlightKeywords: boolean
  maxWordsPerLine: number
}

export interface MemorySnapshot {
  timestamp: string
  processRssMb: number
  processHeapUsedMb: number
  childTreeRssMb: number
  totalAppRssMb: number
  systemTotalMb: number
  systemAvailableMb: number
  effectiveBudgetMb: number
  pressure: 'NORMAL' | 'ELEVATED' | 'HIGH' | 'CRITICAL'
  peakObservedAppRssMb: number
}

export type SpeakerGender = 'male' | 'female' | 'unknown'

export interface DubSpeakerOverride {
  speakerId: string
  gender?: 'male' | 'female'
  voiceName?: string
}

export interface DubbingConfig {
  enabled: boolean
  targetLanguage: string
  speakerOverrides?: DubSpeakerOverride[]
}

export interface DubSpeakerProfile {
  speakerId: string
  label?: string
  gender: SpeakerGender
  voiceName: string
  pitchHz?: number | null
  confidence?: number
  linkedTrackId?: number | null
  styleHint?: string
}

export interface DubTurnSegment {
  startSec: number
  endSec: number
  speakerId: string
  originalText: string
  translatedText: string
  style?: string
  placedStartSec?: number
  placedEndSec?: number
}

export interface DubbingPlan {
  sourceLanguage: string
  targetLanguage: string
  clipStartSec: number
  clipEndSec: number
  speakers: DubSpeakerProfile[]
  turns: DubTurnSegment[]
  dubbedWords: Array<{ word: string; start: number; end: number; probability: number }>
  dubbedTranscriptText: string
  generatedAt: string
}

export interface GeminiVoiceOption {
  name: string
  gender: 'male' | 'female'
  description: string
  pitchLabel: string
  pitchBucket: string
}

export interface DubTargetLanguageOption {
  code: string
  name: string
  nativeName: string
}

export interface ProjectRecord {
  id: string
  youtubeUrl: string
  title: string
  author: string
  thumbnailUrl?: string | null
  sourceLanguage?: string | null
  status: JobState
  stageProgress: number
  overallProgress: number
  currentStageLabel: string
  errorMessage?: string | null
  clipCount?: number
  renderedCount?: number
  config: {
    minClipDurationSec: number
    maxClipDurationSec: number
    targetClipCount: number
    compositionMode: CompositionMode
    subtitleConfig: SubtitleConfig
    renderQuality: RenderQuality
    videoQualityPref: string
    enableVisionAnalysis: boolean
    autoRenderTopClips?: boolean
    scoringWeights: ScoringWeights
    dubbingConfig?: DubbingConfig | null
  }
  metadata?: {
    durationSec: number
    width: number
    height: number
    fps: number
    codec: string
  } | null
  visualAnalysis?: {
    contentType: string
    compositionRecommendation: CompositionMode
    importantVisualElements: string[]
    notes: string
    modelUsed: string
  } | null
  createdAt: string
  updatedAt: string
}

export interface ClipScoreBreakdown {
  hookStrength: number
  storyCompleteness: number
  emotionalImpact: number
  informationValue: number
  audienceInterest: number
  endingPayoff: number
  visualQuality: number
  weightedTotal: number
}

export interface ClipRecord {
  id: string
  projectId: string
  rank: number
  title: string
  description: string
  hook: string
  reason: string
  startTimeSec: number
  endTimeSec: number
  durationSec: number
  transcriptText: string
  words: Array<{ word: string; start: number; end: number; probability: number }>
  scoreBreakdown: ClipScoreBreakdown
  overallScore: number
  engagementPotential: 'high' | 'medium' | 'experimental'
  approved: boolean
  status: 'PENDING' | 'TRACKING_FACES' | 'DUBBING' | 'GENERATING_SUBTITLES' | 'RENDERING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  compositionMode: CompositionMode
  subtitleConfig: SubtitleConfig
  renderQuality: RenderQuality
  targetFps?: number | null
  backgroundAudioPath?: string | null
  backgroundAudioVolume?: number
  dubbingConfig?: DubbingConfig | null
  dubbingPlan?: DubbingPlan | null
  dubbedAudioPath?: string | null
  outputPath?: string | null
  thumbnailPath?: string | null
  trackingPath?: string | null
  outputSizeBytes?: number | null
  errorMessage?: string | null
  createdAt: string
  updatedAt: string
}

export interface TrackingFrameSample {
  timeSec: number
  sceneCut: boolean
  activeSpeakerId: number | null
  layoutMode: 'single' | 'dual_split'
  faces: Array<{
    trackId: number
    x: number
    y: number
    w: number
    h: number
    cx: number
    cy: number
    confidence: number
    mouthActivity: number
    speakerScore: number
    isActiveSpeaker: boolean
  }>
  cropPrimary: { x: number; y: number; w: number; h: number }
  cropSecondary?: { x: number; y: number; w: number; h: number } | null
}

export interface ClipTrackingResult {
  clipId: string
  sourceWidth: number
  sourceHeight: number
  sourceFps: number
  durationSec: number
  compositionModeRequested: CompositionMode
  compositionModeResolved: 'single' | 'dual_split' | 'dynamic'
  speakersDetected: number
  averageTrackingConfidence: number
  frames: TrackingFrameSample[]
}

export interface VideoPreviewInfo {
  videoId: string
  title: string
  author: string
  durationSec: number
  thumbnailUrl: string | null
  isStream: boolean
  formats: Array<{
    itag: number
    qualityLabel: string | null
    width: number | null
    height: number | null
    fps: number | null
    container: string
    codecs: string
    kind: string
  }>
}

export interface SystemStats {
  memory: MemorySnapshot
  queue: {
    active: { id: string; projectId: string; clipId?: string; kind: string } | null
    queuedCount: number
  }
  counts: {
    totalProjects: number
    completedProjects: number
    failedProjects: number
    totalClips: number
    renderedClips: number
    averageClipScore: number
  }
  storage: {
    dataDir: string
    totalBytes: number
  }
}

export interface CapabilitiesResponse {
  ai: {
    configured: boolean
    baseUrl: string
    reachable: boolean
    availableModels: string[]
    selectedModel: string | null
    selectedVisionModel: string | null
    supportsChatCompletions: boolean
    supportsStructuredOutputs: boolean
    supportsVision: boolean
    supportsTranscription: boolean
    error: string | null
  }
  localModels: {
    whisperModel: string
    whisperModelReady: boolean
    yunetReady: boolean
    faceLandmarkerReady: boolean
  }
  subtitlePresets: Record<SubtitlePresetName, SubtitleConfig>
  dubbing?: {
    configured: boolean
    model: string
    englishSourceOnly: boolean
    languages: DubTargetLanguageOption[]
    voices: {
      male: GeminiVoiceOption[]
      female: GeminiVoiceOption[]
    }
  }
}
