import { existsSync } from 'node:fs'
import { execFile, type ChildProcess } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { GoogleGenAI, type MultiSpeakerVoiceConfig } from '@google/genai'
import mime from 'mime'
import { env } from '../config/env.ts'
import type {
  DubbingPlan,
  DubSpeakerProfile,
  DubTurnSegment,
  TranscriptWord
} from '../types/index.ts'
import { ensureDir } from '../utils/fsSafe.ts'
import { log } from '../utils/logger.ts'
import { getAdaptiveProcessingProfile } from '../utils/memoryMonitor.ts'
import { resolveFfmpegBin, resolveFfprobeBin, runCancellableSpawn } from './ffmpegService.ts'
import { getDubTargetLanguage, getVoiceEntry } from './voiceCatalog.ts'

const execFileAsync = promisify(execFile)

export interface WavConversionOptions {
  numChannels: number
  sampleRate: number
  bitsPerSample: number
}

export interface AudioStreamChunk {
  dataBase64: string
  mimeType?: string
}

export interface SynthesisBlock {
  index: number
  startSec: number
  endSec: number
  speakerIds: string[]
  turns: DubTurnSegment[]
}

export function parseAudioMimeType(mimeType: string): WavConversionOptions {
  const options: WavConversionOptions = {
    numChannels: 1,
    sampleRate: 24000,
    bitsPerSample: 16
  }
  if (!mimeType) return options

  const [fileType = '', ...params] = mimeType.split(';').map((s) => s.trim())
  const [, format = ''] = fileType.split('/')

  if (format.toUpperCase().startsWith('L')) {
    const bits = Number.parseInt(format.slice(1), 10)
    if (Number.isFinite(bits) && bits > 0) {
      options.bitsPerSample = bits
    }
  }

  for (const param of params) {
    const [key, value] = param.split('=').map((s) => s.trim())
    if (key === 'rate') {
      const rate = Number.parseInt(value ?? '', 10)
      if (Number.isFinite(rate) && rate > 0) {
        options.sampleRate = rate
      }
    } else if (key === 'channels') {
      const ch = Number.parseInt(value ?? '', 10)
      if (Number.isFinite(ch) && ch > 0) {
        options.numChannels = ch
      }
    }
  }

  return options
}

export function createWavHeader(dataByteLength: number, options: WavConversionOptions): Buffer {
  const { numChannels, sampleRate, bitsPerSample } = options
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const buffer = Buffer.alloc(44)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataByteLength, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataByteLength, 40)

  return buffer
}

function unwrapWavChunkIfRiff(
  buf: Buffer,
  fallbackOptions: WavConversionOptions
): { pcm: Buffer; options: WavConversionOptions; isRiff: boolean } {
  if (
    buf.length >= 44 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    let options = { ...fallbackOptions }
    let offset = 12
    let pcm: Buffer | null = null

    while (offset + 8 <= buf.length) {
      const chunkId = buf.subarray(offset, offset + 4).toString('ascii')
      const chunkSize = buf.readUInt32LE(offset + 4)
      const dataStart = offset + 8
      const dataEnd = Math.min(buf.length, dataStart + chunkSize)

      if (chunkId === 'fmt ' && chunkSize >= 16 && dataStart + 16 <= buf.length) {
        options = {
          numChannels: buf.readUInt16LE(dataStart + 2),
          sampleRate: buf.readUInt32LE(dataStart + 4),
          bitsPerSample: buf.readUInt16LE(dataStart + 14)
        }
      } else if (chunkId === 'data') {
        pcm = buf.subarray(dataStart, dataEnd)
        break
      }

      offset = dataStart + chunkSize + (chunkSize % 2)
    }

    if (pcm) {
      return { pcm, options, isRiff: true }
    }
  }
  return { pcm: buf, options: fallbackOptions, isRiff: false }
}

/**
 * Decodes streamed inlineData audio chunks cleanly:
 * - Combines raw PCM chunks (or unwraps streamed RIFF/WAV chunks) into one valid WAV buffer
 *   using exact byte count (`pcmBytes.length`) instead of base64 string length.
 * - Preserves encoded container responses (e.g., audio/mp3, audio/ogg) with proper extension.
 */
export function buildAudioBufferFromChunks(
  chunks: AudioStreamChunk[]
): { buffer: Buffer; extension: string } {
  if (chunks.length === 0) {
    throw new Error('Gemini TTS returned zero audio chunks')
  }

  const firstMime = chunks[0]?.mimeType || ''
  const firstBuf = Buffer.from(chunks[0]?.dataBase64 || '', 'base64')
  const isRiff =
    firstBuf.length >= 12 &&
    firstBuf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    firstBuf.subarray(8, 12).toString('ascii') === 'WAVE'

  const mimeExt = mime.getExtension(firstMime || '')
  const isRawPcm =
    !firstMime ||
    /^audio\/l\d+/i.test(firstMime) ||
    /audio\/(pcm|raw)/i.test(firstMime) ||
    !mimeExt

  if (!isRiff && !isRawPcm && mimeExt && mimeExt !== 'wav') {
    const rawBuffers = chunks
      .map((c) => Buffer.from(c.dataBase64 || '', 'base64'))
      .filter((b) => b.length > 0)
    return {
      buffer: Buffer.concat(rawBuffers),
      extension: mimeExt
    }
  }

  let resolvedOptions = parseAudioMimeType(firstMime)
  const pcmParts: Buffer[] = []

  for (const chunk of chunks) {
    if (!chunk.dataBase64) continue
    const decoded = Buffer.from(chunk.dataBase64, 'base64')
    if (decoded.length === 0) continue

    const chunkOpts = chunk.mimeType ? parseAudioMimeType(chunk.mimeType) : resolvedOptions
    const unwrapped = unwrapWavChunkIfRiff(decoded, chunkOpts)
    resolvedOptions = unwrapped.options
    if (unwrapped.pcm.length > 0) {
      pcmParts.push(unwrapped.pcm)
    }
  }

  const combinedPcm = Buffer.concat(pcmParts)
  if (combinedPcm.length === 0) {
    throw new Error('Gemini TTS returned empty audio payload')
  }

  const header = createWavHeader(combinedPcm.length, resolvedOptions)
  return {
    buffer: Buffer.concat([header, combinedPcm]),
    extension: 'wav'
  }
}

/**
 * Groups consecutive turns into synthesis blocks respecting:
 * 1. Gemini's MultiSpeakerVoiceConfig limit of at most 2 speakers per TTS request
 * 2. Pause boundaries > 0.75s
 * 3. Max ~16s span per synthesis block
 */
export function groupTurnsIntoSynthesisBlocks(turns: DubTurnSegment[]): SynthesisBlock[] {
  if (turns.length === 0) return []
  const sorted = [...turns].sort((a, b) => a.startSec - b.startSec)
  const blocks: SynthesisBlock[] = []

  let currentTurns: DubTurnSegment[] = []
  let currentSpeakers = new Set<string>()
  let blockStart = 0

  const flush = () => {
    if (currentTurns.length === 0) return
    const first = currentTurns[0]!
    const last = currentTurns[currentTurns.length - 1]!
    blocks.push({
      index: blocks.length,
      startSec: first.startSec,
      endSec: Math.max(first.startSec + 0.2, last.endSec),
      speakerIds: [...currentSpeakers],
      turns: currentTurns
    })
    currentTurns = []
    currentSpeakers = new Set<string>()
  }

  for (const turn of sorted) {
    if (!turn.translatedText.trim()) continue
    if (currentTurns.length === 0) {
      currentTurns = [turn]
      currentSpeakers.add(turn.speakerId)
      blockStart = turn.startSec
      continue
    }

    const prev = currentTurns[currentTurns.length - 1]!
    const gap = turn.startSec - prev.endSec
    const span = turn.endSec - blockStart
    const nextSpeakerCount = currentSpeakers.has(turn.speakerId)
      ? currentSpeakers.size
      : currentSpeakers.size + 1

    if (gap <= 1.25 && span <= 24.0 && nextSpeakerCount <= 2) {
      currentTurns.push(turn)
      currentSpeakers.add(turn.speakerId)
    } else {
      flush()
      currentTurns = [turn]
      currentSpeakers.add(turn.speakerId)
      blockStart = turn.startSec
    }
  }
  flush()

  return blocks
}

function tokenizeTranslatedTextForSubtitles(text: string, isCjk = false): string[] {
  const cleaned = text.trim().replace(/\s+/g, ' ')
  if (!cleaned) return []

  const spaceTokens = cleaned.split(' ').filter(Boolean)
  // If script naturally uses spaces (Latin, Hindi, Korean, Arabic, etc.) OR CJK is already chunked
  if (!isCjk || spaceTokens.length >= Math.max(2, Math.floor(cleaned.length / 8))) {
    return spaceTokens
  }

  // Space-less Japanese/Chinese chunking: split into 2-4 character readable glyph units,
  // preserving ASCII runs & keeping trailing punctuation attached
  const chunks: string[] = []
  let buf = ''
  const chars = [...cleaned]
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    if (ch === ' ') {
      if (buf) {
        chunks.push(buf)
        buf = ''
      }
      continue
    }
    const isAscii = /[a-zA-Z0-9._-]/.test(ch)
    const isPunct = /[。、！？.,!?，：；「」『』]/.test(ch)
    buf += ch
    if (isPunct) {
      chunks.push(buf)
      buf = ''
      continue
    }
    const nextIsAscii = i + 1 < chars.length && /[a-zA-Z0-9._-]/.test(chars[i + 1]!)
    if (!isAscii && !nextIsAscii && buf.length >= 3) {
      const nextIsPunct =
        i + 1 < chars.length && /[。、！？.,!?，：；」』]/.test(chars[i + 1]!)
      if (!nextIsPunct) {
        chunks.push(buf)
        buf = ''
      }
    }
  }
  if (buf) chunks.push(buf)
  return chunks.filter(Boolean)
}

/**
 * Generates clip-relative + absolute-time TranscriptWord[] across dubbed turns using their
 * actual synthesized/placed timing slots.
 */
export function distributeTranslatedWords(params: {
  turns: DubTurnSegment[]
  clipStartSec: number
  targetLanguageCode: string
}): { words: TranscriptWord[]; transcriptText: string } {
  const langMeta = getDubTargetLanguage(params.targetLanguageCode)
  const isCjk = Boolean(langMeta?.isCjk)
  const words: TranscriptWord[] = []
  const textParts: string[] = []

  for (const turn of params.turns) {
    const line = turn.translatedText.trim()
    if (!line) continue
    textParts.push(line)

    const localStart = turn.placedStartSec ?? turn.startSec
    const localEnd = Math.max(localStart + 0.15, turn.placedEndSec ?? turn.endSec)
    const absStart = params.clipStartSec + localStart
    const absEnd = params.clipStartSec + localEnd

    const tokens = tokenizeTranslatedTextForSubtitles(line, isCjk)
    if (tokens.length === 0) continue

    const totalWeight = tokens.reduce((sum, tok) => sum + Math.max(2, tok.length), 0)
    const totalDur = Math.max(0.15, absEnd - absStart)
    let cursor = absStart

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!
      const frac = Math.max(2, tok.length) / totalWeight
      const dur = totalDur * frac
      const end = i === tokens.length - 1 ? absEnd : Math.min(absEnd, cursor + dur)
      words.push({
        word: tok,
        start: Math.round(cursor * 1000) / 1000,
        end: Math.round(Math.max(cursor + 0.03, end) * 1000) / 1000,
        probability: 0.98
      })
      cursor = end
    }
  }

  return {
    words,
    transcriptText: textParts.join(' ')
  }
}

async function probeAudioDurationSec(audioPath: string): Promise<number> {
  const ffprobe = await resolveFfprobeBin()
  const { stdout } = await execFileAsync(
    ffprobe,
    [
      '-v',
      'quiet',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      audioPath
    ],
    { timeout: 10000 }
  )
  const dur = Number.parseFloat(stdout.trim())
  return Number.isFinite(dur) && dur > 0 ? dur : 0.5
}

function buildAtempoFilterChain(speedRatio: number): string[] {
  const filters: string[] = []
  let rem = speedRatio
  while (rem > 2.0) {
    filters.push('atempo=2.0')
    rem /= 2.0
  }
  while (rem < 0.5) {
    filters.push('atempo=0.5')
    rem /= 0.5
  }
  if (Math.abs(rem - 1.0) > 0.015) {
    filters.push(`atempo=${rem.toFixed(4)}`)
  }
  return filters
}

function parseRetryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err)
  const retryInMatch = msg.match(/retry in\s+([\d.]+)\s*s/i)
  if (retryInMatch?.[1]) {
    const sec = Number.parseFloat(retryInMatch[1])
    if (Number.isFinite(sec) && sec > 0) return Math.min(75_000, Math.ceil((sec + 1.5) * 1000))
  }
  const delayMatch = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i)
  if (delayMatch?.[1]) {
    const sec = Number.parseFloat(delayMatch[1])
    if (Number.isFinite(sec) && sec > 0) return Math.min(75_000, Math.ceil((sec + 1.5) * 1000))
  }
  return null
}

function isRetryableGeminiError(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true
  }
  const msg = err instanceof Error ? err.message : String(err)
  return /429|RESOURCE_EXHAUSTED|Too Many Requests|UNAVAILABLE|overloaded|timed out|ECONNRESET/i.test(msg)
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Dubbing cancelled')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Dubbing cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function synthesizeBlockWithGeminiTts(params: {
  block: SynthesisBlock
  speakersById: Map<string, DubSpeakerProfile>
  outPathBase: string
  apiKey: string
  model: string
  projectId?: string
  signal?: AbortSignal
  onWaiting?: (detail: string) => void
}): Promise<string> {
  const { block, speakersById, outPathBase, apiKey, model, projectId, signal, onWaiting } = params
  if (signal?.aborted) {
    throw new Error('Dubbing cancelled')
  }

  // Note: @google/genai@3.x defaults to 'v1', which rejects speechConfig / responseModalities / multiSpeakerVoiceConfig.
  // Gemini TTS models require 'v1beta'.
  const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' })

  const resolveVoiceName = (speakerId: string): string => {
    const profile = speakersById.get(speakerId)
    if (profile?.voiceName && getVoiceEntry(profile.voiceName)) {
      return profile.voiceName
    }
    return profile?.gender === 'female' ? 'Cleo' : 'Knox'
  }

  const isMultiSpeaker = block.speakerIds.length === 2
  const config: Record<string, unknown> = {
    temperature: 1,
    responseModalities: ['audio']
  }

  let contents: Array<{
    role: string
    parts: Array<{ text: string; speechMetadata?: { speaker?: string; style?: string } }>
  }>

  if (isMultiSpeaker) {
    const speakerVoiceConfigs = block.speakerIds.map((spId) => ({
      speaker: spId,
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: resolveVoiceName(spId)
        }
      }
    }))

    config.speechConfig = {
      multiSpeakerVoiceConfig: {
        mode: 'VERBATIM',
        speakerVoiceConfigs
      } as MultiSpeakerVoiceConfig
    }

    contents = [
      {
        role: 'user',
        parts: block.turns.map((t) => ({
          text: t.translatedText.trim(),
          speechMetadata: {
            speaker: t.speakerId,
            ...(t.style ? { style: t.style } : {})
          }
        }))
      }
    ]
  } else {
    const singleVoice = resolveVoiceName(block.speakerIds[0] || 'Speaker 1')
    config.speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: singleVoice
        }
      }
    }

    const combinedText = block.turns
      .map((t) => t.translatedText.trim())
      .filter(Boolean)
      .join(' ')
    contents = [
      {
        role: 'user',
        parts: [{ text: combinedText }]
      }
    ]
  }

  const maxAttempts = 3
  let lastErr: unknown = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error('Dubbing cancelled')
    try {
      const response = await ai.models.generateContentStream({
        model,
        config,
        contents
      })

      const chunks: AudioStreamChunk[] = []
      for await (const chunk of response) {
        if (signal?.aborted) {
          throw new Error('Dubbing cancelled')
        }
        const parts = chunk.candidates?.[0]?.content?.parts
        if (!Array.isArray(parts)) continue
        for (const part of parts) {
          if (part?.inlineData?.data) {
            chunks.push({
              dataBase64: part.inlineData.data,
              mimeType: part.inlineData.mimeType
            })
          }
        }
      }

      const { buffer, extension } = buildAudioBufferFromChunks(chunks)
      const outFilePath = `${outPathBase}.${extension}`
      await writeFile(outFilePath, buffer)
      return outFilePath
    } catch (err) {
      lastErr = err
      if (signal?.aborted) throw new Error('Dubbing cancelled')
      if (attempt < maxAttempts && isRetryableGeminiError(err)) {
        const waitMs = parseRetryDelayMs(err) ?? attempt * 22_000
        const waitSec = Math.ceil(waitMs / 1000)
        const waitMsg = `Gemini TTS rate limit reached; retrying block ${block.index + 1} in ${waitSec}s (attempt ${attempt + 1}/${maxAttempts})...`
        log('warn', 'Dubbing', waitMsg, projectId)
        onWaiting?.(waitMsg)
        await sleepWithAbort(waitMs, signal)
        continue
      }
      throw err
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('Gemini TTS synthesis failed')
}

export async function synthesizeDubbedClipAudio(params: {
  clipDir: string
  plan: DubbingPlan
  clipDurationSec: number
  projectId?: string
  apiKey?: string
  model?: string
  signal?: AbortSignal
  trackChild?: (child: ChildProcess) => () => void
  onProgress?: (percent: number, detail: string) => void
  synthesizeBlockOverride?: (args: {
    block: SynthesisBlock
    speakersById: Map<string, DubSpeakerProfile>
    outPathBase: string
  }) => Promise<string>
}): Promise<{ dubbedAudioPath: string; plan: DubbingPlan }> {
  const {
    clipDir,
    plan,
    clipDurationSec,
    projectId,
    apiKey = env.gemini.apiKey,
    model = env.gemini.ttsModel,
    signal,
    trackChild,
    onProgress,
    synthesizeBlockOverride
  } = params

  await ensureDir(clipDir)
  const dubbedAudioPath = path.join(clipDir, 'dubbed_audio.wav')

  if (!synthesizeBlockOverride && !apiKey.trim()) {
    throw new Error(
      'GEMINI_API_KEY is not set in .env — required for Gemini 3.8 Flash TTS multi-speaker dubbing.'
    )
  }

  const blocks = groupTurnsIntoSynthesisBlocks(plan.turns)
  const ffmpeg = await resolveFfmpegBin()
  const profile = getAdaptiveProcessingProfile()

  if (blocks.length === 0) {
    await runCancellableSpawn(
      ffmpeg,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=mono',
        '-t',
        Math.max(0.5, clipDurationSec).toFixed(3),
        dubbedAudioPath
      ],
      { signal, trackChild }
    )
    return {
      dubbedAudioPath,
      plan: {
        ...plan,
        dubbedWords: [],
        dubbedTranscriptText: ''
      }
    }
  }

  const tempDubAudioDir = path.join(clipDir, 'temp_dub_tts')
  await ensureDir(tempDubAudioDir)
  const speakersById = new Map<string, DubSpeakerProfile>(
    plan.speakers.map((s) => [s.speakerId, s])
  )

  try {
    const preparedBlocks: Array<{
      block: SynthesisBlock
      wavPath: string
      placedStartSec: number
      placedEndSec: number
    }> = []

    let prevPlacedEndSec = 0
    for (let i = 0; i < blocks.length; i++) {
      if (signal?.aborted) throw new Error('Dubbing cancelled')
      const block = blocks[i]!
      const pctBase = Math.round((i / blocks.length) * 75)
      onProgress?.(
        pctBase,
        `Synthesizing dubbed dialogue block ${i + 1}/${blocks.length} (${block.speakerIds.join(' + ')})...`
      )

      const outBase = path.join(tempDubAudioDir, `raw_block_${i}`)
      const rawAudioFile = synthesizeBlockOverride
        ? await synthesizeBlockOverride({ block, speakersById, outPathBase: outBase })
        : await synthesizeBlockWithGeminiTts({
            block,
            speakersById,
            outPathBase: outBase,
            apiKey,
            model,
            projectId,
            signal,
            onWaiting: (waitDetail) => onProgress?.(pctBase, waitDetail)
          })

      // Step 1: Normalize to 48kHz mono WAV and trim dead leading/trailing silence
      const trimmedWav = path.join(tempDubAudioDir, `trim_block_${i}.wav`)
      await runCancellableSpawn(
        ffmpeg,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-threads',
          String(profile.ffmpegThreads),
          '-i',
          rawAudioFile,
          '-ar',
          '48000',
          '-ac',
          '1',
          '-af',
          'silenceremove=start_periods=1:start_threshold=-45dB:detection=peak,areverse,silenceremove=start_periods=1:start_threshold=-45dB:detection=peak,areverse',
          '-c:a',
          'pcm_s16le',
          trimmedWav
        ],
        { signal, trackChild }
      )

      let rawDur = await probeAudioDurationSec(trimmedWav).catch(() => 0.4)
      if (!Number.isFinite(rawDur) || rawDur < 0.08) {
        // Fallback: use untrimmed normalized audio if aggressive silence trimming emptied short utterance
        await runCancellableSpawn(
          ffmpeg,
          [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            rawAudioFile,
            '-ar',
            '48000',
            '-ac',
            '1',
            '-c:a',
            'pcm_s16le',
            trimmedWav
          ],
          { signal, trackChild }
        )
        rawDur = await probeAudioDurationSec(trimmedWav).catch(() => 0.5)
      }

      const placedStartSec = Math.max(
        0,
        i === 0 ? block.startSec : Math.max(block.startSec, prevPlacedEndSec + 0.05)
      )
      const nextBlock = blocks[i + 1]
      const slotLimitSec = nextBlock
        ? Math.max(0.35, nextBlock.startSec - placedStartSec - 0.05)
        : Math.max(0.35, clipDurationSec - placedStartSec)

      let finalBlockWav = trimmedWav
      let finalDur = rawDur

      if (rawDur > slotLimitSec * 1.05 && slotLimitSec > 0.25) {
        const neededRatio = rawDur / slotLimitSec
        const cappedRatio = Math.min(nextBlock ? 1.32 : 1.45, Math.max(1.0, neededRatio))
        if (cappedRatio > 1.03) {
          const spedWav = path.join(tempDubAudioDir, `sped_block_${i}.wav`)
          const atempoChain = buildAtempoFilterChain(cappedRatio)
          const remainingAfterSpeed = Math.max(0.25, clipDurationSec - placedStartSec)
          const afParts = [...atempoChain]
          if (!nextBlock && rawDur / cappedRatio > remainingAfterSpeed) {
            afParts.push(`atrim=0:${remainingAfterSpeed.toFixed(3)}`)
          }
          await runCancellableSpawn(
            ffmpeg,
            [
              '-y',
              '-hide_banner',
              '-loglevel',
              'error',
              '-i',
              trimmedWav,
              '-af',
              afParts.join(','),
              '-ar',
              '48000',
              '-ac',
              '1',
              '-c:a',
              'pcm_s16le',
              spedWav
            ],
            { signal, trackChild }
          )
          finalBlockWav = spedWav
          finalDur = await probeAudioDurationSec(spedWav).catch(() => rawDur / cappedRatio)
        }
      }

      const placedEndSec = Math.min(clipDurationSec, placedStartSec + finalDur)
      prevPlacedEndSec = placedEndSec

      // Update placed timestamps proportionally across turns inside this block
      const totalCharWeight = block.turns.reduce(
        (sum, t) => sum + Math.max(3, t.translatedText.trim().length),
        0
      )
      let tCursor = placedStartSec
      const blockDurPlaced = Math.max(0.15, placedEndSec - placedStartSec)
      for (let ti = 0; ti < block.turns.length; ti++) {
        const turn = block.turns[ti]!
        const w = Math.max(3, turn.translatedText.trim().length) / totalCharWeight
        const tDur = blockDurPlaced * w
        turn.placedStartSec = Math.round(tCursor * 1000) / 1000
        turn.placedEndSec =
          ti === block.turns.length - 1
            ? Math.round(placedEndSec * 1000) / 1000
            : Math.round(Math.min(placedEndSec, tCursor + tDur) * 1000) / 1000
        tCursor += tDur
      }

      preparedBlocks.push({
        block,
        wavPath: finalBlockWav,
        placedStartSec,
        placedEndSec
      })
    }

    onProgress?.(85, 'Mixing time-aligned multi-speaker dubbed audio track...')

    // Assemble final dubbed_audio.wav on an exact clipDurationSec silent base
    const safeDur = Math.max(0.5, clipDurationSec)
    const args: string[] = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      String(profile.ffmpegThreads),
      '-f',
      'lavfi',
      '-t',
      safeDur.toFixed(3),
      '-i',
      'anullsrc=r=48000:cl=mono'
    ]

    const filterParts: string[] = []
    const mixLabels: string[] = ['[0:a]']

    for (let idx = 0; idx < preparedBlocks.length; idx++) {
      const pb = preparedBlocks[idx]!
      args.push('-i', pb.wavPath)
      const delayMs = Math.max(0, Math.round(pb.placedStartSec * 1000))
      const inputIdx = idx + 1
      const label = `[b${idx}]`
      filterParts.push(`[${inputIdx}:a]aresample=48000,adelay=${delayMs}|${delayMs}${label}`)
      mixLabels.push(label)
    }

    filterParts.push(
      `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[dubout]`
    )

    args.push(
      '-filter_complex',
      filterParts.join(';'),
      '-map',
      '[dubout]',
      '-t',
      safeDur.toFixed(3),
      '-ar',
      '48000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      dubbedAudioPath
    )

    await runCancellableSpawn(ffmpeg, args, { signal, trackChild })

    const updatedTurns = preparedBlocks.flatMap((pb) => pb.block.turns)
    const distributed = distributeTranslatedWords({
      turns: updatedTurns,
      clipStartSec: plan.clipStartSec,
      targetLanguageCode: plan.targetLanguage
    })

    const finalizedPlan: DubbingPlan = {
      ...plan,
      turns: updatedTurns,
      dubbedWords: distributed.words,
      dubbedTranscriptText: distributed.transcriptText,
      generatedAt: new Date().toISOString()
    }

    log(
      'info',
      'Dubbing',
      `Synthesized ${blocks.length} dialogue block(s) into ${path.basename(dubbedAudioPath)} (${plan.targetLanguage})`,
      projectId
    )
    onProgress?.(100, `Dubbed audio ready (${plan.targetLanguage})`)

    return {
      dubbedAudioPath,
      plan: finalizedPlan
    }
  } finally {
    await rm(tempDubAudioDir, { recursive: true, force: true }).catch(() => {})
  }
}
