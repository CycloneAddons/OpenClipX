import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import { env } from '../config/env.ts'
import type {
  ClipRecord,
  ClipTrackingResult,
  DubbingConfig,
  DubbingPlan,
  DubSpeakerProfile,
  DubTurnSegment,
  ProjectRecord,
  SpeakerGender,
  TranscriptData,
  TranscriptSegment,
  TranscriptWord
} from '../types/index.ts'
import { ensureDir } from '../utils/fsSafe.ts'
import { log } from '../utils/logger.ts'
import { getAdaptiveProcessingProfile } from '../utils/memoryMonitor.ts'
import {
  diarizeAndTranslateClipWithAI,
  inspectSpeakerGendersWithVision,
  type AiDiarizedSpeaker,
  type AiDiarizedTurn,
  type DiarizationTurnInput,
  type VisualSpeakerGenderResult
} from './aiClient.ts'
import { resolveFfmpegBin, runCancellableSpawn } from './ffmpegService.ts'
import {
  getDubTargetLanguage,
  getVoiceEntry,
  isEnglishSourceLanguage,
  pickVoiceForSpeaker
} from './voiceCatalog.ts'

export interface PitchSegmentAnalysis {
  idx: number
  startSec: number
  endSec: number
  medianF0Hz: number | null
  p25F0Hz: number | null
  p75F0Hz: number | null
  voicedFrames: number
  totalFrames: number
  voicedRatio: number
  acousticGender: SpeakerGender
  confidence: number
}

interface RawMicroTurn {
  idx: number
  startSec: number // relative to clip start
  endSec: number // relative to clip start
  text: string
  explicitBreakBefore?: boolean
}

function medianNumber(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]!
  return (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Splits a TranscriptSegment at internal pauses >= 0.48s when both sides have >= 2 words,
 * so back-and-forth speaker turns inside one Whisper segment are cleanly separated.
 */
function splitSegmentByInternalPauses(
  seg: TranscriptSegment,
  clipStartSec: number,
  clipEndSec: number
): Array<{ startSec: number; endSec: number; text: string; breakBefore: boolean }> {
  const words = (seg.words || []).filter(
    (w) => w.end > clipStartSec + 0.05 && w.start < clipEndSec - 0.05 && w.word.trim().length > 0
  )

  if (words.length < 4) {
    const startSec = Math.max(0, seg.start - clipStartSec)
    const endSec = Math.min(clipEndSec - clipStartSec, seg.end - clipStartSec)
    const text =
      words.length > 0 ? words.map((w) => w.word.trim()).join(' ') : seg.text.trim()
    if (!text || endSec <= startSec + 0.12) return []
    return [{ startSec, endSec, text, breakBefore: Boolean(seg.speakerTurn) }]
  }

  const groups: TranscriptWord[][] = []
  let current: TranscriptWord[] = [words[0]!]
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]!
    const cur = words[i]!
    const gap = cur.start - prev.end
    const sentenceEnd = /[.!?]$/.test(prev.word.trim())
    if (
      (gap >= 0.48 || (sentenceEnd && gap >= 0.3)) &&
      current.length >= 2 &&
      words.length - i >= 2
    ) {
      groups.push(current)
      current = [cur]
    } else {
      current.push(cur)
    }
  }
  if (current.length > 0) groups.push(current)

  return groups
    .map((g, idx) => {
      const startSec = Math.max(0, g[0]!.start - clipStartSec)
      const endSec = Math.min(clipEndSec - clipStartSec, g[g.length - 1]!.end - clipStartSec)
      const text = g.map((w) => w.word.trim()).join(' ').trim()
      return {
        startSec,
        endSec,
        text,
        breakBefore: idx === 0 ? Boolean(seg.speakerTurn) : true
      }
    })
    .filter((item) => item.text.length > 0 && item.endSec > item.startSec + 0.12)
}

export function extractClipMicroTurns(params: {
  clip: ClipRecord
  transcript: TranscriptData | null
}): RawMicroTurn[] {
  const { clip, transcript } = params
  const clipStart = clip.startTimeSec
  const clipEnd = clip.endTimeSec
  const clipDur = Math.max(0.5, clipEnd - clipStart)

  const out: RawMicroTurn[] = []

  if (transcript && transcript.segments.length > 0) {
    const overlapping = transcript.segments.filter(
      (s) => s.end > clipStart + 0.15 && s.start < clipEnd - 0.15
    )
    for (const seg of overlapping) {
      const pieces = splitSegmentByInternalPauses(seg, clipStart, clipEnd)
      for (const piece of pieces) {
        out.push({
          idx: out.length,
          startSec: Math.round(piece.startSec * 1000) / 1000,
          endSec: Math.round(piece.endSec * 1000) / 1000,
          text: piece.text,
          explicitBreakBefore: piece.breakBefore
        })
      }
    }
  }

  // Fallback to clip.words or clip.transcriptText when transcript.json wasn't matched
  if (out.length === 0 && clip.words.length > 0) {
    let curWords: TranscriptWord[] = []
    for (let i = 0; i < clip.words.length; i++) {
      const w = clip.words[i]!
      if (w.end <= clipStart + 0.05 || w.start >= clipEnd - 0.05) continue
      const prev = curWords[curWords.length - 1]
      const gap = prev ? w.start - prev.end : 0
      const sentenceEnd = prev ? /[.!?]$/.test(prev.word.trim()) : false
      if (
        curWords.length > 0 &&
        (gap >= 0.45 || sentenceEnd || curWords.length >= 22)
      ) {
        out.push({
          idx: out.length,
          startSec: Math.max(0, Math.round((curWords[0]!.start - clipStart) * 1000) / 1000),
          endSec: Math.min(clipDur, Math.round((curWords[curWords.length - 1]!.end - clipStart) * 1000) / 1000),
          text: curWords.map((cw) => cw.word.trim()).join(' ').trim(),
          explicitBreakBefore: gap >= 0.45
        })
        curWords = []
      }
      curWords.push(w)
    }
    if (curWords.length > 0) {
      out.push({
        idx: out.length,
        startSec: Math.max(0, Math.round((curWords[0]!.start - clipStart) * 1000) / 1000),
        endSec: Math.min(clipDur, Math.round((curWords[curWords.length - 1]!.end - clipStart) * 1000) / 1000),
        text: curWords.map((cw) => cw.word.trim()).join(' ').trim()
      })
    }
  }

  if (out.length === 0 && clip.transcriptText.trim()) {
    const sentences = clip.transcriptText
      .trim()
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const chunks = sentences.length > 0 ? sentences : [clip.transcriptText.trim()]
    const totalChars = chunks.reduce((sum, s) => sum + Math.max(4, s.length), 0)
    let cursor = 0
    for (const chunk of chunks) {
      const dur = (Math.max(4, chunk.length) / totalChars) * clipDur
      out.push({
        idx: out.length,
        startSec: Math.round(cursor * 1000) / 1000,
        endSec: Math.round(Math.min(clipDur, cursor + dur) * 1000) / 1000,
        text: chunk
      })
      cursor += dur
    }
  }

  return out.filter((t) => t.text.length > 0 && t.endSec > t.startSec + 0.1)
}

function findDominantTrackForTurn(
  turn: RawMicroTurn,
  tracking: ClipTrackingResult | null
): number | null {
  if (!tracking || tracking.frames.length === 0) return null
  const overlapFrames = tracking.frames.filter(
    (f) => f.timeSec >= turn.startSec - 0.15 && f.timeSec <= turn.endSec + 0.15
  )
  const samples = overlapFrames.length > 0 ? overlapFrames : []
  if (samples.length === 0) return null

  const scores = new Map<number, number>()
  for (const fr of samples) {
    if (fr.activeSpeakerId != null) {
      scores.set(fr.activeSpeakerId, (scores.get(fr.activeSpeakerId) ?? 0) + 1.5)
    }
    for (const face of fr.faces) {
      const w = face.isActiveSpeaker ? 1.2 : Math.max(0.15, face.speakerScore)
      scores.set(face.trackId, (scores.get(face.trackId) ?? 0) + w)
    }
  }
  let bestId: number | null = null
  let bestScore = -1
  for (const [tid, sc] of scores.entries()) {
    if (sc > bestScore) {
      bestScore = sc
      bestId = tid
    }
  }
  return bestId
}

async function runPitchWorker(params: {
  clipSliceWavPath: string
  turns: RawMicroTurn[]
  tempDir: string
  signal?: AbortSignal
  trackChild?: (child: ChildProcess) => () => void
}): Promise<Map<number, PitchSegmentAnalysis>> {
  const result = new Map<number, PitchSegmentAnalysis>()
  if (params.turns.length === 0 || !existsSync(params.clipSliceWavPath)) return result

  const segJsonPath = path.join(params.tempDir, `pitch_segs_${Date.now()}.json`)
  const scriptPath = path.join(env.cvDir, 'analyze_voice_pitch.py')
  try {
    await writeFile(
      segJsonPath,
      JSON.stringify(
        params.turns.map((t) => ({
          idx: t.idx,
          startSec: t.startSec,
          endSec: t.endSec
        }))
      ),
      'utf8'
    )

    const { stdout } = await runCancellableSpawn(
      env.pythonBin,
      [scriptPath, '--wav', params.clipSliceWavPath, '--segments-json', segJsonPath],
      {
        signal: params.signal,
        trackChild: params.trackChild
      }
    )

    const parsed = JSON.parse(stdout) as { segments?: PitchSegmentAnalysis[] }
    if (Array.isArray(parsed.segments)) {
      for (const s of parsed.segments) {
        result.set(s.idx, s)
      }
    }
  } finally {
    await rm(segJsonPath, { force: true }).catch(() => {})
  }
  return result
}

async function extractTrackFaceCrops(params: {
  sourceVideoPath: string
  clipStartSec: number
  tracking: ClipTrackingResult
  metadataWidth: number
  metadataHeight: number
  tempDir: string
  signal?: AbortSignal
  trackChild?: (child: ChildProcess) => () => void
}): Promise<Array<{ trackId: number; base64Jpeg: string }>> {
  const ffmpeg = await resolveFfmpegBin()
  const profile = getAdaptiveProcessingProfile()
  if (!profile.allowVisionAnalysis) return []

  // Pick up to 3 most prominent active/confident face tracks
  const bestFramePerTrack = new Map<
    number,
    {
      score: number
      timeSec: number
      x: number
      y: number
      w: number
      h: number
    }
  >()

  for (const fr of params.tracking.frames) {
    for (const face of fr.faces) {
      if (face.confidence < 0.65 || face.w < 0.03) continue
      const candidateScore =
        face.confidence + (face.isActiveSpeaker ? 1.5 : 0) + face.w * 2.0
      const prev = bestFramePerTrack.get(face.trackId)
      if (!prev || candidateScore > prev.score) {
        bestFramePerTrack.set(face.trackId, {
          score: candidateScore,
          timeSec: fr.timeSec,
          x: face.x,
          y: face.y,
          w: face.w,
          h: face.h
        })
      }
    }
  }

  const chosen = [...bestFramePerTrack.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 3)

  const snapshots: Array<{ trackId: number; base64Jpeg: string }> = []
  for (const [trackId, info] of chosen) {
    if (params.signal?.aborted) break
    const srcW = params.metadataWidth || params.tracking.sourceWidth
    const srcH = params.metadataHeight || params.tracking.sourceHeight
    const padX = info.w * 0.45
    const padY = info.h * 0.45
    const x1 = Math.max(0, info.x - padX)
    const y1 = Math.max(0, info.y - padY)
    const x2 = Math.min(1, info.x + info.w + padX)
    const y2 = Math.min(1, info.y + info.h + padY)

    const cropW = Math.max(64, Math.round((x2 - x1) * srcW))
    const cropH = Math.max(64, Math.round((y2 - y1) * srcH))
    const cropX = Math.max(0, Math.min(srcW - cropW, Math.round(x1 * srcW)))
    const cropY = Math.max(0, Math.min(srcH - cropH, Math.round(y1 * srcH)))

    const absTime = params.clipStartSec + info.timeSec
    const outJpg = path.join(params.tempDir, `speaker_track_${trackId}.jpg`)
    try {
      await runCancellableSpawn(
        ffmpeg,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-threads',
          String(profile.ffmpegThreads),
          '-ss',
          absTime.toFixed(2),
          '-i',
          params.sourceVideoPath,
          '-frames:v',
          '1',
          '-vf',
          `crop=${cropW}:${cropH}:${cropX}:${cropY},scale='min(320,iw)':-2`,
          '-q:v',
          '5',
          outJpg
        ],
        { signal: params.signal, trackChild: params.trackChild }
      )
      if (existsSync(outJpg)) {
        const buf = await readFile(outJpg)
        snapshots.push({ trackId, base64Jpeg: buf.toString('base64') })
      }
    } catch {
      // Ignore single frame extract failure; pitch & LLM signals still operate
    } finally {
      await rm(outJpg, { force: true }).catch(() => {})
    }
  }

  return snapshots
}

/**
 * Pure multi-signal fusion (Visual + Acoustic Pitch + LLM Diarizer + User Overrides)
 * producing final DubSpeakerProfile[] with strictly gender-matched prebuilt Gemini voices.
 */
export function resolveSpeakerProfilesAndTurns(params: {
  microTurns: DiarizationTurnInput[]
  aiResult: { speakers: AiDiarizedSpeaker[]; turns: AiDiarizedTurn[] }
  dubbingConfig: DubbingConfig
  contentType?: string
}): { speakers: DubSpeakerProfile[]; turns: DubTurnSegment[] } {
  const { microTurns, aiResult, dubbingConfig, contentType } = params
  const turnInputByIdx = new Map<number, DiarizationTurnInput>(
    microTurns.map((t) => [t.idx, t])
  )
  const aiTurnByIdx = new Map<number, AiDiarizedTurn>(
    aiResult.turns.map((t) => [t.idx, t])
  )
  const aiSpeakerById = new Map<string, AiDiarizedSpeaker>(
    aiResult.speakers.map((s) => [s.speakerId, s])
  )
  const overrideById = new Map(
    (dubbingConfig.speakerOverrides ?? []).map((o) => [o.speakerId, o])
  )

  const turnSegments: DubTurnSegment[] = []
  const seenSpeakerOrder: string[] = []
  const turnsPerSpeaker = new Map<string, DiarizationTurnInput[]>()

  for (const inputTurn of microTurns) {
    const aiTurn = aiTurnByIdx.get(inputTurn.idx)
    const speakerId = aiTurn?.speakerId || 'Speaker 1'
    if (!seenSpeakerOrder.includes(speakerId)) {
      seenSpeakerOrder.push(speakerId)
    }
    const bucket = turnsPerSpeaker.get(speakerId) ?? []
    bucket.push(inputTurn)
    turnsPerSpeaker.set(speakerId, bucket)

    turnSegments.push({
      startSec: inputTurn.startSec,
      endSec: inputTurn.endSec,
      speakerId,
      originalText: inputTurn.text,
      translatedText: aiTurn?.translatedText || inputTurn.text,
      style: aiTurn?.style || undefined
    })
  }

  const usedVoices = new Set<string>()
  // Pre-reserve any explicit valid override voices so automatic picks don't collide
  for (const speakerId of seenSpeakerOrder) {
    const ov = overrideById.get(speakerId)
    if (ov?.voiceName) {
      const entry = getVoiceEntry(ov.voiceName)
      if (entry) usedVoices.add(entry.name)
    }
  }

  const profiles: DubSpeakerProfile[] = []

  seenSpeakerOrder.forEach((speakerId, idx) => {
    const speakerTurns = turnsPerSpeaker.get(speakerId) ?? []
    const aiSp = aiSpeakerById.get(speakerId)
    const ov = overrideById.get(speakerId)

    const f0Samples = speakerTurns
      .map((t) => t.f0Hz)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 50)
    const pitchHz = medianNumber(f0Samples)
    const roundedPitch = pitchHz != null ? Math.round(pitchHz * 10) / 10 : null

    // Dominant visual track ID for this speaker
    const trackCounts = new Map<number, number>()
    for (const st of speakerTurns) {
      if (st.linkedTrackId != null) {
        trackCounts.set(st.linkedTrackId, (trackCounts.get(st.linkedTrackId) ?? 0) + 1)
      }
    }
    let linkedTrackId: number | null = aiSp?.linkedTrackId ?? null
    if (trackCounts.size > 0) {
      linkedTrackId = [...trackCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
    }

    // Weighted multi-signal gender fusion
    let maleScore = 0
    let femaleScore = 0
    let totalConfidenceWeight = 0

    // 1. Acoustic pitch evidence across speaker's turns
    if (pitchHz !== null) {
      if (pitchHz < 148) {
        const w = Math.min(1.4, 0.7 + (148 - pitchHz) / 40)
        maleScore += w
        totalConfidenceWeight += w
      } else if (pitchHz > 174) {
        const w = Math.min(1.4, 0.7 + (pitchHz - 174) / 45)
        femaleScore += w
        totalConfidenceWeight += w
      }
    }

    // 2. Visual face appearance evidence
    for (const st of speakerTurns) {
      if (st.visualGender === 'male') {
        maleScore += 0.9
        totalConfidenceWeight += 0.9
      } else if (st.visualGender === 'female') {
        femaleScore += 0.9
        totalConfidenceWeight += 0.9
      }
    }

    // 3. LLM contextual gender cue
    if (aiSp?.gender === 'male') {
      const w = 0.85 * (aiSp.confidence || 0.75)
      maleScore += w
      totalConfidenceWeight += w
    } else if (aiSp?.gender === 'female') {
      const w = 0.85 * (aiSp.confidence || 0.75)
      femaleScore += w
      totalConfidenceWeight += w
    }

    let resolvedGender: SpeakerGender = 'unknown'
    if (maleScore > femaleScore && maleScore >= 0.4) {
      resolvedGender = 'male'
    } else if (femaleScore > maleScore && femaleScore >= 0.4) {
      resolvedGender = 'female'
    } else if (pitchHz !== null) {
      resolvedGender = pitchHz >= 162 ? 'female' : 'male'
    }

    const styleParts = [
      aiSp?.styleHint,
      speakerTurns.find((t) => t.visualStyleHint)?.visualStyleHint
    ].filter(Boolean)
    const styleHint = styleParts[0] || undefined

    // Apply explicit user overrides if present
    let finalVoiceName: string | null = null
    if (ov?.voiceName) {
      const entry = getVoiceEntry(ov.voiceName)
      if (entry) {
        finalVoiceName = entry.name
        if (!ov.gender) {
          resolvedGender = entry.gender
        }
      }
    }
    if (ov?.gender === 'male' || ov?.gender === 'female') {
      resolvedGender = ov.gender
      // If override changed gender away from old override voiceName, clear mismatch
      if (finalVoiceName) {
        const entry = getVoiceEntry(finalVoiceName)
        if (entry && entry.gender !== ov.gender) {
          finalVoiceName = null
        }
      }
    }

    const voiceGender: 'male' | 'female' =
      resolvedGender === 'female' ? 'female' : 'male'

    if (!finalVoiceName) {
      const picked = pickVoiceForSpeaker({
        gender: voiceGender,
        pitchHintHz: pitchHz,
        contentType,
        styleHint,
        alreadyUsedVoices: usedVoices,
        speakerIndex: idx
      })
      finalVoiceName = picked.name
      usedVoices.add(picked.name)
    }

    const winningScore = Math.max(maleScore, femaleScore)
    const confidence =
      ov?.gender || ov?.voiceName
        ? 1.0
        : totalConfidenceWeight > 0
          ? Math.round(Math.min(0.99, winningScore / totalConfidenceWeight) * 100) / 100
          : 0.45

    profiles.push({
      speakerId,
      label: aiSp?.label || (seenSpeakerOrder.length === 1 ? 'Speaker' : speakerId),
      gender: resolvedGender === 'unknown' && !ov ? voiceGender : resolvedGender,
      voiceName: finalVoiceName,
      pitchHz: roundedPitch,
      confidence,
      linkedTrackId,
      styleHint
    })
  })

  void turnInputByIdx
  return { speakers: profiles, turns: turnSegments }
}

export async function analyzeAndPlanClipDubbing(params: {
  project: ProjectRecord
  clip: ClipRecord
  clipDir: string
  tracking: ClipTrackingResult | null
  dubbingConfig: DubbingConfig
  signal?: AbortSignal
  trackChild?: (child: ChildProcess) => () => void
  onProgress?: (percent: number, detail: string) => void
}): Promise<DubbingPlan> {
  const {
    project,
    clip,
    clipDir,
    tracking,
    dubbingConfig,
    signal,
    trackChild,
    onProgress
  } = params

  await ensureDir(clipDir)
  const targetLang = getDubTargetLanguage(dubbingConfig.targetLanguage)
  if (!targetLang) {
    throw new Error(`Unsupported dubbing target language: ${dubbingConfig.targetLanguage}`)
  }

  let transcript: TranscriptData | null = null
  if (project.transcriptPath && existsSync(project.transcriptPath)) {
    transcript = JSON.parse(await readFile(project.transcriptPath, 'utf8')) as TranscriptData
  }

  const sourceLanguage = project.sourceLanguage || transcript?.language || 'unknown'
  if (!isEnglishSourceLanguage(sourceLanguage)) {
    throw new Error(
      `AI Dubbing currently supports English source videos only (detected source language: "${sourceLanguage}").`
    )
  }

  onProgress?.(10, 'Segmenting clip dialogue turns...')
  const microTurns = extractClipMicroTurns({ clip, transcript })
  if (microTurns.length === 0) {
    return {
      sourceLanguage,
      targetLanguage: targetLang.code,
      clipStartSec: clip.startTimeSec,
      clipEndSec: clip.endTimeSec,
      speakers: [],
      turns: [],
      dubbedWords: [],
      dubbedTranscriptText: '',
      generatedAt: new Date().toISOString()
    }
  }

  const tempDubDir = path.join(clipDir, 'temp_dub')
  await ensureDir(tempDubDir)
  const clipWavPath = path.join(tempDubDir, 'clip_16k.wav')

  try {
    let pitchByIdx = new Map<number, PitchSegmentAnalysis>()
    if (project.sourceVideoPath && existsSync(project.sourceVideoPath)) {
      const hasAudioStream = project.metadata ? Boolean(project.metadata.audioCodec) : true
      if (hasAudioStream) {
        onProgress?.(25, 'Measuring acoustic pitch (f0) per speaker turn...')
        const ffmpeg = await resolveFfmpegBin()
        const profile = getAdaptiveProcessingProfile()
        const dur = Math.max(0.5, clip.endTimeSec - clip.startTimeSec)
        await runCancellableSpawn(
          ffmpeg,
          [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-threads',
            String(profile.ffmpegThreads),
            '-ss',
            clip.startTimeSec.toFixed(3),
            '-t',
            dur.toFixed(3),
            '-i',
            project.sourceVideoPath,
            '-vn',
            '-acodec',
            'pcm_s16le',
            '-ar',
            '16000',
            '-ac',
            '1',
            clipWavPath
          ],
          { signal, trackChild }
        )
        pitchByIdx = await runPitchWorker({
          clipSliceWavPath: clipWavPath,
          turns: microTurns,
          tempDir: tempDubDir,
          signal,
          trackChild
        }).catch((err) => {
          log(
            'warn',
            'SpeakerAnalysis',
            `Acoustic pitch worker failed cleanly; continuing with vision/LLM cues: ${(err as Error).message}`,
            project.id
          )
          return new Map<number, PitchSegmentAnalysis>()
        })
      }
    }

    onProgress?.(45, 'Detecting speaker gender cues from tracked face frames...')
    let visualGenderByTrack = new Map<number, VisualSpeakerGenderResult>()
    if (tracking && project.sourceVideoPath && existsSync(project.sourceVideoPath)) {
      const crops = await extractTrackFaceCrops({
        sourceVideoPath: project.sourceVideoPath,
        clipStartSec: clip.startTimeSec,
        tracking,
        metadataWidth: project.metadata?.width ?? tracking.sourceWidth,
        metadataHeight: project.metadata?.height ?? tracking.sourceHeight,
        tempDir: tempDubDir,
        signal,
        trackChild
      })
      if (crops.length > 0) {
        visualGenderByTrack = await inspectSpeakerGendersWithVision({
          snapshots: crops,
          videoTitle: project.metadata?.title || project.title,
          visionModelOverride: project.config.aiVisionModel,
          projectId: project.id
        })
      }
    }

    // Build enriched turns combining acoustic pitch & linked visual face gender
    const enrichedTurns: DiarizationTurnInput[] = microTurns.map((t) => {
      const pitch = pitchByIdx.get(t.idx)
      const trackId = findDominantTrackForTurn(t, tracking)
      const vis = trackId != null ? visualGenderByTrack.get(trackId) : undefined
      return {
        idx: t.idx,
        startSec: t.startSec,
        endSec: t.endSec,
        text: t.text,
        f0Hz: pitch?.medianF0Hz ?? null,
        acousticGender: pitch?.acousticGender ?? 'unknown',
        linkedTrackId: trackId,
        visualGender: vis?.gender ?? 'unknown',
        visualStyleHint: vis?.styleHint
      }
    })

    onProgress?.(65, `Diarizing speakers & translating clip to ${targetLang.name}...`)
    const aiResult = await diarizeAndTranslateClipWithAI({
      turns: enrichedTurns,
      videoTitle: project.metadata?.title || project.title,
      contentType: project.visualAnalysis?.contentType,
      targetLanguageCode: targetLang.code,
      targetLanguageName: targetLang.name,
      modelOverride: project.config.aiModel,
      projectId: project.id
    })

    if (!aiResult) {
      throw new Error(
        `Unable to translate clip to ${targetLang.name}: configure AI_API_KEY or GEMINI_API_KEY in .env.`
      )
    }

    const fused = resolveSpeakerProfilesAndTurns({
      microTurns: enrichedTurns,
      aiResult,
      dubbingConfig,
      contentType: project.visualAnalysis?.contentType
    })

    log(
      'info',
      'SpeakerAnalysis',
      `Detected ${fused.speakers.length} speaker(s): ${fused.speakers
        .map((s) => `${s.speakerId}=${s.gender}(${s.voiceName}${s.pitchHz ? `,${s.pitchHz}Hz` : ''})`)
        .join(', ')}`,
      project.id
    )

    onProgress?.(100, `Planned dubbing across ${fused.speakers.length} speaker(s)`)
    return {
      sourceLanguage,
      targetLanguage: targetLang.code,
      clipStartSec: clip.startTimeSec,
      clipEndSec: clip.endTimeSec,
      speakers: fused.speakers,
      turns: fused.turns,
      dubbedWords: [],
      dubbedTranscriptText: fused.turns.map((t) => t.translatedText).join(' '),
      generatedAt: new Date().toISOString()
    }
  } finally {
    await rm(tempDubDir, { recursive: true, force: true }).catch(() => {})
  }
}

