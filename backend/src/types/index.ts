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

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  hookStrength: 0.2,
  storyCompleteness: 0.2,
  emotionalImpact: 0.15,
  informationValue: 0.15,
  audienceInterest: 0.15,
  endingPayoff: 0.1,
  visualQuality: 0.05
}

export interface SubtitleConfig {
  preset: SubtitlePresetName
  fontName: string
  fontSize: number
  primaryColor: string // #RRGGBB
  highlightColor: string // #RRGGBB
  outlineColor: string // #RRGGBB
  outlineWidth: number
  shadowDepth: number
  position: 'auto' | 'bottom' | 'middle' | 'top'
  safeMarginBottomPx: number
  safeMarginTopPx: number
  highlightKeywords: boolean
  maxWordsPerLine: number
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
  dubbedWords: TranscriptWord[]
  dubbedTranscriptText: string
  generatedAt: string
}

export interface ProjectConfig {
  minClipDurationSec: number
  maxClipDurationSec: number
  targetClipCount: number
  compositionMode: CompositionMode
  subtitleConfig: SubtitleConfig
  renderQuality: RenderQuality
  videoQualityPref: '1080p' | '720p' | '1440p' | '2160p' | 'best'
  enableVisionAnalysis: boolean
  aiModel?: string
  aiVisionModel?: string
  whisperModel?: string
  scoringWeights: ScoringWeights
  autoRenderTopClips: boolean
  backgroundAudioPath?: string | null
  backgroundAudioVolume?: number
  dubbingConfig?: DubbingConfig | null
}

export interface VideoMetadata {
  videoId?: string
  title: string
  author?: string
  durationSec: number
  width: number
  height: number
  fps: number
  rotationDeg: number
  codec: string
  audioCodec?: string
  bitrateBps?: number
  sizeBytes?: number
  thumbnailUrl?: string | null
}

export interface TranscriptWord {
  word: string
  start: number
  end: number
  probability: number
}

export interface TranscriptSegment {
  id: number
  start: number
  end: number
  text: string
  speakerTurn?: boolean
  probability?: number
  words: TranscriptWord[]
}

export interface TranscriptData {
  language: string
  durationSec: number
  model: string
  segments: TranscriptSegment[]
}

export interface FaceDetectionBox {
  trackId: number
  x: number // normalized 0..1 left
  y: number // normalized 0..1 top
  w: number // normalized 0..1 width
  h: number // normalized 0..1 height
  cx: number // normalized 0..1 center x
  cy: number // normalized 0..1 center y
  confidence: number
  mouthActivity: number
  speakerScore: number
  isActiveSpeaker: boolean
}

export interface TrackingFrameSample {
  timeSec: number
  sceneCut: boolean
  activeSpeakerId: number | null
  layoutMode: 'single' | 'dual_split'
  faces: FaceDetectionBox[]
  cropPrimary: {
    x: number // normalized 0..1 top-left x in source
    y: number // normalized 0..1 top-left y in source
    w: number // normalized 0..1 crop width in source
    h: number // normalized 0..1 crop height in source
  }
  cropSecondary?: {
    x: number
    y: number
    w: number
    h: number
  } | null
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

export interface VisualAnalysisSummary {
  contentType: string
  compositionRecommendation: CompositionMode
  importantVisualElements: string[]
  notes: string
  analyzedFramesCount: number
  modelUsed: string
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
  words: TranscriptWord[]
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
  subtitlePath?: string | null
  outputSizeBytes?: number | null
  errorMessage?: string | null
  createdAt: string
  updatedAt: string
}

export interface ProjectRecord {
  id: string
  youtubeUrl: string
  localVideoPath?: string | null
  title: string
  author: string
  thumbnailUrl?: string | null
  sourceLanguage?: string | null
  status: JobState
  stageProgress: number // 0..100
  overallProgress: number // 0..100
  currentStageLabel: string
  errorMessage?: string | null
  config: ProjectConfig
  metadata?: VideoMetadata | null
  visualAnalysis?: VisualAnalysisSummary | null
  workspaceDir: string
  sourceVideoPath?: string | null
  audioWavPath?: string | null
  transcriptPath?: string | null
  audioEnergyPath?: string | null
  createdAt: string
  updatedAt: string
}

export type MemoryPressureLevel = 'NORMAL' | 'ELEVATED' | 'HIGH' | 'CRITICAL'

export interface MemorySnapshot {
  timestamp: string
  processRssMb: number
  processHeapUsedMb: number
  childTreeRssMb: number
  totalAppRssMb: number
  systemTotalMb: number
  systemAvailableMb: number
  effectiveBudgetMb: number
  pressure: MemoryPressureLevel
  peakObservedAppRssMb: number
}

export interface PipelineProgressEvent {
  projectId: string
  clipId?: string
  state: JobState
  stageProgress: number
  overallProgress: number
  message: string
  memory?: MemorySnapshot
  timestamp: string
}

