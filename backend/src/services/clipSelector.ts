import { randomUUID } from 'node:crypto'
import type {
  ClipRecord,
  ClipScoreBreakdown,
  CompositionMode,
  ProjectConfig,
  ScoringWeights,
  TranscriptData,
  TranscriptSegment,
  TranscriptWord,
  VisualAnalysisSummary
} from '../types/index.ts'
import type { AudioEnergyData } from './transcriptionService.ts'
import type { AiRawClipCandidate } from './aiClient.ts'

export function computeWeightedScore(
  scores: Omit<ClipScoreBreakdown, 'weightedTotal'>,
  weights: ScoringWeights
): ClipScoreBreakdown {
  const totalWeight =
    weights.hookStrength +
    weights.storyCompleteness +
    weights.emotionalImpact +
    weights.informationValue +
    weights.audienceInterest +
    weights.endingPayoff +
    weights.visualQuality
  const norm = totalWeight > 0 ? totalWeight : 1

  const weighted =
    (scores.hookStrength * weights.hookStrength +
      scores.storyCompleteness * weights.storyCompleteness +
      scores.emotionalImpact * weights.emotionalImpact +
      scores.informationValue * weights.informationValue +
      scores.audienceInterest * weights.audienceInterest +
      scores.endingPayoff * weights.endingPayoff +
      scores.visualQuality * weights.visualQuality) /
    norm

  return {
    ...scores,
    weightedTotal: Math.round(weighted * 10) / 10
  }
}

function clampScore(v: number): number {
  if (!Number.isFinite(v)) return 60
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10))
}

function endsWithSentencePunctuation(text: string): boolean {
  return /[.!?]["')\]]*$/.test(text.trim())
}

/**
 * Snap raw candidate timestamps cleanly to natural sentence/segment boundaries
 * without cutting in the middle of sentences or leaving long silent edges.
 */
export function snapTimestampsToTranscript(params: {
  rawStartSec: number
  rawEndSec: number
  segments: TranscriptSegment[]
  videoDurationSec: number
  minDurationSec: number
  maxDurationSec: number
  energy?: AudioEnergyData | null
}): { startSec: number; endSec: number; segmentsInRange: TranscriptSegment[] } {
  const {
    rawStartSec,
    rawEndSec,
    segments,
    videoDurationSec,
    minDurationSec,
    maxDurationSec,
    energy
  } = params

  if (segments.length === 0) {
    const startSec = Math.max(0, Math.min(rawStartSec, Math.max(0, videoDurationSec - minDurationSec)))
    const endSec = Math.min(
      videoDurationSec,
      Math.max(startSec + minDurationSec, Math.min(rawEndSec, startSec + maxDurationSec))
    )
    return { startSec, endSec, segmentsInRange: [] }
  }

  // Find closest segment start near rawStartSec
  let startIdx = 0
  let bestStartDist = Number.POSITIVE_INFINITY
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const dist = Math.abs(seg.start - rawStartSec)
    if (dist < bestStartDist) {
      bestStartDist = dist
      startIdx = i
    }
  }

  // Backtrack slightly if previous segment didn't end a sentence (preserve context)
  if (
    startIdx > 0 &&
    !endsWithSentencePunctuation(segments[startIdx - 1]!.text) &&
    segments[startIdx]!.start - segments[startIdx - 1]!.start <= 6
  ) {
    startIdx -= 1
  }

  // Advance endIdx until duration >= minDurationSec and preferably sentence boundary reached
  let endIdx = startIdx
  while (endIdx + 1 < segments.length) {
    const currentDur = segments[endIdx]!.end - segments[startIdx]!.start
    const nextDur = segments[endIdx + 1]!.end - segments[startIdx]!.start
    if (currentDur < minDurationSec && nextDur <= maxDurationSec + 3) {
      endIdx += 1
      continue
    }
    if (
      segments[endIdx]!.end < rawEndSec - 1.5 &&
      nextDur <= maxDurationSec
    ) {
      endIdx += 1
      continue
    }
    // Finish incomplete sentence if within maxDuration + small tolerance
    if (
      !endsWithSentencePunctuation(segments[endIdx]!.text) &&
      nextDur <= maxDurationSec + 2
    ) {
      endIdx += 1
      continue
    }
    break
  }

  const prevSegEnd = startIdx > 0 ? segments[startIdx - 1]!.end : 0
  const initialNextSegStart = endIdx + 1 < segments.length ? segments[endIdx + 1]!.start : videoDurationSec

  let startSec = Math.max(prevSegEnd, segments[startIdx]!.start - 0.2)
  let endSec = Math.min(initialNextSegStart, segments[endIdx]!.end + 0.25)

  // Trim excessive leading/trailing silence inward using audio energy envelope (never crossing adjacent sentences)
  if (energy && energy.rms.length > 0) {
    const hopSec = energy.hopMs / 1000
    const thresh = energy.speechThreshold
    let sIdx = Math.max(0, Math.floor(startSec / hopSec))
    let eIdx = Math.min(energy.rms.length - 1, Math.floor(endSec / hopSec))
    while (sIdx < eIdx && (energy.rms[sIdx] ?? 0) < thresh * 0.65 && (eIdx - sIdx) * hopSec > minDurationSec) {
      sIdx++
    }
    while (eIdx > sIdx && (energy.rms[eIdx] ?? 0) < thresh * 0.65 && (eIdx - sIdx) * hopSec > minDurationSec) {
      eIdx--
    }
    const trimmedStart = Math.max(startSec, sIdx * hopSec - 0.1)
    const trimmedEnd = Math.min(endSec, (eIdx + 1) * hopSec + 0.15)
    if (trimmedEnd - trimmedStart >= minDurationSec * 0.85) {
      startSec = trimmedStart
      endSec = trimmedEnd
    }
  }

  // Enforce maxDurationSec cleanly at whole-sentence boundaries first
  while (endIdx > startIdx && endSec - startSec > maxDurationSec) {
    endIdx -= 1
    const nextStart = endIdx + 1 < segments.length ? segments[endIdx + 1]!.start : videoDurationSec
    endSec = Math.min(nextStart, segments[endIdx]!.end + 0.2)
  }
  if (endSec - startSec > maxDurationSec) {
    endSec = Math.min(videoDurationSec, startSec + maxDurationSec)
  }
  // Enforce minDurationSec if source is long enough
  if (endSec - startSec < minDurationSec && videoDurationSec >= minDurationSec) {
    if (startSec + minDurationSec <= videoDurationSec) {
      endSec = startSec + minDurationSec
    } else {
      endSec = videoDurationSec
      startSec = Math.max(0, videoDurationSec - minDurationSec)
    }
  }

  const segmentsInRange = segments.filter((s) => {
    const overlap = Math.min(s.end, endSec) - Math.max(s.start, startSec)
    if (overlap <= 0) return false
    const segDur = Math.max(0.1, s.end - s.start)
    return overlap >= segDur * 0.5 || overlap >= 1.5
  })

  return {
    startSec: Math.round(startSec * 100) / 100,
    endSec: Math.round(endSec * 100) / 100,
    segmentsInRange
  }
}

function collectWordsInRange(
  segments: TranscriptSegment[],
  startSec: number,
  endSec: number
): TranscriptWord[] {
  const words: TranscriptWord[] = []
  for (const seg of segments) {
    if (seg.end < startSec || seg.start > endSec) continue
    for (const w of seg.words) {
      if (w.end > startSec && w.start < endSec) {
        words.push({
          word: w.word,
          start: Math.max(startSec, w.start),
          end: Math.min(endSec, w.end),
          probability: w.probability
        })
      }
    }
  }
  return words
}

function computeSilenceRatio(
  startSec: number,
  endSec: number,
  energy?: AudioEnergyData | null
): number {
  if (!energy || energy.rms.length === 0) return 0
  const hopSec = energy.hopMs / 1000
  const s = Math.max(0, Math.floor(startSec / hopSec))
  const e = Math.min(energy.rms.length - 1, Math.floor(endSec / hopSec))
  if (e <= s) return 0
  let silent = 0
  for (let i = s; i <= e; i++) {
    if ((energy.rms[i] ?? 0) < energy.speechThreshold) silent++
  }
  return silent / (e - s + 1)
}

function scoreSegmentHeuristically(
  segs: TranscriptSegment[],
  silenceRatio: number,
  weights: ScoringWeights
): ClipScoreBreakdown {
  const fullText = segs.map((s) => s.text).join(' ').trim()
  const firstText = segs[0]?.text || ''
  const lastText = segs[segs.length - 1]?.text || ''
  const wordCount = fullText.split(/\s+/).filter(Boolean).length
  const dur = Math.max(1, (segs[segs.length - 1]?.end ?? 1) - (segs[0]?.start ?? 0))
  const wps = wordCount / dur

  const hookSignals =
    /\b(why|how|secret|never|always|actually|stop|mistake|truth|crazy|wild|insane|imagine|nobody|everyone|first|warning|question|what if|here's)\b/i
  const emotionSignals =
    /\b(love|hate|fear|shocked|amazing|terrible|incredible|laugh|joke|funny|wrong|brilliant|impossible|dead|huge|worst|best)\b|[!?]/i
  const infoSignals =
    /\b(because|therefore|means|reason|step|data|percent|million|billion|study|proof|learn|strategy|system|method|example)\b|\d+/i

  let hookStrength = 55
  if (hookSignals.test(firstText)) hookStrength += 22
  if (firstText.includes('?')) hookStrength += 12
  if (wps >= 2.2) hookStrength += 8

  let storyCompleteness = 55
  if (endsWithSentencePunctuation(lastText)) storyCompleteness += 22
  if (segs.length >= 3) storyCompleteness += 10
  if (silenceRatio < 0.25) storyCompleteness += 10

  let emotionalImpact = 50
  const emoMatches = fullText.match(new RegExp(emotionSignals.source, 'gi'))?.length ?? 0
  emotionalImpact += Math.min(35, emoMatches * 7)
  if (fullText.includes('!')) emotionalImpact += 8

  let informationValue = 52
  const infoMatches = fullText.match(new RegExp(infoSignals.source, 'gi'))?.length ?? 0
  informationValue += Math.min(35, infoMatches * 6)

  let audienceInterest = 56
  if (wps >= 2.0 && wps <= 4.2) audienceInterest += 18
  if (silenceRatio < 0.2) audienceInterest += 14
  if (fullText.includes('?')) audienceInterest += 8

  let endingPayoff = 52
  if (endsWithSentencePunctuation(lastText)) endingPayoff += 24
  if (infoSignals.test(lastText) || emotionSignals.test(lastText)) endingPayoff += 12

  const visualQuality = 70

  return computeWeightedScore(
    {
      hookStrength: clampScore(hookStrength),
      storyCompleteness: clampScore(storyCompleteness),
      emotionalImpact: clampScore(emotionalImpact),
      informationValue: clampScore(informationValue),
      audienceInterest: clampScore(audienceInterest),
      endingPayoff: clampScore(endingPayoff),
      visualQuality: clampScore(visualQuality)
    },
    weights
  )
}

function generateHeuristicCandidates(params: {
  transcript: TranscriptData
  energy?: AudioEnergyData | null
  videoDurationSec: number
  minDurationSec: number
  maxDurationSec: number
  weights: ScoringWeights
}): AiRawClipCandidate[] {
  const { transcript, energy, videoDurationSec, minDurationSec, maxDurationSec, weights } = params
  const segs = transcript.segments

  if (segs.length === 0) {
    // Pure fallback when audio had no recognized speech
    const targetDur = Math.min(maxDurationSec, Math.max(minDurationSec, Math.min(30, videoDurationSec)))
    const count = Math.max(1, Math.min(3, Math.floor(videoDurationSec / Math.max(15, targetDur))))
    const out: AiRawClipCandidate[] = []
    for (let i = 0; i < count; i++) {
      const startSec = Math.round(((i * videoDurationSec) / count) * 100) / 100
      const endSec = Math.round(Math.min(videoDurationSec, startSec + targetDur) * 100) / 100
      if (endSec - startSec < 5) continue
      out.push({
        startSec,
        endSec,
        title: `Highlight Segment ${i + 1}`,
        description: 'Visual highlight selected from source timeline.',
        hook: 'Visual highlight',
        reason: 'Selected automatically from timeline energy and pacing.',
        engagementPotential: 'medium',
        scores: {
          hookStrength: 60,
          storyCompleteness: 65,
          emotionalImpact: 60,
          informationValue: 55,
          audienceInterest: 62,
          endingPayoff: 60,
          visualQuality: 70
        }
      })
    }
    return out
  }

  const targetDur = Math.round((minDurationSec + maxDurationSec) / 2)
  const candidates: AiRawClipCandidate[] = []
  const strideStep = Math.max(1, Math.floor(segs.length / 18))

  for (let i = 0; i < segs.length; i += strideStep) {
    // Prefer starting after a sentence end
    let startIdx = i
    if (startIdx > 0 && !endsWithSentencePunctuation(segs[startIdx - 1]!.text)) {
      if (startIdx + 1 < segs.length && endsWithSentencePunctuation(segs[startIdx]!.text)) {
        startIdx += 1
      }
    }

    let endIdx = startIdx
    while (endIdx + 1 < segs.length) {
      const dur = segs[endIdx]!.end - segs[startIdx]!.start
      const nextDur = segs[endIdx + 1]!.end - segs[startIdx]!.start
      if (dur < minDurationSec && nextDur <= maxDurationSec + 2) {
        endIdx += 1
        continue
      }
      if (dur < targetDur && nextDur <= maxDurationSec) {
        endIdx += 1
        continue
      }
      if (!endsWithSentencePunctuation(segs[endIdx]!.text) && nextDur <= maxDurationSec + 2) {
        endIdx += 1
        continue
      }
      break
    }

    const windowSegs = segs.slice(startIdx, endIdx + 1)
    const startSec = windowSegs[0]!.start
    const endSec = windowSegs[windowSegs.length - 1]!.end
    if (endSec - startSec < Math.min(8, minDurationSec * 0.6)) continue

    const silenceRatio = computeSilenceRatio(startSec, endSec, energy)
    const breakdown = scoreSegmentHeuristically(windowSegs, silenceRatio, weights)
    const hook = windowSegs[0]!.text.slice(0, 120)
    const previewTitle =
      hook.replace(/[.!?]+$/, '').split(/\s+/).slice(0, 8).join(' ') ||
      `Clip ${candidates.length + 1}`

    candidates.push({
      startSec,
      endSec,
      title: previewTitle,
      description: windowSegs.map((s) => s.text).join(' ').slice(0, 240),
      hook,
      reason: `Heuristic transcript & acoustic score (${breakdown.weightedTotal}/100, silence ${(silenceRatio * 100).toFixed(0)}%)`,
      engagementPotential:
        breakdown.weightedTotal >= 75
          ? 'high'
          : breakdown.weightedTotal >= 60
            ? 'medium'
            : 'experimental',
      scores: {
        hookStrength: breakdown.hookStrength,
        storyCompleteness: breakdown.storyCompleteness,
        emotionalImpact: breakdown.emotionalImpact,
        informationValue: breakdown.informationValue,
        audienceInterest: breakdown.audienceInterest,
        endingPayoff: breakdown.endingPayoff,
        visualQuality: breakdown.visualQuality
      }
    })
  }

  return candidates
}

function overlapRatio(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const inter = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
  if (inter <= 0) return 0
  const minDur = Math.max(0.1, Math.min(aEnd - aStart, bEnd - bStart))
  return inter / minDur
}

export function selectAndRankClips(params: {
  projectId: string
  config: ProjectConfig
  transcript: TranscriptData
  energy?: AudioEnergyData | null
  videoDurationSec: number
  aiCandidates: AiRawClipCandidate[]
  visualSummary?: VisualAnalysisSummary | null
}): ClipRecord[] {
  const {
    projectId,
    config,
    transcript,
    energy,
    videoDurationSec,
    aiCandidates,
    visualSummary
  } = params

  const heuristicCandidates = generateHeuristicCandidates({
    transcript,
    energy,
    videoDurationSec,
    minDurationSec: config.minClipDurationSec,
    maxDurationSec: config.maxClipDurationSec,
    weights: config.scoringWeights
  })

  const combinedRaw = [...aiCandidates, ...heuristicCandidates]
  const resolvedComp: CompositionMode =
    config.compositionMode === 'smart' && visualSummary?.compositionRecommendation
      ? visualSummary.compositionRecommendation
      : config.compositionMode

  interface ScoredCandidate {
    startSec: number
    endSec: number
    title: string
    description: string
    hook: string
    reason: string
    transcriptText: string
    words: TranscriptWord[]
    breakdown: ClipScoreBreakdown
    engagementPotential: ClipRecord['engagementPotential']
  }

  const normalized: ScoredCandidate[] = []

  for (const raw of combinedRaw) {
    const snapped = snapTimestampsToTranscript({
      rawStartSec: raw.startSec,
      rawEndSec: raw.endSec,
      segments: transcript.segments,
      videoDurationSec,
      minDurationSec: config.minClipDurationSec,
      maxDurationSec: config.maxClipDurationSec,
      energy
    })

    if (snapped.endSec - snapped.startSec < 4) continue

    const silenceRatio = computeSilenceRatio(snapped.startSec, snapped.endSec, energy)
    const silencePenalty = silenceRatio > 0.35 ? (silenceRatio - 0.35) * 35 : 0
    const outroRegex =
      /\b(subscribe|bell icon|notification|comment section|see you next time|like,?\s*share|channel ko subscribe)\b/i
    const transcriptText = snapped.segmentsInRange.map((s) => s.text).join(' ').trim()
    const outroPenalty = outroRegex.test(transcriptText) ? 18 : 0

    const rawScores = (raw.scores ?? {}) as Partial<AiRawClipCandidate['scores']>
    const breakdown = computeWeightedScore(
      {
        hookStrength: clampScore((rawScores.hookStrength ?? 65) - silencePenalty * 0.4 - outroPenalty * 0.5),
        storyCompleteness: clampScore((rawScores.storyCompleteness ?? 65) - outroPenalty * 0.4),
        emotionalImpact: clampScore(rawScores.emotionalImpact ?? 65),
        informationValue: clampScore((rawScores.informationValue ?? 65) - outroPenalty * 0.4),
        audienceInterest: clampScore((rawScores.audienceInterest ?? 65) - silencePenalty * 0.6 - outroPenalty),
        endingPayoff: clampScore((rawScores.endingPayoff ?? 65) - outroPenalty * 0.6),
        visualQuality: clampScore(rawScores.visualQuality ?? 70)
      },
      config.scoringWeights
    )

    const words = collectWordsInRange(
      snapped.segmentsInRange,
      snapped.startSec,
      snapped.endSec
    )

    normalized.push({
      startSec: snapped.startSec,
      endSec: snapped.endSec,
      title: (raw.title || 'Untitled Moment').trim().slice(0, 110),
      description: (raw.description || transcriptText.slice(0, 220)).trim(),
      hook: (raw.hook || snapped.segmentsInRange[0]?.text || '').trim().slice(0, 180),
      reason: (raw.reason || 'High heuristic engagement score').trim(),
      transcriptText,
      words,
      breakdown,
      engagementPotential: raw.engagementPotential || 'medium'
    })
  }

  // Rank descending by weightedTotal and deduplicate overlapping windows (> 35% overlap)
  normalized.sort((a, b) => b.breakdown.weightedTotal - a.breakdown.weightedTotal)

  const selected: ScoredCandidate[] = []
  for (const cand of normalized) {
    if (selected.length >= config.targetClipCount) break
    const hasHeavyOverlap = selected.some(
      (existing) => overlapRatio(existing.startSec, existing.endSec, cand.startSec, cand.endSec) > 0.35
    )
    if (!hasHeavyOverlap) {
      selected.push(cand)
    }
  }

  const now = new Date().toISOString()
  return selected.map((c, idx) => ({
    id: `clip_${randomUUID().slice(0, 12)}`,
    projectId,
    rank: idx + 1,
    title: c.title,
    description: c.description,
    hook: c.hook,
    reason: c.reason,
    startTimeSec: c.startSec,
    endTimeSec: c.endSec,
    durationSec: Math.round((c.endSec - c.startSec) * 100) / 100,
    transcriptText: c.transcriptText,
    words: c.words,
    scoreBreakdown: c.breakdown,
    overallScore: c.breakdown.weightedTotal,
    engagementPotential: c.engagementPotential,
    approved: true,
    status: 'PENDING',
    compositionMode: resolvedComp,
    subtitleConfig: { ...config.subtitleConfig },
    renderQuality: config.renderQuality,
    targetFps: null,
    backgroundAudioPath: config.backgroundAudioPath ?? null,
    backgroundAudioVolume: config.backgroundAudioVolume ?? 0.15,
    dubbingConfig: config.dubbingConfig ? { ...config.dubbingConfig } : null,
    createdAt: now,
    updatedAt: now
  }))
}

