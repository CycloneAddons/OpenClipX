import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'
import { env } from '../config/env.ts'
import type {
  CompositionMode,
  ScoringWeights,
  SpeakerGender,
  TranscriptSegment,
  VisualAnalysisSummary
} from '../types/index.ts'
import { log } from '../utils/logger.ts'
import { getAdaptiveProcessingProfile } from '../utils/memoryMonitor.ts'

export interface AiCapabilitiesReport {
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
  checkedAt: string
}

export interface AiRawClipCandidate {
  startSec: number
  endSec: number
  title: string
  description: string
  hook: string
  reason: string
  engagementPotential: 'high' | 'medium' | 'experimental'
  scores: {
    hookStrength: number
    storyCompleteness: number
    emotionalImpact: number
    informationValue: number
    audienceInterest: number
    endingPayoff: number
    visualQuality: number
  }
}

let cachedCapabilities: AiCapabilitiesReport | null = null

export function createOpenAiClient(apiKeyOverride?: string, baseUrlOverride?: string): OpenAI | null {
  const apiKey = (apiKeyOverride ?? env.ai.apiKey).trim()
  if (!apiKey) return null
  const baseURL = (baseUrlOverride ?? env.ai.baseUrl).replace(/\/+$/, '')
  return new OpenAI({
    apiKey,
    baseURL,
    timeout: 55_000,
    maxRetries: 1
  })
}

function buildModelFallbackList(
  primary: string,
  available: string[],
  preferVision: boolean
): string[] {
  const ordered = [primary]
  if (available.length === 0) return ordered
  const pool = available.filter(
    (m) =>
      m !== primary &&
      !/embed|whisper|tts|moderation|dall-e/i.test(m) &&
      (!preferVision || /vision|4o|gemini|claude|vl|multimodal/i.test(m))
  )
  // Prefer fast flash/sonnet models first as resilient fallbacks
  pool.sort((a, b) => {
    const score = (id: string) =>
      /flash/i.test(id) && !/medium|thinking/i.test(id)
        ? 0
        : /sonnet/i.test(id) && !/thinking/i.test(id)
          ? 1
          : 2
    return score(a) - score(b)
  })
  return ordered.concat(pool.slice(0, 2))
}

function pickModelFromAvailable(
  available: string[],
  configured: string,
  preferVision: boolean
): string | null {
  if (configured && available.includes(configured)) {
    return configured
  }
  if (configured && available.length === 0) {
    return configured
  }
  if (available.length === 0) return null

  if (preferVision) {
    const visionCandidate = available.find((m) =>
      /vision|4o|gemini|claude|vl|multimodal/i.test(m)
    )
    if (visionCandidate) return visionCandidate
  }
  const chatCandidate = available.find((m) => !/embed|whisper|tts|moderation|dall-e/i.test(m))
  return chatCandidate ?? available[0] ?? null
}

export async function inspectAiCapabilities(forceRefresh = false): Promise<AiCapabilitiesReport> {
  if (cachedCapabilities && !forceRefresh) {
    return cachedCapabilities
  }

  const baseUrl = env.ai.baseUrl
  const client = createOpenAiClient()
  if (!client) {
    const report: AiCapabilitiesReport = {
      configured: false,
      baseUrl,
      reachable: false,
      availableModels: [],
      selectedModel: env.ai.model || null,
      selectedVisionModel: env.ai.visionModel || null,
      supportsChatCompletions: false,
      supportsStructuredOutputs: false,
      supportsVision: false,
      supportsTranscription: false,
      error: 'AI_API_KEY is not set in environment; local heuristic analysis will be used.',
      checkedAt: new Date().toISOString()
    }
    cachedCapabilities = report
    return report
  }

  try {
    const modelsPage = await client.models.list()
    const availableModels = modelsPage.data.map((m) => m.id).filter(Boolean)
    const selectedModel = pickModelFromAvailable(availableModels, env.ai.model, false)
    const selectedVisionModel = pickModelFromAvailable(
      availableModels,
      env.ai.visionModel || env.ai.model,
      true
    )

    let supportsChatCompletions = false
    let supportsStructuredOutputs = false
    let supportsVision = false
    let supportsTranscription = false

    // Verify lightweight chat completion capability if a model exists
    if (selectedModel) {
      try {
        const res = await client.chat.completions.create({
          model: selectedModel,
          messages: [{ role: 'user', content: 'Respond with JSON: {"ok":true}' }],
          response_format: { type: 'json_object' },
          max_tokens: 1024,
          temperature: 0
        })
        const content = res.choices[0]?.message?.content || ''
        supportsChatCompletions = content.length > 0
        try {
          const parsed = parseJsonFromLlm(content) as { ok?: boolean }
          supportsStructuredOutputs = Boolean(parsed)
        } catch {
          supportsStructuredOutputs = false
        }
      } catch {
        // Retry without response_format to separate chat vs json_object support
        try {
          const res = await client.chat.completions.create({
            model: selectedModel,
            messages: [{ role: 'user', content: 'Say OK' }],
            max_tokens: 512,
            temperature: 0
          })
          supportsChatCompletions = Boolean(res.choices[0]?.message?.content)
        } catch {
          supportsChatCompletions = false
        }
      }
    }

    // Verify vision support with a tiny PNG only if a vision model exists
    if (selectedVisionModel) {
      try {
        const tinyPng =
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
        const visRes = await client.chat.completions.create({
          model: selectedVisionModel,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Reply with one word: visible' },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${tinyPng}`, detail: 'low' }
                }
              ]
            }
          ],
          max_tokens: 512,
          temperature: 0
        })
        supportsVision = Boolean(visRes.choices[0]?.message?.content)
      } catch {
        supportsVision = false
      }
    }

    supportsTranscription = availableModels.some((m) => /whisper|transcribe/i.test(m))

    const report: AiCapabilitiesReport = {
      configured: true,
      baseUrl,
      reachable: true,
      availableModels,
      selectedModel,
      selectedVisionModel,
      supportsChatCompletions,
      supportsStructuredOutputs,
      supportsVision,
      supportsTranscription,
      error: null,
      checkedAt: new Date().toISOString()
    }
    cachedCapabilities = report
    return report
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('warn', 'AIClient', `Capability probe failed: ${message}`)
    const report: AiCapabilitiesReport = {
      configured: true,
      baseUrl,
      reachable: false,
      availableModels: [],
      selectedModel: env.ai.model || null,
      selectedVisionModel: env.ai.visionModel || null,
      supportsChatCompletions: false,
      supportsStructuredOutputs: false,
      supportsVision: false,
      supportsTranscription: false,
      error: message,
      checkedAt: new Date().toISOString()
    }
    cachedCapabilities = report
    return report
  }
}

function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (escape) {
      out += ch
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      out += ch
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      out += ch
      continue
    }
    if (!inString && ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] === '}' || text[j] === ']') {
        continue
      }
    }
    out += ch
  }
  return out
}

function tryJsonParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    try {
      return { ok: true, value: JSON.parse(stripTrailingCommas(text)) }
    } catch {
      return { ok: false }
    }
  }
}

function parseFirstValidBalancedJson(
  text: string,
  predicate?: (val: unknown) => boolean
): unknown | null {
  for (let offset = 0; offset < text.length; offset++) {
    const ch0 = text[offset]
    if (ch0 !== '{' && ch0 !== '[') continue

    const stack: string[] = [ch0]
    let inString = false
    let escape = false
    let end = -1

    for (let i = offset + 1; i < text.length; i++) {
      const ch = text[i]!
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\' && inString) {
        escape = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue

      if (ch === '{' || ch === '[') {
        stack.push(ch)
      } else if (ch === '}' || ch === ']') {
        const top = stack[stack.length - 1]
        if ((ch === '}' && top === '{') || (ch === ']' && top === '[')) {
          stack.pop()
          if (stack.length === 0) {
            end = i
            break
          }
        } else {
          break
        }
      }
    }

    if (end !== -1) {
      const candidate = tryJsonParse(text.slice(offset, end + 1))
      if (candidate.ok && (!predicate || predicate(candidate.value))) {
        return candidate.value
      }
    }
  }
  return null
}

function recoverTruncatedArrayPayload(text: string): unknown | null {
  const keyMatch = text.match(/"(clips|segments|turns|speakers)"\s*:\s*\[/i)
  let arrayStart = -1
  let targetKey: string | null = null

  if (keyMatch && keyMatch.index !== undefined) {
    targetKey = keyMatch[1]!.toLowerCase()
    arrayStart = keyMatch.index + keyMatch[0].length
  } else {
    const firstBracket = text.indexOf('[')
    if (firstBracket !== -1) {
      arrayStart = firstBracket + 1
    }
  }

  if (arrayStart === -1) return null

  const items: unknown[] = []
  let depth = 0
  let objStart = -1
  let inString = false
  let escape = false

  for (let i = arrayStart; i < text.length; i++) {
    const ch = text[i]!
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === '{') {
      if (depth === 0) objStart = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && objStart !== -1) {
          const parsedObj = tryJsonParse(text.slice(objStart, i + 1))
          if (parsedObj.ok) {
            items.push(parsedObj.value)
          }
          objStart = -1
        }
      }
    } else if (ch === ']' && depth === 0) {
      break
    }
  }

  if (items.length === 0) return null
  return targetKey ? { [targetKey]: items } : items
}

export function parseJsonFromLlm(raw: string): unknown {
  // Remove hidden reasoning tags if an OpenAI-compatible proxy inlines them
  let cleaned = raw
    .replace(/<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>/gi, '')
    .trim()

  const closedFence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (closedFence?.[1]) {
    cleaned = closedFence[1].trim()
  } else {
    // Handle truncated outputs where opening ```json fence never closed (even after prose)
    const unclosedFence = cleaned.match(/```(?:json)?\s*([\s\S]*)$/i)
    if (unclosedFence?.[1]) {
      cleaned = unclosedFence[1].replace(/```\s*$/, '').trim()
    }
  }

  if (!cleaned) {
    throw new Error('Model response was empty')
  }

  const direct = tryJsonParse(cleaned)
  if (direct.ok) return direct.value

  if (/"(clips|segments|turns|speakers)"\s*:\s*\[/i.test(cleaned)) {
    const fullWithKey = parseFirstValidBalancedJson(
      cleaned,
      (val) =>
        Boolean(
          val &&
            typeof val === 'object' &&
            !Array.isArray(val) &&
            ('clips' in val || 'segments' in val || 'turns' in val || 'speakers' in val)
        )
    )
    if (fullWithKey !== null) return fullWithKey

    const recovered = recoverTruncatedArrayPayload(cleaned)
    if (recovered) return recovered
  }

  if (cleaned.startsWith('[')) {
    const fullArray = parseFirstValidBalancedJson(cleaned, (val) => Array.isArray(val))
    if (fullArray !== null) return fullArray

    const recovered = recoverTruncatedArrayPayload(cleaned)
    if (recovered) return recovered
  }

  const balanced = parseFirstValidBalancedJson(cleaned)
  if (balanced !== null) return balanced

  const recovered = recoverTruncatedArrayPayload(cleaned)
  if (recovered) return recovered

  throw new Error('Model response did not contain valid JSON')
}

export function normalizeAiClipCandidate(raw: unknown): AiRawClipCandidate | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const startSec = Number(c.startSec)
  const endSec = Number(c.endSec)
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return null
  }

  const rawScores = (c.scores && typeof c.scores === 'object' ? c.scores : {}) as Record<
    string,
    unknown
  >
  const keys = [
    'hookStrength',
    'storyCompleteness',
    'emotionalImpact',
    'informationValue',
    'audienceInterest',
    'endingPayoff',
    'visualQuality'
  ] as const

  const numericEntries = keys
    .map((k) => Number(rawScores[k]))
    .filter((v) => Number.isFinite(v))

  // Some LLMs still score 0-10 (e.g. 9.2) despite asking for 0-100 integers; scale cleanly
  const scaleMultiplier =
    numericEntries.length >= 3 &&
    numericEntries.every((v) => v > 0 && v <= 10)
      ? 10
      : 1

  const readScore = (k: (typeof keys)[number], fallback = 70) => {
    const val = Number(rawScores[k])
    if (!Number.isFinite(val)) return fallback
    return Math.max(0, Math.min(100, Math.round(val * scaleMultiplier * 10) / 10))
  }

  const pot = String(c.engagementPotential || 'medium').toLowerCase()
  const engagementPotential: AiRawClipCandidate['engagementPotential'] =
    pot === 'high' || pot === 'experimental' ? pot : 'medium'

  return {
    startSec,
    endSec,
    title: typeof c.title === 'string' && c.title.trim() ? c.title.trim() : 'Untitled Moment',
    description: typeof c.description === 'string' ? c.description.trim() : '',
    hook: typeof c.hook === 'string' ? c.hook.trim() : '',
    reason: typeof c.reason === 'string' ? c.reason.trim() : '',
    engagementPotential,
    scores: {
      hookStrength: readScore('hookStrength'),
      storyCompleteness: readScore('storyCompleteness'),
      emotionalImpact: readScore('emotionalImpact'),
      informationValue: readScore('informationValue'),
      audienceInterest: readScore('audienceInterest'),
      endingPayoff: readScore('endingPayoff'),
      visualQuality: readScore('visualQuality', 75)
    }
  }
}

export async function analyzeSampledFramesWithAI(params: {
  frames: Array<{ timestampSec: number; base64Jpeg: string }>
  videoTitle: string
  visionModelOverride?: string
  projectId?: string
}): Promise<VisualAnalysisSummary | null> {
  const profile = getAdaptiveProcessingProfile()
  if (!profile.allowVisionAnalysis) {
    log('warn', 'AIClient', `Skipping cloud vision analysis due to memory pressure (${profile.pressure})`, params.projectId)
    return null
  }

  const client = createOpenAiClient()
  if (!client || params.frames.length === 0) return null

  const caps = await inspectAiCapabilities()
  const model = params.visionModelOverride?.trim() || caps.selectedVisionModel
  if (!model || !caps.reachable) return null

  const candidateModels = buildModelFallbackList(model, caps.availableModels, true)
  const frameSubset = params.frames.slice(0, 6)
  const contentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: 'text',
      text: [
        `Analyze these ${frameSubset.length} sampled keyframes from the video "${params.videoTitle}".`,
        'Return a strict JSON object with keys:',
        '- contentType: one of "podcast", "interview", "presentation", "tutorial", "gaming", "vlog", "monologue", "other"',
        '- compositionRecommendation: one of "single", "dual", "smart"',
        '- importantVisualElements: array of short strings describing on-screen objects/slides/whiteboards/hosts that should not be cropped awkwardly',
        '- notes: concise 1-2 sentence editing guidance for 9:16 vertical reframing.'
      ].join('\n')
    }
  ]

  for (const f of frameSubset) {
    contentParts.push({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${f.base64Jpeg}`,
        detail: 'low'
      }
    })
  }

  for (const m of candidateModels) {
    try {
      const res = await client.chat.completions.create({
        model: m,
        messages: [{ role: 'user', content: contentParts }],
        ...(caps.supportsStructuredOutputs ? { response_format: { type: 'json_object' } } : {}),
        max_tokens: 2048,
        temperature: 0.2
      })

      const raw = res.choices[0]?.message?.content || ''
      const parsed = parseJsonFromLlm(raw) as {
        contentType?: string
        compositionRecommendation?: CompositionMode
        importantVisualElements?: string[]
        notes?: string
      }

      const validComp: CompositionMode =
        parsed.compositionRecommendation === 'single' ||
        parsed.compositionRecommendation === 'dual' ||
        parsed.compositionRecommendation === 'smart'
          ? parsed.compositionRecommendation
          : 'smart'

      return {
        contentType: parsed.contentType || 'other',
        compositionRecommendation: validComp,
        importantVisualElements: Array.isArray(parsed.importantVisualElements)
          ? parsed.importantVisualElements.map(String).slice(0, 8)
          : [],
        notes: parsed.notes || '',
        analyzedFramesCount: frameSubset.length,
        modelUsed: m
      }
    } catch (err) {
      log(
        'warn',
        'AIClient',
        `Vision analysis attempt with ${m} failed: ${(err as Error).message}`,
        params.projectId
      )
    }
  }
  return null
}

export async function discoverViralMomentsWithAI(params: {
  segments: TranscriptSegment[]
  videoTitle: string
  durationSec: number
  minDurationSec: number
  maxDurationSec: number
  targetClipCount: number
  weights: ScoringWeights
  visualSummary?: VisualAnalysisSummary | null
  modelOverride?: string
  projectId?: string
}): Promise<AiRawClipCandidate[]> {
  const client = createOpenAiClient()
  if (!client || params.segments.length === 0) return []

  const caps = await inspectAiCapabilities()
  const model = params.modelOverride?.trim() || caps.selectedModel
  if (!model || !caps.reachable) return []

  const candidateModels = buildModelFallbackList(model, caps.availableModels, false)

  // Partition transcript into bounded windows (~3400 chars each, overlapping by 2 segments)
  // Keeping windows compact avoids hitting output/thinking token limits on reasoning models
  const windows: TranscriptSegment[][] = []
  let current: TranscriptSegment[] = []
  let currentChars = 0

  for (let i = 0; i < params.segments.length; i++) {
    const seg = params.segments[i]!
    const lineLen = seg.text.length + 20
    if (current.length > 0 && currentChars + lineLen > 3400) {
      windows.push(current)
      current = current.slice(-2)
      currentChars = current.reduce((sum, s) => sum + s.text.length + 20, 0)
    }
    current.push(seg)
    currentChars += lineLen
  }
  if (current.length > 0) windows.push(current)

  const candidates: AiRawClipCandidate[] = []
  const perWindowAsk = Math.min(
    3,
    Math.max(2, Math.ceil((params.targetClipCount + 2) / Math.max(1, windows.length)))
  )

  for (let wIdx = 0; wIdx < windows.length; wIdx++) {
    const win = windows[wIdx]!
    const transcriptBlock = win
      .map((s) => `[${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s] ${s.text}`)
      .join('\n')

    const prompt = [
      `You are an expert short-form video editor identifying standout, self-contained moments from "${params.videoTitle}".`,
      `The transcript may contain English, Hindi/Hinglish, or mixed ASR text — understand its real meaning across languages and write compelling English titles, hooks, and reasons.`,
      params.visualSummary
        ? `Visual context: type=${params.visualSummary.contentType}; guidance=${params.visualSummary.notes}; key elements=${params.visualSummary.importantVisualElements.join(', ')}`
        : '',
      `Constraints:`,
      `- Find up to ${perWindowAsk} high-potential standalone clips from this transcript excerpt.`,
      `- Each clip duration MUST be between ${params.minDurationSec}s and ${params.maxDurationSec}s.`,
      `- Start on a strong hook or question/bold claim; end on a clear payoff, punchline, or complete takeaway.`,
      `- NEVER pick channel intros or outros ('like, share, subscribe, bell notification, see you next time'). Focus on core storytelling, astonishing facts, dramatic reveals, or Q&A peaks.`,
      `- Never cut mid-sentence. Only use timestamps present inside this transcript window.`,
      `- Keep description, hook, and reason concise (1 sentence each, <= 20 words) and avoid unescaped double quotes inside strings.`,
      `- Score EVERY dimension as an INTEGER from 0 to 100 (e.g. 88, NOT 8.8): hookStrength (weight ${params.weights.hookStrength}), storyCompleteness (weight ${params.weights.storyCompleteness}), emotionalImpact (weight ${params.weights.emotionalImpact}), informationValue (weight ${params.weights.informationValue}), audienceInterest (weight ${params.weights.audienceInterest}), endingPayoff (weight ${params.weights.endingPayoff}), visualQuality (weight ${params.weights.visualQuality}).`,
      `Return ONLY raw valid JSON (no markdown code fences): { "clips": [ { "startSec": number, "endSec": number, "title": string, "description": string, "hook": string, "reason": string, "engagementPotential": "high"|"medium"|"experimental", "scores": { "hookStrength": number, "storyCompleteness": number, "emotionalImpact": number, "informationValue": number, "audienceInterest": number, "endingPayoff": number, "visualQuality": number } } ] }`,
      `\nTranscript:\n${transcriptBlock}`
    ]
      .filter(Boolean)
      .join('\n')

    let windowSolved = false
    for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
      const m = candidateModels[mIdx]!
      try {
        const res = await client.chat.completions.create({
          model: m,
          messages: [{ role: 'user', content: prompt }],
          ...(caps.supportsStructuredOutputs ? { response_format: { type: 'json_object' } } : {}),
          max_tokens: 4096,
          temperature: 0.2
        })
        const raw = res.choices[0]?.message?.content || ''
        const parsed = parseJsonFromLlm(raw) as { clips?: unknown[] } | unknown[]
        const rawClips = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.clips)
            ? parsed.clips
            : null

        if (rawClips) {
          for (const item of rawClips) {
            const normalized = normalizeAiClipCandidate(item)
            if (normalized) {
              candidates.push(normalized)
            }
          }
          if (mIdx > 0) {
            log(
              'info',
              'AIClient',
              `Transcript window ${wIdx + 1}/${windows.length} succeeded with fallback model ${m}`,
              params.projectId
            )
          }
          windowSolved = true
          break
        }
        throw new Error('JSON parsed without a clips array')
      } catch (err) {
        log(
          'warn',
          'AIClient',
          `Transcript window ${wIdx + 1}/${windows.length} with ${m} failed: ${(err as Error).message}`,
          params.projectId
        )
      }
    }
    if (!windowSolved) {
      log(
        'warn',
        'AIClient',
        `Transcript window ${wIdx + 1}/${windows.length} using local heuristic fallback`,
        params.projectId
      )
    }
  }

  return candidates
}

export async function polishClipCaptionsWithAI(params: {
  segments: TranscriptSegment[]
  detectedLanguage: string
  videoTitle: string
  clipStartSec?: number
  clipEndSec?: number
  modelOverride?: string
  projectId?: string
}): Promise<{ words: import('../types/index.ts').TranscriptWord[]; transcriptText: string } | null> {
  if (params.segments.length === 0) return null
  const avgProb =
    params.segments.reduce((s, seg) => s + (seg.probability ?? 0.8), 0) / params.segments.length
  const combined = params.segments.map((s) => s.text).join(' ')
  const hasNonAscii = /[^\x20-\x7E]/.test(combined)
  const needsPolish = params.detectedLanguage !== 'en' || hasNonAscii || avgProb < 0.55
  if (!needsPolish) return null

  const client = createOpenAiClient()
  if (!client) return null
  const caps = await inspectAiCapabilities()
  const model = params.modelOverride?.trim() || caps.selectedModel
  if (!model || !caps.reachable) return null

  const indexed = params.segments.slice(0, 50).map((s, idx) => ({
    idx,
    start: Number(s.start.toFixed(2)),
    end: Number(s.end.toFixed(2)),
    text: s.text
  }))

  const prompt = [
    `You are editing English subtitles for a vertical YouTube Short from "${params.videoTitle}" (detected audio language: ${params.detectedLanguage}).`,
    `Proofread and refine the Whisper ASR/translated segments below into crisp, natural, punchy English subtitles suitable for vertical Shorts viewers.`,
    `Fix literal machine-translation slips, Hinglish phrasing, or domain terms using context from the segment and video title without adding unrelated claims.`,
    `Preserve all numbers, years, dates, and proper nouns verbatim from the input text (do not change years like 2007 to 2017).`,
    `Keep each rewritten caption faithful to its segment's timing and concise (ideally <= 12 words per segment so captions flow fast on mobile).`,
    `Return strict JSON: { "segments": [ { "idx": number, "text": string } ] } covering every idx.`,
    `Input segments:`,
    JSON.stringify(indexed)
  ].join('\n')

  for (const m of buildModelFallbackList(model, caps.availableModels, false)) {
    try {
      const res = await client.chat.completions.create({
        model: m,
        messages: [{ role: 'user', content: prompt }],
        ...(caps.supportsStructuredOutputs ? { response_format: { type: 'json_object' } } : {}),
        max_tokens: 4096,
        temperature: 0.2
      })
      const parsed = parseJsonFromLlm(res.choices[0]?.message?.content || '') as {
        segments?: Array<{ idx?: number; text?: string }>
      }
      if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) continue

      const mapByIdx = new Map<number, string>()
      for (const item of parsed.segments) {
        if (typeof item.idx === 'number' && typeof item.text === 'string' && item.text.trim()) {
          mapByIdx.set(item.idx, item.text.trim())
        }
      }

      const words: import('../types/index.ts').TranscriptWord[] = []
      const textParts: string[] = []
      for (let idx = 0; idx < params.segments.length; idx++) {
        const seg = params.segments[idx]!
        const line = mapByIdx.get(idx) || seg.text.trim()
        if (!line) continue
        const clampedStart = Math.max(params.clipStartSec ?? seg.start, seg.start)
        const clampedEnd = Math.min(params.clipEndSec ?? seg.end, seg.end)
        const overlapRatio = (clampedEnd - clampedStart) / Math.max(0.1, seg.end - seg.start)
        if (clampedEnd <= clampedStart + 0.25 || (overlapRatio < 0.45 && clampedEnd - clampedStart < 1.2)) {
          continue
        }

        textParts.push(line)
        const tokens = line.split(/\s+/).filter(Boolean)
        if (tokens.length === 0) continue

        const segDur = Math.max(0.2, clampedEnd - clampedStart)
        const totalChars = tokens.reduce((sum, t) => sum + Math.max(2, t.length), 0)
        let cursor = clampedStart
        for (const tok of tokens) {
          const frac = Math.max(2, tok.length) / totalChars
          const wDur = segDur * frac
          words.push({
            word: tok,
            start: Math.round(cursor * 1000) / 1000,
            end: Math.round(Math.min(clampedEnd, cursor + wDur) * 1000) / 1000,
            probability: 0.92
          })
          cursor += wDur
        }
      }

      if (words.length > 0) {
        return { words, transcriptText: textParts.join(' ') }
      }
    } catch (err) {
      log('warn', 'AIClient', `Subtitle polish attempt with ${m} failed: ${(err as Error).message}`, params.projectId)
    }
  }
  return null
}

export interface VisualSpeakerGenderResult {
  trackId: number
  gender: SpeakerGender
  confidence: number
  styleHint?: string
}

export async function inspectSpeakerGendersWithVision(params: {
  snapshots: Array<{ trackId: number; base64Jpeg: string }>
  videoTitle: string
  visionModelOverride?: string
  projectId?: string
}): Promise<Map<number, VisualSpeakerGenderResult>> {
  const result = new Map<number, VisualSpeakerGenderResult>()
  if (params.snapshots.length === 0) return result

  const profile = getAdaptiveProcessingProfile()
  if (!profile.allowVisionAnalysis) {
    return result
  }

  const subset = params.snapshots.slice(0, 4)
  const promptText = [
    `Inspect these ${subset.length} cropped speaker portraits from the video "${params.videoTitle}".`,
    `For each labeled face track, classify the speaker's likely perceived vocal gender ("male" or "female", or "unknown" only if completely obscured/non-human) so we can match a natural TTS voice.`,
    `Also give a short speaking styleHint (2-4 words like "confident conversational host" or "warm calm expert").`,
    `Return ONLY valid JSON: { "speakers": [ { "trackId": number, "gender": "male"|"female"|"unknown", "confidence": number, "styleHint": string } ] }`
  ].join('\n')

  const applyParsed = (raw: string): boolean => {
    const parsed = parseJsonFromLlm(raw) as {
      speakers?: Array<{
        trackId?: number
        gender?: string
        confidence?: number
        styleHint?: string
      }>
    }
    if (!Array.isArray(parsed?.speakers) || parsed.speakers.length === 0) return false
    for (const sp of parsed.speakers) {
      const tid = Number(sp.trackId)
      if (!Number.isFinite(tid)) continue
      const g = String(sp.gender || '').toLowerCase()
      const gender: SpeakerGender = g === 'male' || g === 'female' ? g : 'unknown'
      const conf = Number.isFinite(Number(sp.confidence))
        ? Math.max(0.1, Math.min(1, Number(sp.confidence)))
        : gender === 'unknown'
          ? 0.2
          : 0.78
      result.set(tid, {
        trackId: tid,
        gender,
        confidence: conf,
        styleHint: typeof sp.styleHint === 'string' ? sp.styleHint.trim().slice(0, 60) : undefined
      })
    }
    return result.size > 0
  }

  const client = createOpenAiClient()
  if (client) {
    const caps = await inspectAiCapabilities()
    const model = params.visionModelOverride?.trim() || caps.selectedVisionModel
    if (model && caps.reachable) {
      const contentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
        { type: 'text', text: promptText }
      ]
      for (const snap of subset) {
        contentParts.push({ type: 'text', text: `Face Track ID#${snap.trackId}:` })
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${snap.base64Jpeg}`,
            detail: 'low'
          }
        })
      }

      for (const m of buildModelFallbackList(model, caps.availableModels, true)) {
        try {
          const res = await client.chat.completions.create({
            model: m,
            messages: [{ role: 'user', content: contentParts }],
            ...(caps.supportsStructuredOutputs ? { response_format: { type: 'json_object' } } : {}),
            max_tokens: 1024,
            temperature: 0.1
          })
          const raw = res.choices[0]?.message?.content || ''
          if (applyParsed(raw)) return result
        } catch (err) {
          log(
            'warn',
            'AIClient',
            `Speaker visual gender check with ${m} failed: ${(err as Error).message}`,
            params.projectId
          )
        }
      }
    }
  }

  // Fallback to Gemini Developer API vision if configured and OpenAI vision proxy wasn't available
  if (env.gemini.apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey: env.gemini.apiKey, apiVersion: 'v1beta' })
      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
        { text: promptText }
      ]
      for (const snap of subset) {
        parts.push({ text: `Face Track ID#${snap.trackId}:` })
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: snap.base64Jpeg } })
      }
      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts }],
        config: { temperature: 0.1, responseMimeType: 'application/json' }
      })
      const raw = res.text || ''
      if (raw && applyParsed(raw)) return result
    } catch (err) {
      log(
        'warn',
        'AIClient',
        `Gemini vision gender fallback failed: ${(err as Error).message}`,
        params.projectId
      )
    }
  }

  return result
}

export interface DiarizationTurnInput {
  idx: number
  startSec: number
  endSec: number
  text: string
  f0Hz?: number | null
  acousticGender?: SpeakerGender
  linkedTrackId?: number | null
  visualGender?: SpeakerGender
  visualStyleHint?: string
}

export interface AiDiarizedSpeaker {
  speakerId: string
  label?: string
  gender: SpeakerGender
  confidence: number
  linkedTrackId?: number | null
  styleHint?: string
}

export interface AiDiarizedTurn {
  idx: number
  speakerId: string
  translatedText: string
  style?: string
}

export async function diarizeAndTranslateClipWithAI(params: {
  turns: DiarizationTurnInput[]
  videoTitle: string
  contentType?: string
  targetLanguageCode: string
  targetLanguageName: string
  modelOverride?: string
  projectId?: string
}): Promise<{ speakers: AiDiarizedSpeaker[]; turns: AiDiarizedTurn[] } | null> {
  if (params.turns.length === 0) return null

  const prompt = [
    `You are an expert AI video dubbing director & translator for a short clip from "${params.videoTitle}".`,
    params.contentType ? `Content type: ${params.contentType}.` : '',
    `Task 1 (Multi-Speaker Diarization & Gender): Group consecutive/related turns into consistent speakers named "Speaker 1", "Speaker 2", etc. using conversational context (Q&A, replies, topic shifts), linked face track IDs ("linkedTrackId"), visual appearance hints ("visualGender"), and measured acoustic pitch ("f0Hz", where typically adult male fundamental pitch is ~85-155 Hz and adult female is ~165-260 Hz). Classify every speaker's gender as "male" or "female" ("unknown" only if truly indeterminate).`,
    `Task 2 (Duration-Matched Translation): Translate EVERY turn from English into natural spoken ${params.targetLanguageName} (code: ${params.targetLanguageCode}). Keep translations concise and punchy so they match the clip duration budget ([startSec..endSec]) cleanly without speaking too fast. Preserve brand/product/person names naturally. Provide a brief 2-4 word voice style directive per turn in "style" (e.g. "warm conversational", "excited emphasis").`,
    `Return ONLY strict JSON (no markdown fences):`,
    `{ "speakers": [ { "speakerId": "Speaker 1", "label": "Host", "gender": "male"|"female"|"unknown", "confidence": 0.9, "linkedTrackId": number|null, "styleHint": string } ], "turns": [ { "idx": number, "speakerId": "Speaker 1", "translatedText": string, "style": string } ] }`,
    `Cover EVERY input idx.`,
    `Input turns:`,
    JSON.stringify(params.turns)
  ]
    .filter(Boolean)
    .join('\n')

  const parseResult = (
    raw: string
  ): { speakers: AiDiarizedSpeaker[]; turns: AiDiarizedTurn[] } | null => {
    const parsed = parseJsonFromLlm(raw) as {
      speakers?: Array<Record<string, unknown>>
      turns?: Array<Record<string, unknown>>
    }
    if (!Array.isArray(parsed?.turns) || parsed.turns.length === 0) return null

    const turns: AiDiarizedTurn[] = []
    for (const item of parsed.turns) {
      const idx = Number(item.idx)
      const translatedText =
        typeof item.translatedText === 'string' ? item.translatedText.trim() : ''
      if (!Number.isFinite(idx) || !translatedText) continue
      const speakerId =
        typeof item.speakerId === 'string' && item.speakerId.trim()
          ? item.speakerId.trim()
          : 'Speaker 1'
      const style = typeof item.style === 'string' && item.style.trim() ? item.style.trim().slice(0, 60) : undefined
      turns.push({ idx, speakerId, translatedText, style })
    }
    if (turns.length === 0) return null

    const speakers: AiDiarizedSpeaker[] = []
    if (Array.isArray(parsed.speakers)) {
      for (const sp of parsed.speakers) {
        const speakerId =
          typeof sp.speakerId === 'string' && sp.speakerId.trim() ? sp.speakerId.trim() : ''
        if (!speakerId) continue
        const rawGender = String(sp.gender || '').toLowerCase()
        const gender: SpeakerGender =
          rawGender === 'male' || rawGender === 'female' ? rawGender : 'unknown'
        const confidence = Number.isFinite(Number(sp.confidence))
          ? Math.max(0.1, Math.min(1, Number(sp.confidence)))
          : 0.75
        speakers.push({
          speakerId,
          label: typeof sp.label === 'string' ? sp.label.trim().slice(0, 40) : undefined,
          gender,
          confidence,
          linkedTrackId:
            sp.linkedTrackId != null && Number.isFinite(Number(sp.linkedTrackId))
              ? Number(sp.linkedTrackId)
              : null,
          styleHint:
            typeof sp.styleHint === 'string' ? sp.styleHint.trim().slice(0, 60) : undefined
        })
      }
    }
    return { speakers, turns }
  }

  const client = createOpenAiClient()
  if (client) {
    const caps = await inspectAiCapabilities()
    const model = params.modelOverride?.trim() || caps.selectedModel
    if (model && caps.reachable) {
      for (const m of buildModelFallbackList(model, caps.availableModels, false)) {
        try {
          const res = await client.chat.completions.create({
            model: m,
            messages: [{ role: 'user', content: prompt }],
            ...(caps.supportsStructuredOutputs ? { response_format: { type: 'json_object' } } : {}),
            max_tokens: 4096,
            temperature: 0.2
          })
          const raw = res.choices[0]?.message?.content || ''
          const parsed = parseResult(raw)
          if (parsed) return parsed
        } catch (err) {
          log(
            'warn',
            'AIClient',
            `Dub diarization/translation with ${m} failed: ${(err as Error).message}`,
            params.projectId
          )
        }
      }
    }
  }

  if (env.gemini.apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey: env.gemini.apiKey, apiVersion: 'v1beta' })
      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { temperature: 0.2, responseMimeType: 'application/json' }
      })
      const raw = res.text || ''
      if (raw) {
        const parsed = parseResult(raw)
        if (parsed) return parsed
      }
    } catch (err) {
      log(
        'warn',
        'AIClient',
        `Gemini text diarization/translation fallback failed: ${(err as Error).message}`,
        params.projectId
      )
    }
  }

  return null
}

