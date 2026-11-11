import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { clipRepo, projectRepo } from '../db/database.ts'
import type { JobExecutionContext } from '../queue/jobQueue.ts'
import type {
  ClipRecord,
  DubbingConfig,
  DubbingPlan,
  RenderQuality,
  SubtitleConfig,
  TranscriptData,
  VideoMetadata,
  VisualAnalysisSummary
} from '../types/index.ts'
import { cleanupTempFilesInProject, ensureDir } from '../utils/fsSafe.ts'
import { log } from '../utils/logger.ts'
import { getAdaptiveProcessingProfile } from '../utils/memoryMonitor.ts'
import {
  analyzeSampledFramesWithAI,
  discoverViralMomentsWithAI,
  polishClipCaptionsWithAI
} from '../services/aiClient.ts'
import { selectAndRankClips } from '../services/clipSelector.ts'
import { downloadYouTubeVideo } from '../services/downloader.ts'
import { synthesizeDubbedClipAudio } from '../services/dubbingService.ts'
import { runClipFaceTracking } from '../services/faceTrackingService.ts'
import {
  extractAudioWav16k,
  extractSampledKeyframes,
  probeVideoMetadata
} from '../services/ffmpegService.ts'
import { renderVerticalShort } from '../services/renderService.ts'
import { analyzeAndPlanClipDubbing } from '../services/speakerAnalysisService.ts'
import { writeClipAssFile } from '../services/subtitleService.ts'
import {
  runTranscriptionStage,
  type AudioEnergyData
} from '../services/transcriptionService.ts'
import {
  getVoiceEntry,
  isEnglishSourceLanguage,
  pickVoiceForSpeaker
} from '../services/voiceCatalog.ts'

function resolveUpdatedSpeakerOverridesOnPlan(
  plan: DubbingPlan,
  overrides: DubbingConfig['speakerOverrides'],
  contentType?: string
): { plan: DubbingPlan; changed: boolean } {
  const overrideMap = new Map((overrides ?? []).map((o) => [o.speakerId, o]))
  let changed = false
  const usedVoices = new Set<string>()
  for (const sp of plan.speakers) {
    const ov = overrideMap.get(sp.speakerId)
    if (ov?.voiceName && getVoiceEntry(ov.voiceName)) {
      usedVoices.add(getVoiceEntry(ov.voiceName)!.name)
    } else if (!ov && sp.voiceName) {
      usedVoices.add(sp.voiceName)
    }
  }

  const nextSpeakers = plan.speakers.map((sp, idx) => {
    const ov = overrideMap.get(sp.speakerId)
    if (!ov) return sp
    let nextGender = sp.gender
    let nextVoice = sp.voiceName

    if (ov.gender && ov.gender !== sp.gender) {
      nextGender = ov.gender
      changed = true
      if (!ov.voiceName) {
        const picked = pickVoiceForSpeaker({
          gender: ov.gender,
          pitchHintHz: sp.pitchHz,
          contentType,
          styleHint: sp.styleHint,
          alreadyUsedVoices: usedVoices,
          speakerIndex: idx
        })
        nextVoice = picked.name
        usedVoices.add(picked.name)
      }
    }

    if (ov.voiceName) {
      const entry = getVoiceEntry(ov.voiceName)
      if (entry && entry.name !== nextVoice) {
        nextVoice = entry.name
        if (!ov.gender) {
          nextGender = entry.gender
        }
        changed = true
      }
    }

    return {
      ...sp,
      gender: nextGender,
      voiceName: nextVoice
    }
  })

  return {
    plan: changed ? { ...plan, speakers: nextSpeakers } : plan,
    changed
  }
}

export async function renderSingleClip(
  clip: ClipRecord,
  ctx: JobExecutionContext,
  options?: {
    overallBase?: number
    overallSpan?: number
    clipLabelPrefix?: string
    regenerateDub?: boolean
  }
): Promise<ClipRecord> {
  const overallBase = options?.overallBase ?? 72
  const overallSpan = options?.overallSpan ?? 27
  const prefix = options?.clipLabelPrefix ? `${options.clipLabelPrefix} · ` : ''

  const project = projectRepo.findById(clip.projectId)
  if (!project || !project.sourceVideoPath || !existsSync(project.sourceVideoPath)) {
    throw new Error('Source video file is unavailable for rendering')
  }
  const metadata: VideoMetadata =
    project.metadata ?? (await probeVideoMetadata(project.sourceVideoPath))

  const clipDir = path.join(project.workspaceDir, 'clips', clip.id)
  await ensureDir(clipDir)

  const trackingPath = path.join(clipDir, 'tracking.json')
  const subtitlePath = path.join(clipDir, 'subtitles.ass')
  const outputPath = path.join(clipDir, 'short_9x16.mp4')
  const thumbPath = path.join(clipDir, 'thumb.jpg')

  const dubEnabled = Boolean(clip.dubbingConfig?.enabled)
  const trackWeight = dubEnabled ? 0.28 : 0.34
  const dubWeight = dubEnabled ? 0.28 : 0
  const subStart = trackWeight + dubWeight
  const subSpan = 0.08
  const renderStart = subStart + subSpan
  const renderSpan = 1 - renderStart

  try {
    ctx.throwIfAborted()
    clipRepo.update(clip.id, { status: 'TRACKING_FACES', errorMessage: null })
    ctx.reportProgress(
      'TRACKING_FACES',
      0,
      overallBase,
      `${prefix}Tracking faces for "${clip.title}"...`,
      clip.id
    )

    const tracking = await runClipFaceTracking({
      clipId: clip.id,
      projectId: project.id,
      videoPath: project.sourceVideoPath,
      metadata,
      startTimeSec: clip.startTimeSec,
      endTimeSec: clip.endTimeSec,
      compositionMode: clip.compositionMode,
      outTrackingPath: trackingPath,
      energyJsonPath: project.audioEnergyPath,
      transcriptJsonPath: project.transcriptPath,
      signal: ctx.signal,
      trackChild: ctx.trackChildProcess,
      onProgress: (pct, detail) => {
        ctx.reportProgress(
          'TRACKING_FACES',
          pct,
          overallBase + (pct / 100) * (overallSpan * trackWeight),
          `${prefix}${detail}`,
          clip.id
        )
      }
    })

    let wordsForSubtitles = clip.words
    let fallbackSubText = clip.transcriptText
    let dubbedLanguage: string | null = null
    let dubbedAudioForRender: string | null = null
    let persistedDubPlan = clip.dubbingPlan ?? null
    let persistedDubAudioPath = clip.dubbedAudioPath ?? null

    if (dubEnabled && clip.dubbingConfig) {
      ctx.throwIfAborted()
      clipRepo.update(clip.id, {
        status: 'DUBBING',
        trackingPath
      })
      ctx.reportProgress(
        'DUBBING',
        0,
        overallBase + overallSpan * trackWeight,
        `${prefix}Preparing multi-speaker AI dubbing (${clip.dubbingConfig.targetLanguage})...`,
        clip.id
      )

      const cachedMatches =
        !options?.regenerateDub &&
        persistedDubPlan != null &&
        persistedDubPlan.targetLanguage === clip.dubbingConfig.targetLanguage &&
        Math.abs(persistedDubPlan.clipStartSec - clip.startTimeSec) < 0.05 &&
        Math.abs(persistedDubPlan.clipEndSec - clip.endTimeSec) < 0.05

      if (cachedMatches && persistedDubPlan) {
        const overrideCheck = resolveUpdatedSpeakerOverridesOnPlan(
          persistedDubPlan,
          clip.dubbingConfig.speakerOverrides,
          project.visualAnalysis?.contentType
        )
        const hasAudioFile = Boolean(
          persistedDubAudioPath && existsSync(persistedDubAudioPath)
        )

        if (!overrideCheck.changed && hasAudioFile) {
          ctx.reportProgress(
            'DUBBING',
            100,
            overallBase + overallSpan * (trackWeight + dubWeight),
            `${prefix}Reusing cached dubbed audio (${persistedDubPlan.targetLanguage})`,
            clip.id
          )
        } else {
          // Voices changed or audio missing: synthesize using updated speaker voice configs
          const synth = await synthesizeDubbedClipAudio({
            clipDir,
            plan: overrideCheck.plan,
            clipDurationSec: Math.max(0.5, clip.endTimeSec - clip.startTimeSec),
            projectId: project.id,
            signal: ctx.signal,
            trackChild: ctx.trackChildProcess,
            onProgress: (pct, detail) => {
              ctx.reportProgress(
                'DUBBING',
                pct,
                overallBase + overallSpan * (trackWeight + (pct / 100) * dubWeight),
                `${prefix}${detail}`,
                clip.id
              )
            }
          })
          persistedDubPlan = synth.plan
          persistedDubAudioPath = synth.dubbedAudioPath
        }
      } else {
        const plan = await analyzeAndPlanClipDubbing({
          project,
          clip,
          clipDir,
          tracking,
          dubbingConfig: clip.dubbingConfig,
          signal: ctx.signal,
          trackChild: ctx.trackChildProcess,
          onProgress: (pct, detail) => {
            ctx.reportProgress(
              'DUBBING',
              Math.round(pct * 0.4),
              overallBase + overallSpan * (trackWeight + ((pct * 0.4) / 100) * dubWeight),
              `${prefix}${detail}`,
              clip.id
            )
          }
        })

        const synth = await synthesizeDubbedClipAudio({
          clipDir,
          plan,
          clipDurationSec: Math.max(0.5, clip.endTimeSec - clip.startTimeSec),
          projectId: project.id,
          signal: ctx.signal,
          trackChild: ctx.trackChildProcess,
          onProgress: (pct, detail) => {
            const stagePct = Math.round(40 + pct * 0.6)
            ctx.reportProgress(
              'DUBBING',
              stagePct,
              overallBase + overallSpan * (trackWeight + (stagePct / 100) * dubWeight),
              `${prefix}${detail}`,
              clip.id
            )
          }
        })
        persistedDubPlan = synth.plan
        persistedDubAudioPath = synth.dubbedAudioPath
      }

      clipRepo.update(clip.id, {
        dubbingPlan: persistedDubPlan,
        dubbedAudioPath: persistedDubAudioPath
      })

      if (persistedDubPlan) {
        wordsForSubtitles = persistedDubPlan.dubbedWords
        fallbackSubText = persistedDubPlan.dubbedTranscriptText
        dubbedLanguage = persistedDubPlan.targetLanguage
      }
      dubbedAudioForRender = persistedDubAudioPath
    }

    ctx.throwIfAborted()
    clipRepo.update(clip.id, {
      status: 'GENERATING_SUBTITLES',
      trackingPath
    })
    ctx.reportProgress(
      'GENERATING_SUBTITLES',
      40,
      overallBase + overallSpan * (subStart + subSpan * 0.35),
      `${prefix}Generating animated ASS subtitles for "${clip.title}"...`,
      clip.id
    )

    await writeClipAssFile({
      outAssPath: subtitlePath,
      words: wordsForSubtitles,
      fallbackText: fallbackSubText,
      clipStartSec: clip.startTimeSec,
      clipEndSec: clip.endTimeSec,
      config: clip.subtitleConfig,
      tracking,
      dubbedLanguage
    })

    ctx.reportProgress(
      'GENERATING_SUBTITLES',
      100,
      overallBase + overallSpan * renderStart,
      `${prefix}Animated ASS subtitles ready for "${clip.title}"`,
      clip.id
    )

    ctx.throwIfAborted()
    clipRepo.update(clip.id, {
      status: 'RENDERING',
      subtitlePath
    })
    ctx.reportProgress(
      'RENDERING',
      0,
      overallBase + overallSpan * renderStart,
      `${prefix}Rendering 1080x1920 9:16 video for "${clip.title}"...`,
      clip.id
    )

    const rendered = await renderVerticalShort({
      sourceVideoPath: project.sourceVideoPath,
      metadata,
      startTimeSec: clip.startTimeSec,
      endTimeSec: clip.endTimeSec,
      tracking,
      assSubtitlePath: subtitlePath,
      outputMp4Path: outputPath,
      thumbnailJpgPath: thumbPath,
      quality: clip.renderQuality,
      targetFps: clip.targetFps,
      backgroundAudioPath: clip.backgroundAudioPath,
      backgroundAudioVolume: clip.backgroundAudioVolume ?? 0.15,
      dubbedAudioPath: dubbedAudioForRender,
      signal: ctx.signal,
      trackChild: ctx.trackChildProcess,
      onProgress: (pct, detail) => {
        ctx.reportProgress(
          'RENDERING',
          pct,
          overallBase + overallSpan * (renderStart + (pct / 100) * renderSpan),
          `${prefix}${detail}`,
          clip.id
        )
      }
    })

    const updated = clipRepo.update(clip.id, {
      status: 'COMPLETED',
      outputPath: rendered.outputPath,
      thumbnailPath: rendered.thumbnailPath,
      outputSizeBytes: rendered.sizeBytes,
      trackingPath,
      subtitlePath,
      errorMessage: null
    })

    return updated ?? clip
  } catch (err) {
    const isCancel = ctx.signal.aborted
    const msg = err instanceof Error ? err.message : String(err)
    clipRepo.update(clip.id, {
      status: isCancel ? 'CANCELLED' : 'FAILED',
      errorMessage: isCancel ? null : msg
    })
    throw err
  }
}

export async function runProjectPipeline(ctx: JobExecutionContext): Promise<void> {
  const project = projectRepo.findById(ctx.projectId)
  if (!project) throw new Error(`Project not found: ${ctx.projectId}`)

  const workspace = project.workspaceDir
  const sourceDir = path.join(workspace, 'source')
  const tempDir = path.join(workspace, 'temp')
  await Promise.all([ensureDir(sourceDir), ensureDir(tempDir)])

  try {
    // 1. DOWNLOADING (or using provided local source file)
    let sourceVideoPath = project.sourceVideoPath
    let downloadTitle = project.title
    let downloadAuthor = project.author

    if (project.localVideoPath && existsSync(project.localVideoPath)) {
      sourceVideoPath = project.localVideoPath
      ctx.reportProgress('DOWNLOADING', 100, 15, 'Using local source video')
    } else if (!sourceVideoPath || !existsSync(sourceVideoPath)) {
      ctx.throwIfAborted()
      ctx.reportProgress('DOWNLOADING', 0, 2, 'Downloading source video via Ytora...')
      const dlResult = await downloadYouTubeVideo({
        youtubeUrl: project.youtubeUrl,
        outDir: sourceDir,
        videoQuality: project.config.videoQualityPref,
        abortSignal: ctx.signal,
        projectId: project.id,
        onProgress: (ev) => {
          ctx.reportProgress('DOWNLOADING', ev.percent, 2 + ev.percent * 0.16, ev.detail)
        }
      })
      sourceVideoPath = dlResult.filePath
      downloadTitle = dlResult.title || project.title
      downloadAuthor = dlResult.author || project.author
      const fallbackThumb =
        project.thumbnailUrl ||
        (dlResult.videoId ? `https://i.ytimg.com/vi/${dlResult.videoId}/hqdefault.jpg` : null)
      projectRepo.update(project.id, {
        sourceVideoPath,
        title: downloadTitle,
        author: downloadAuthor,
        thumbnailUrl: fallbackThumb
      })
    }

    ctx.throwIfAborted()

    // 2. EXTRACTING (Metadata + 16kHz WAV Audio)
    ctx.reportProgress('EXTRACTING', 10, 20, 'Extracting video metadata with FFprobe...')
    const refreshedProject = projectRepo.findById(project.id) ?? project
    const metadata = await probeVideoMetadata(sourceVideoPath, {
      title: downloadTitle,
      author: downloadAuthor,
      thumbnailUrl: refreshedProject.thumbnailUrl
    })
    projectRepo.update(project.id, {
      sourceVideoPath,
      metadata,
      title: metadata.title || downloadTitle,
      author: metadata.author || downloadAuthor
    })

    const audioWavPath = path.join(tempDir, 'audio_16k.wav')
    ctx.reportProgress('EXTRACTING', 45, 25, 'Extracting 16 kHz mono WAV audio...')
    await extractAudioWav16k({
      videoPath: sourceVideoPath,
      outWavPath: audioWavPath,
      signal: ctx.signal,
      trackChild: ctx.trackChildProcess
    })
    projectRepo.update(project.id, { audioWavPath })
    ctx.reportProgress('EXTRACTING', 100, 29, 'Extracted video metadata & 16 kHz audio')

    ctx.throwIfAborted()

    // 3. TRANSCRIBING (whisper.cpp quantized)
    const transcriptPath = path.join(workspace, 'transcript.json')
    const audioEnergyPath = path.join(workspace, 'audio_energy.json')
    ctx.reportProgress('TRANSCRIBING', 0, 30, 'Transcribing speech with whisper.cpp...')

    const { transcript, energy } = await runTranscriptionStage({
      wavPath: audioWavPath,
      outTranscriptPath: transcriptPath,
      outEnergyPath: audioEnergyPath,
      modelName: project.config.whisperModel,
      signal: ctx.signal,
      trackChild: ctx.trackChildProcess,
      projectId: project.id,
      onProgress: (pct, detail) => {
        ctx.reportProgress('TRANSCRIBING', pct, 30 + pct * 0.22, detail)
      }
    })
    projectRepo.update(project.id, {
      transcriptPath,
      audioEnergyPath,
      sourceLanguage: transcript.language
    })

    // Remove temporary 16 kHz WAV promptly once transcription + RMS energy are persisted
    await rm(audioWavPath, { force: true }).catch(() => {})
    projectRepo.update(project.id, { audioWavPath: null })

    ctx.throwIfAborted()

    // 4. ANALYZING (Optional resized keyframe AI Vision + context preparation)
    ctx.reportProgress('ANALYZING', 10, 54, 'Analyzing content context...')
    let visualAnalysis: VisualAnalysisSummary | null = null
    const adaptive = getAdaptiveProcessingProfile()

    if (project.config.enableVisionAnalysis && adaptive.allowVisionAnalysis) {
      const framesDir = path.join(workspace, 'frames')
      const keyframes = await extractSampledKeyframes({
        videoPath: sourceVideoPath,
        durationSec: metadata.durationSec,
        tempFramesDir: framesDir,
        maxFrames: 6,
        maxWidth: 512,
        signal: ctx.signal,
        trackChild: ctx.trackChildProcess
      })
      if (keyframes.length > 0) {
        ctx.reportProgress('ANALYZING', 55, 58, `Running AI visual analysis on ${keyframes.length} resized frames...`)
        visualAnalysis = await analyzeSampledFramesWithAI({
          frames: keyframes,
          videoTitle: metadata.title,
          visionModelOverride: project.config.aiVisionModel,
          projectId: project.id
        })
      }
      await rm(framesDir, { recursive: true, force: true }).catch(() => {})
    }

    if (visualAnalysis) {
      projectRepo.update(project.id, { visualAnalysis })
      ctx.reportProgress('ANALYZING', 100, 60, `Visual context ready (${visualAnalysis.contentType})`)
    } else {
      ctx.reportProgress(
        'ANALYZING',
        100,
        60,
        project.config.enableVisionAnalysis
          ? 'Context analysis ready (transcript mode)'
          : 'Vision analysis disabled — using transcript context'
      )
    }

    ctx.throwIfAborted()

    // 5. SELECTING_CLIPS (Viral discovery + ranking + boundary snapping)
    ctx.reportProgress('SELECTING_CLIPS', 20, 62, 'Discovering and ranking standout clip candidates...')
    const aiCandidates = await discoverViralMomentsWithAI({
      segments: transcript.segments,
      videoTitle: metadata.title,
      durationSec: metadata.durationSec,
      minDurationSec: project.config.minClipDurationSec,
      maxDurationSec: project.config.maxClipDurationSec,
      targetClipCount: project.config.targetClipCount,
      weights: project.config.scoringWeights,
      visualSummary: visualAnalysis,
      modelOverride: project.config.aiModel,
      projectId: project.id
    })

    const selectedClips = selectAndRankClips({
      projectId: project.id,
      config: project.config,
      transcript,
      energy,
      videoDurationSec: metadata.durationSec,
      aiCandidates,
      visualSummary: visualAnalysis
    })

    if (project.config.dubbingConfig?.enabled && !isEnglishSourceLanguage(transcript.language)) {
      log(
        'warn',
        'Pipeline',
        `Detected language "${transcript.language}" is not English; skipping AI dubbing because English source videos are required.`,
        project.id
      )
      for (const c of selectedClips) {
        c.dubbingConfig = null
      }
    }

    // Polish multilingual/noisy captions right away so clip review & renders both get crisp captions
    for (let i = 0; i < selectedClips.length; i++) {
      ctx.throwIfAborted()
      const c = selectedClips[i]!
      const segsForClip = transcript.segments.filter((s) => {
        const overlap = Math.min(s.end, c.endTimeSec) - Math.max(s.start, c.startTimeSec)
        if (overlap <= 0) return false
        const segDur = Math.max(0.1, s.end - s.start)
        return overlap >= segDur * 0.5 || overlap >= 1.5
      })
      const polished = await polishClipCaptionsWithAI({
        segments: segsForClip,
        detectedLanguage: transcript.language,
        videoTitle: metadata.title,
        clipStartSec: c.startTimeSec,
        clipEndSec: c.endTimeSec,
        modelOverride: project.config.aiModel,
        projectId: project.id
      })
      if (polished) {
        c.words = polished.words
        c.transcriptText = polished.transcriptText
      }
    }

    clipRepo.replaceForProject(project.id, selectedClips)
    ctx.reportProgress(
      'SELECTING_CLIPS',
      100,
      70,
      `Selected ${selectedClips.length} ranked clip candidates`
    )

    // 6. Auto-render clips if enabled (processes clips sequentially one by one!)
    if (project.config.autoRenderTopClips && selectedClips.length > 0) {
      const spanPerClip = 29 / selectedClips.length
      for (let i = 0; i < selectedClips.length; i++) {
        ctx.throwIfAborted()
        const c = selectedClips[i]!
        log('info', 'Pipeline', `Rendering clip ${i + 1}/${selectedClips.length}: ${c.title}`, project.id)
        await renderSingleClip(c, ctx, {
          overallBase: 70 + i * spanPerClip,
          overallSpan: spanPerClip,
          clipLabelPrefix: `Clip ${i + 1}/${selectedClips.length}`
        })
      }
    }

    // 7. Cleanup temporary folders
    const reclaimed = await cleanupTempFilesInProject(workspace)
    log('info', 'Pipeline', `Pipeline completed. Reclaimed ${(reclaimed / (1024 * 1024)).toFixed(1)} MB temp storage.`, project.id)
    ctx.reportProgress('COMPLETED', 100, 100, `Ready (${selectedClips.length} clips)`)
  } finally {
    await cleanupTempFilesInProject(workspace).catch(() => {})
  }
}

export async function runClipReRender(params: {
  clipId: string
  patch?: {
    compositionMode?: ClipRecord['compositionMode']
    subtitleConfig?: Partial<SubtitleConfig>
    renderQuality?: RenderQuality
    targetFps?: number | null
    startTimeSec?: number
    endTimeSec?: number
    approved?: boolean
    backgroundAudioPath?: string | null
    backgroundAudioVolume?: number
    dubbingConfig?: DubbingConfig | null
    regenerateDub?: boolean
  }
  ctx: JobExecutionContext
}): Promise<void> {
  const existing = clipRepo.findById(params.clipId)
  if (!existing) throw new Error(`Clip not found: ${params.clipId}`)
  const project = projectRepo.findById(existing.projectId)
  if (!project) throw new Error(`Project not found: ${existing.projectId}`)

  const nextStart = params.patch?.startTimeSec ?? existing.startTimeSec
  const nextEnd = params.patch?.endTimeSec ?? existing.endTimeSec

  // Refresh words if boundaries changed and transcript exists
  let nextWords = existing.words
  let nextText = existing.transcriptText
  if (
    (params.patch?.startTimeSec !== undefined || params.patch?.endTimeSec !== undefined) &&
    project.transcriptPath &&
    existsSync(project.transcriptPath)
  ) {
    const tdata = JSON.parse(await readFile(project.transcriptPath, 'utf8')) as TranscriptData
    const segs = tdata.segments.filter((s) => {
      const overlap = Math.min(s.end, nextEnd) - Math.max(s.start, nextStart)
      if (overlap <= 0) return false
      const segDur = Math.max(0.1, s.end - s.start)
      return overlap >= segDur * 0.5 || overlap >= 1.5
    })
    const polished = await polishClipCaptionsWithAI({
      segments: segs,
      detectedLanguage: tdata.language,
      videoTitle: project.metadata?.title || project.title,
      clipStartSec: nextStart,
      clipEndSec: nextEnd,
      modelOverride: project.config.aiModel,
      projectId: project.id
    })
    if (polished) {
      nextText = polished.transcriptText
      nextWords = polished.words
    } else {
      nextText = segs.map((s) => s.text).join(' ').trim()
      nextWords = segs.flatMap((s) =>
        s.words.filter((w) => w.end > nextStart && w.start < nextEnd)
      )
    }
  }

  const updated = clipRepo.update(existing.id, {
    compositionMode: params.patch?.compositionMode ?? existing.compositionMode,
    subtitleConfig: params.patch?.subtitleConfig
      ? { ...existing.subtitleConfig, ...params.patch.subtitleConfig }
      : existing.subtitleConfig,
    renderQuality: params.patch?.renderQuality ?? existing.renderQuality,
    targetFps: params.patch?.targetFps !== undefined ? params.patch.targetFps : existing.targetFps,
    startTimeSec: nextStart,
    endTimeSec: nextEnd,
    durationSec: Math.round(Math.max(0.5, nextEnd - nextStart) * 100) / 100,
    approved: params.patch?.approved ?? existing.approved,
    backgroundAudioPath:
      params.patch?.backgroundAudioPath !== undefined
        ? params.patch.backgroundAudioPath
        : existing.backgroundAudioPath,
    backgroundAudioVolume:
      params.patch?.backgroundAudioVolume ?? existing.backgroundAudioVolume,
    dubbingConfig:
      params.patch?.dubbingConfig !== undefined
        ? params.patch.dubbingConfig
        : existing.dubbingConfig,
    words: nextWords,
    transcriptText: nextText
  })

  await renderSingleClip(updated ?? existing, params.ctx, {
    regenerateDub: params.patch?.regenerateDub
  })
  params.ctx.reportProgress('COMPLETED', 100, 100, `Clip "${existing.title}" rendered`)
}

export async function loadProjectAudioEnergy(projectId: string): Promise<AudioEnergyData | null> {
  const p = projectRepo.findById(projectId)
  if (!p?.audioEnergyPath || !existsSync(p.audioEnergyPath)) return null
  return JSON.parse(await readFile(p.audioEnergyPath, 'utf8')) as AudioEnergyData
}
