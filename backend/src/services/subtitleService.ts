import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  ClipTrackingResult,
  SubtitleConfig,
  SubtitlePresetName,
  TranscriptWord
} from '../types/index.ts'
import { ensureDir } from '../utils/fsSafe.ts'
import { getDubTargetLanguage } from './voiceCatalog.ts'

export const SUBTITLE_PRESETS: Record<SubtitlePresetName, SubtitleConfig> = {
  modern: {
    preset: 'modern',
    fontName: 'Noto Sans',
    fontSize: 68,
    primaryColor: '#FFFFFF',
    highlightColor: '#FACC15',
    outlineColor: '#09090B',
    outlineWidth: 5,
    shadowDepth: 2,
    position: 'auto',
    safeMarginBottomPx: 320,
    safeMarginTopPx: 220,
    highlightKeywords: true,
    maxWordsPerLine: 4
  },
  minimal: {
    preset: 'minimal',
    fontName: 'Liberation Sans',
    fontSize: 54,
    primaryColor: '#F4F4F5',
    highlightColor: '#38BDF8',
    outlineColor: '#18181B',
    outlineWidth: 3,
    shadowDepth: 1,
    position: 'auto',
    safeMarginBottomPx: 300,
    safeMarginTopPx: 210,
    highlightKeywords: true,
    maxWordsPerLine: 5
  },
  bold: {
    preset: 'bold',
    fontName: 'DejaVu Sans',
    fontSize: 78,
    primaryColor: '#FFFFFF',
    highlightColor: '#22C55E',
    outlineColor: '#000000',
    outlineWidth: 7,
    shadowDepth: 3,
    position: 'auto',
    safeMarginBottomPx: 340,
    safeMarginTopPx: 230,
    highlightKeywords: true,
    maxWordsPerLine: 3
  },
  podcast: {
    preset: 'podcast',
    fontName: 'Noto Sans',
    fontSize: 64,
    primaryColor: '#FAFAFA',
    highlightColor: '#F97316',
    outlineColor: '#09090B',
    outlineWidth: 5,
    shadowDepth: 2,
    position: 'auto',
    safeMarginBottomPx: 320,
    safeMarginTopPx: 220,
    highlightKeywords: true,
    maxWordsPerLine: 4
  },
  gaming: {
    preset: 'gaming',
    fontName: 'DejaVu Sans',
    fontSize: 74,
    primaryColor: '#E0F2FE',
    highlightColor: '#A855F7',
    outlineColor: '#020617',
    outlineWidth: 6,
    shadowDepth: 3,
    position: 'auto',
    safeMarginBottomPx: 330,
    safeMarginTopPx: 220,
    highlightKeywords: true,
    maxWordsPerLine: 3
  },
  educational: {
    preset: 'educational',
    fontName: 'Liberation Sans',
    fontSize: 60,
    primaryColor: '#FFFFFF',
    highlightColor: '#10B981',
    outlineColor: '#0F172A',
    outlineWidth: 4,
    shadowDepth: 2,
    position: 'auto',
    safeMarginBottomPx: 310,
    safeMarginTopPx: 210,
    highlightKeywords: true,
    maxWordsPerLine: 5
  }
}

export interface SubtitlePhrase {
  startSec: number
  endSec: number
  words: Array<{
    word: string
    startSec: number
    endSec: number
  }>
}

/** Convert #RRGGBB -> ASS &H00BBGGRR& */
export function hexToAssColor(hex: string, alphaHex = '00'): string {
  const cleaned = hex.replace('#', '').trim()
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return `&H${alphaHex}FFFFFF`
  }
  const r = cleaned.slice(0, 2).toUpperCase()
  const g = cleaned.slice(2, 4).toUpperCase()
  const b = cleaned.slice(4, 6).toUpperCase()
  return `&H${alphaHex}${b}${g}${r}`
}

export function formatAssTime(sec: number): string {
  const safe = Math.max(0, sec)
  const hrs = Math.floor(safe / 3600)
  const mins = Math.floor((safe % 3600) / 60)
  const secs = Math.floor(safe % 60)
  const cs = Math.min(99, Math.floor((safe - Math.floor(safe)) * 100))
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, ' ')
}

/**
 * Segment clip words into readable, sentence-aware caption phrases relative to clip start.
 */
export function buildSubtitlePhrases(params: {
  words: TranscriptWord[]
  fallbackText?: string
  clipStartSec: number
  clipEndSec: number
  maxWordsPerLine: number
}): SubtitlePhrase[] {
  const { words, fallbackText, clipStartSec, clipEndSec, maxWordsPerLine } = params
  const clipDur = Math.max(0.5, clipEndSec - clipStartSec)

  let normalizedWords = words
    .map((w) => ({
      word: w.word.trim(),
      startSec: Math.max(0, w.start - clipStartSec),
      endSec: Math.min(clipDur, Math.max(0.05, w.end - clipStartSec))
    }))
    .filter((w) => w.word.length > 0 && w.startSec < clipDur)

  if (normalizedWords.length === 0 && fallbackText?.trim()) {
    const tokens = fallbackText.trim().split(/\s+/).filter(Boolean)
    const step = clipDur / Math.max(1, tokens.length)
    normalizedWords = tokens.map((tok, i) => ({
      word: tok,
      startSec: i * step,
      endSec: (i + 1) * step
    }))
  }

  if (normalizedWords.length === 0) return []

  const phrases: SubtitlePhrase[] = []
  let buf: typeof normalizedWords = []
  let charCount = 0
  const maxChars = 26

  const flush = () => {
    if (buf.length === 0) return
    const first = buf[0]!
    const last = buf[buf.length - 1]!
    phrases.push({
      startSec: first.startSec,
      endSec: Math.max(first.startSec + 0.12, last.endSec),
      words: buf
    })
    buf = []
    charCount = 0
  }

  for (let i = 0; i < normalizedWords.length; i++) {
    const w = normalizedWords[i]!
    const prev = buf[buf.length - 1]

    // Break on long speech pause (> 0.6s)
    if (prev && w.startSec - prev.endSec > 0.6) {
      flush()
    }

    buf.push(w)
    charCount += w.word.length + 1

    const endsSentence = /[.!?,;:]$/.test(w.word)
    const reachedLimit = buf.length >= maxWordsPerLine || charCount >= maxChars

    // Avoid leaving a 1-word orphan before punctuation
    const next = normalizedWords[i + 1]
    const nextIsTinyEnding =
      next &&
      /[.!?]$/.test(next.word) &&
      buf.length === maxWordsPerLine &&
      charCount + next.word.length <= maxChars + 6

    if ((endsSentence || reachedLimit) && !nextIsTinyEnding) {
      flush()
    }
  }
  flush()

  // Ensure monotonic non-overlapping phrase intervals
  for (let i = 0; i < phrases.length - 1; i++) {
    const cur = phrases[i]!
    const nxt = phrases[i + 1]!
    if (cur.endSec > nxt.startSec) {
      cur.endSec = Math.max(cur.startSec + 0.08, nxt.startSec)
    }
  }

  return phrases
}

/**
 * Picks an output Y band (Alignment 2/5/8 + MarginV) that avoids covering tracked faces
 * while respecting YouTube Shorts UI safe margins.
 */
function resolveFaceSafePlacement(params: {
  phraseStartSec: number
  phraseEndSec: number
  config: SubtitleConfig
  tracking?: ClipTrackingResult | null
}): { alignment: 2 | 5 | 8; marginV: number } {
  const { phraseStartSec, phraseEndSec, config, tracking } = params

  if (config.position === 'top') {
    return { alignment: 8, marginV: Math.max(160, config.safeMarginTopPx) }
  }
  if (config.position === 'middle') {
    return { alignment: 5, marginV: 0 }
  }
  if (config.position === 'bottom') {
    return { alignment: 2, marginV: Math.max(260, config.safeMarginBottomPx) }
  }

  // AUTO placement
  const bottomMargin = Math.max(280, config.safeMarginBottomPx)
  const topMargin = Math.max(190, config.safeMarginTopPx)

  if (!tracking || tracking.frames.length === 0) {
    if (tracking?.compositionModeResolved === 'dual_split') {
      return { alignment: 5, marginV: 0 }
    }
    return { alignment: 2, marginV: bottomMargin }
  }

  // Inspect active layout & face overlap inside the cropped 9:16 frame (1080x1920)
  const matchingFrames = tracking.frames.filter(
    (f) => f.timeSec >= phraseStartSec - 0.15 && f.timeSec <= phraseEndSec + 0.15
  )
  const samples = matchingFrames.length > 0 ? matchingFrames : [tracking.frames[0]!]

  const dualCount = samples.filter((f) => f.layoutMode === 'dual_split').length
  if (dualCount >= samples.length * 0.5) {
    // In 2-up top/bottom split segments, the seam around y=960 cleanly sits between both speakers!
    return { alignment: 5, marginV: 0 }
  }

  const singleSamples = samples.filter((f) => f.layoutMode !== 'dual_split')
  const checkSamples = singleSamples.length > 0 ? singleSamples : samples

  let bottomOverlapCount = 0
  let topOverlapCount = 0
  const subBottomTopY = 1920 - bottomMargin - config.fontSize * 1.6
  const subTopBottomY = topMargin + config.fontSize * 1.6

  for (const fr of checkSamples) {
    const crop = fr.cropPrimary
    const activeFace =
      fr.faces.find((f) => f.trackId === fr.activeSpeakerId) ?? fr.faces[0]
    if (!activeFace) continue

    // Map face normalized Y bounds into 0..1920 output vertical coordinate
    const faceOutTop = ((activeFace.y - crop.y) / Math.max(1e-4, crop.h)) * 1920
    const faceOutBottom =
      ((activeFace.y + activeFace.h - crop.y) / Math.max(1e-4, crop.h)) * 1920

    if (faceOutBottom > subBottomTopY && faceOutTop < 1920 - bottomMargin + 60) {
      bottomOverlapCount += 1
    }
    if (faceOutTop < subTopBottomY && faceOutBottom > topMargin - 40) {
      topOverlapCount += 1
    }
  }

  if (bottomOverlapCount === 0) {
    return { alignment: 2, marginV: bottomMargin }
  }
  if (topOverlapCount === 0) {
    return { alignment: 8, marginV: topMargin }
  }
  return { alignment: 2, marginV: Math.min(480, bottomMargin + 60) }
}

const UPPER_ACRONYM_RE = /^[A-Z0-9$%#@]{2,}$/
const IMPORTANT_WORD_RE =
  /^(never|always|secret|truth|why|how|stop|crazy|million|billion|percent|best|worst|warning|actually|literally|shocking|ancient|mystery)$/i

export function generateAssSubtitleContent(params: {
  phrases: SubtitlePhrase[]
  config: SubtitleConfig
  tracking?: ClipTrackingResult | null
  dubbedLanguage?: string | null
}): string {
  const { phrases, config, tracking, dubbedLanguage } = params
  const langMeta = getDubTargetLanguage(dubbedLanguage)
  const resolvedFontName = langMeta?.assFont || config.fontName
  const wordJoiner = langMeta?.isCjk ? '' : ' '

  const primaryAss = hexToAssColor(config.primaryColor)
  const highlightAss = hexToAssColor(config.highlightColor)
  const outlineAss = hexToAssColor(config.outlineColor)
  const backAss = hexToAssColor('#000000', '80')

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 1',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${resolvedFontName},${config.fontSize},${primaryAss},${highlightAss},${outlineAss},${backAss},-1,0,0,0,100,100,0,0,1,${config.outlineWidth},${config.shadowDepth},2,70,70,${config.safeMarginBottomPx},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ].join('\n')

  const events: string[] = []

  for (const phrase of phrases) {
    const { alignment, marginV } = resolveFaceSafePlacement({
      phraseStartSec: phrase.startSec,
      phraseEndSec: phrase.endSec,
      config,
      tracking
    })

    if (!config.highlightKeywords || phrase.words.length === 0) {
      const lineText = phrase.words.map((w) => escapeAssText(w.word)).join(wordJoiner)
      const prefix = alignment !== 2 ? `{\\an${alignment}}` : ''
      events.push(
        `Dialogue: 0,${formatAssTime(phrase.startSec)},${formatAssTime(phrase.endSec)},Default,,0,0,${marginV},,${prefix}${lineText}`
      )
      continue
    }

    // Active-word karaoke/highlight sub-events (exact non-overlapping time slices)
    for (let wi = 0; wi < phrase.words.length; wi++) {
      const activeWord = phrase.words[wi]!
      const sliceStart = wi === 0 ? phrase.startSec : activeWord.startSec
      const nextWord = phrase.words[wi + 1]
      const sliceEnd = nextWord
        ? Math.max(sliceStart + 0.04, nextWord.startSec)
        : Math.max(sliceStart + 0.05, phrase.endSec)

      const renderedWords = phrase.words.map((w, idx) => {
        const escaped = escapeAssText(w.word)
        if (idx === wi) {
          return `{\\c${highlightAss}\\fscx108\\fscy108}${escaped}{\\c${primaryAss}\\fscx100\\fscy100}`
        }
        const cleanTok = w.word.replace(/[^a-zA-Z0-9$%]/g, '')
        if (UPPER_ACRONYM_RE.test(cleanTok) || IMPORTANT_WORD_RE.test(cleanTok)) {
          return `{\\b1}${escaped}`
        }
        return escaped
      })

      const prefix = alignment !== 2 ? `{\\an${alignment}}` : ''
      events.push(
        `Dialogue: 0,${formatAssTime(sliceStart)},${formatAssTime(sliceEnd)},Default,,0,0,${marginV},,${prefix}${renderedWords.join(wordJoiner)}`
      )
    }
  }

  return `${header}\n${events.join('\n')}\n`
}

export async function writeClipAssFile(params: {
  outAssPath: string
  words: TranscriptWord[]
  fallbackText?: string
  clipStartSec: number
  clipEndSec: number
  config: SubtitleConfig
  tracking?: ClipTrackingResult | null
  dubbedLanguage?: string | null
}): Promise<string> {
  await ensureDir(path.dirname(params.outAssPath))
  const phrases = buildSubtitlePhrases({
    words: params.words,
    fallbackText: params.fallbackText,
    clipStartSec: params.clipStartSec,
    clipEndSec: params.clipEndSec,
    maxWordsPerLine: params.config.maxWordsPerLine
  })
  const ass = generateAssSubtitleContent({
    phrases,
    config: params.config,
    tracking: params.tracking,
    dubbedLanguage: params.dubbedLanguage
  })
  await writeFile(params.outAssPath, ass, 'utf8')
  return params.outAssPath
}

