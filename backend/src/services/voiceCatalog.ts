export type VoicePitchBucket =
  | 'deep'
  | 'low'
  | 'medium-low'
  | 'medium'
  | 'medium-high'
  | 'high'
  | 'very-high'

export interface GeminiVoiceEntry {
  name: string
  gender: 'male' | 'female'
  description: string
  pitchLabel: string
  pitchBucket: VoicePitchBucket
}

export interface DubTargetLanguage {
  code: string
  name: string
  nativeName: string
  assFont: string | null
  isCjk?: boolean
}

export const MALE_VOICES: GeminiVoiceEntry[] = [
  { name: 'Arlo', gender: 'male', description: 'Confident and clear.', pitchLabel: 'Deep pitch', pitchBucket: 'deep' },
  { name: 'Bodi', gender: 'male', description: 'Quiet and intimate.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Brio', gender: 'male', description: 'Quiet and intimate.', pitchLabel: 'Medium-low pitch', pitchBucket: 'medium-low' },
  { name: 'Cruz', gender: 'male', description: 'Poised and professional.', pitchLabel: 'Deep pitch', pitchBucket: 'deep' },
  { name: 'Daro', gender: 'male', description: 'Confident and clear.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Elio', gender: 'male', description: 'Calm and comforting.', pitchLabel: 'Medium pitch', pitchBucket: 'medium' },
  { name: 'Enzo', gender: 'male', description: 'Crisp and eager.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Finn', gender: 'male', description: 'Warm and approachable.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Gero', gender: 'male', description: 'Clear and friendly.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Jett', gender: 'male', description: 'Warm and empathetic.', pitchLabel: 'Deep pitch', pitchBucket: 'deep' },
  { name: 'Knox', gender: 'male', description: 'Warm and conversational.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Koda', gender: 'male', description: 'Direct and helpful.', pitchLabel: 'Medium-low pitch', pitchBucket: 'medium-low' },
  { name: 'Ludo', gender: 'male', description: 'Confident and clear.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Mako', gender: 'male', description: 'Energetic and colorful.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Milo', gender: 'male', description: 'Quiet and intimate.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Neno', gender: 'male', description: 'Deep and velvety.', pitchLabel: 'Deep pitch', pitchBucket: 'deep' },
  { name: 'Olin', gender: 'male', description: 'Light and precise.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Rami', gender: 'male', description: 'Warm and approachable.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Riko', gender: 'male', description: 'Confident and clear.', pitchLabel: 'Deep pitch', pitchBucket: 'deep' },
  { name: 'Varo', gender: 'male', description: 'Laid-back and chill.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Zeno', gender: 'male', description: 'Cool and confident.', pitchLabel: 'Medium-high pitch', pitchBucket: 'medium-high' },
  { name: 'Achird', gender: 'male', description: 'Friendly.', pitchLabel: 'Lower middle pitch', pitchBucket: 'medium-low' },
  { name: 'Algenib', gender: 'male', description: 'Gravelly.', pitchLabel: 'Lower pitch', pitchBucket: 'low' },
  { name: 'Algieba', gender: 'male', description: 'Smooth.', pitchLabel: 'Lower pitch', pitchBucket: 'low' },
  { name: 'Alnilam', gender: 'male', description: 'Firm.', pitchLabel: 'Lower middle pitch', pitchBucket: 'medium-low' },
  { name: 'Charon', gender: 'male', description: 'Informative.', pitchLabel: 'Lower pitch', pitchBucket: 'low' },
  { name: 'Enceladus', gender: 'male', description: 'Breathy.', pitchLabel: 'Lower pitch', pitchBucket: 'low' },
  { name: 'Fenrir', gender: 'male', description: 'Excitable.', pitchLabel: 'Lower middle pitch', pitchBucket: 'medium-low' },
  { name: 'Iapetus', gender: 'male', description: 'Clear.', pitchLabel: 'Lower middle pitch', pitchBucket: 'medium-low' },
  { name: 'Orus', gender: 'male', description: 'Firm.', pitchLabel: 'Lower middle pitch', pitchBucket: 'medium-low' },
  { name: 'Puck', gender: 'male', description: 'Upbeat.', pitchLabel: 'Middle pitch', pitchBucket: 'medium' },
  { name: 'Rasalgethi', gender: 'male', description: 'Informative.', pitchLabel: 'Middle pitch', pitchBucket: 'medium' },
  { name: 'Sadachbia', gender: 'male', description: 'Lively.', pitchLabel: 'Lower pitch', pitchBucket: 'low' },
  { name: 'Sadaltager', gender: 'male', description: 'Knowledgeable.', pitchLabel: 'Middle pitch', pitchBucket: 'medium' },
  { name: 'Schedar', gender: 'male', description: 'Even.', pitchLabel: 'Lower middle pitch', pitchBucket: 'medium-low' },
  { name: 'Umbriel', gender: 'male', description: 'Easy-going.', pitchLabel: 'Lower middle pitch', pitchBucket: 'medium-low' },
  { name: 'Zubenelgenubi', gender: 'male', description: 'Casual.', pitchLabel: 'Lower middle pitch', pitchBucket: 'medium-low' }
]

export const FEMALE_VOICES: GeminiVoiceEntry[] = [
  { name: 'Cleo', gender: 'female', description: 'Warm and engaging.', pitchLabel: 'Medium-high pitch', pitchBucket: 'medium-high' },
  { name: 'Enya', gender: 'female', description: 'Direct and professional.', pitchLabel: 'Medium pitch', pitchBucket: 'medium' },
  { name: 'Fola', gender: 'female', description: 'Clear and friendly.', pitchLabel: 'Medium pitch', pitchBucket: 'medium' },
  { name: 'Hali', gender: 'female', description: 'Calm and comforting.', pitchLabel: 'Medium-high pitch', pitchBucket: 'medium-high' },
  { name: 'Jori', gender: 'female', description: 'Warm and approachable.', pitchLabel: 'Medium-low pitch', pitchBucket: 'medium-low' },
  { name: 'Kira', gender: 'female', description: 'Cool and confident.', pitchLabel: 'Medium pitch', pitchBucket: 'medium' },
  { name: 'Lora', gender: 'female', description: 'Clear and friendly.', pitchLabel: 'Medium pitch', pitchBucket: 'medium' },
  { name: 'Lumi', gender: 'female', description: 'Warm and approachable.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Nika', gender: 'female', description: 'Warm and approachable.', pitchLabel: 'Medium pitch', pitchBucket: 'medium' },
  { name: 'Nyla', gender: 'female', description: 'Direct and professional.', pitchLabel: 'Medium-high pitch', pitchBucket: 'medium-high' },
  { name: 'Rina', gender: 'female', description: 'Gentle and relaxed.', pitchLabel: 'Medium pitch', pitchBucket: 'medium' },
  { name: 'Sami', gender: 'female', description: 'Cool and confident.', pitchLabel: 'Low pitch', pitchBucket: 'low' },
  { name: 'Sola', gender: 'female', description: 'Gentle and relaxed.', pitchLabel: 'Very high pitch', pitchBucket: 'very-high' },
  { name: 'Tari', gender: 'female', description: 'Confident and clear.', pitchLabel: 'Medium pitch', pitchBucket: 'medium' },
  { name: 'Tavi', gender: 'female', description: 'Quiet and intimate.', pitchLabel: 'Medium-high pitch', pitchBucket: 'medium-high' },
  { name: 'Tova', gender: 'female', description: 'Resonant and soothing.', pitchLabel: 'Medium-low pitch', pitchBucket: 'medium-low' },
  { name: 'Veda', gender: 'female', description: 'Warm and approachable.', pitchLabel: 'High pitch', pitchBucket: 'high' },
  { name: 'Zali', gender: 'female', description: 'Warm and empathetic.', pitchLabel: 'Medium pitch', pitchBucket: 'medium' },
  { name: 'Zuri', gender: 'female', description: 'Natural and clear.', pitchLabel: 'Medium pitch', pitchBucket: 'medium' },
  { name: 'Achernar', gender: 'female', description: 'Soft.', pitchLabel: 'Higher pitch', pitchBucket: 'high' },
  { name: 'Aoede', gender: 'female', description: 'Breezy.', pitchLabel: 'Middle pitch', pitchBucket: 'medium' },
  { name: 'Autonoe', gender: 'female', description: 'Bright.', pitchLabel: 'Middle pitch', pitchBucket: 'medium' },
  { name: 'Callirrhoe', gender: 'female', description: 'Easy-going.', pitchLabel: 'Middle pitch', pitchBucket: 'medium' },
  { name: 'Despina', gender: 'female', description: 'Smooth.', pitchLabel: 'Middle pitch', pitchBucket: 'medium' },
  { name: 'Erinome', gender: 'female', description: 'Clear.', pitchLabel: 'Middle pitch', pitchBucket: 'medium' },
  { name: 'Gacrux', gender: 'female', description: 'Mature.', pitchLabel: 'Middle pitch', pitchBucket: 'medium' },
  { name: 'Kore', gender: 'female', description: 'Firm.', pitchLabel: 'Middle pitch', pitchBucket: 'medium' },
  { name: 'Laomedeia', gender: 'female', description: 'Upbeat.', pitchLabel: 'Higher pitch', pitchBucket: 'high' },
  { name: 'Leda', gender: 'female', description: 'Youthful.', pitchLabel: 'Higher pitch', pitchBucket: 'high' },
  { name: 'Pulcherrima', gender: 'female', description: 'Forward.', pitchLabel: 'Middle pitch', pitchBucket: 'medium' },
  { name: 'Sulafat', gender: 'female', description: 'Warm.', pitchLabel: 'Middle pitch', pitchBucket: 'medium' },
  { name: 'Vindemiatrix', gender: 'female', description: 'Gentle.', pitchLabel: 'Middle pitch', pitchBucket: 'medium' },
  { name: 'Zephyr', gender: 'female', description: 'Bright.', pitchLabel: 'Higher pitch', pitchBucket: 'high' }
]

export const ALL_VOICES: GeminiVoiceEntry[] = [...MALE_VOICES, ...FEMALE_VOICES]

const VOICE_MAP = new Map<string, GeminiVoiceEntry>(
  ALL_VOICES.map((v) => [v.name.toLowerCase(), v])
)

export const DUB_TARGET_LANGUAGES: DubTargetLanguage[] = [
  { code: 'es', name: 'Spanish', nativeName: 'Español', assFont: null },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', assFont: 'Noto Sans Devanagari' },
  { code: 'fr', name: 'French', nativeName: 'Français', assFont: null },
  { code: 'de', name: 'German', nativeName: 'Deutsch', assFont: null },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', assFont: null },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', assFont: null },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', assFont: 'Noto Sans CJK JP', isCjk: true },
  { code: 'ko', name: 'Korean', nativeName: '한국어', assFont: 'Noto Sans CJK KR', isCjk: true },
  { code: 'zh', name: 'Chinese (Mandarin)', nativeName: '中文', assFont: 'Noto Sans CJK SC', isCjk: true },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', assFont: 'Noto Sans Arabic' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', assFont: 'Noto Sans' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', assFont: null },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', assFont: null },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', assFont: null },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', assFont: null },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', assFont: 'Noto Sans' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย', assFont: 'Noto Sans Thai' }
]

const LANGUAGE_MAP = new Map<string, DubTargetLanguage>(
  DUB_TARGET_LANGUAGES.map((l) => [l.code, l])
)

export function getDubTargetLanguage(code?: string | null): DubTargetLanguage | null {
  if (!code) return null
  return LANGUAGE_MAP.get(code.trim().toLowerCase()) ?? null
}

export function isEnglishSourceLanguage(lang?: string | null): boolean {
  if (!lang) return false
  const norm = lang.trim().toLowerCase()
  return (
    norm === 'en' ||
    norm.startsWith('en-') ||
    norm.startsWith('en_') ||
    norm === 'english'
  )
}

export function getVoiceEntry(voiceName?: string | null): GeminiVoiceEntry | null {
  if (!voiceName) return null
  return VOICE_MAP.get(voiceName.trim().toLowerCase()) ?? null
}

export function pickVoiceForSpeaker(params: {
  gender: 'male' | 'female'
  pitchHintHz?: number | null
  contentType?: string | null
  styleHint?: string | null
  alreadyUsedVoices?: Set<string>
  speakerIndex?: number
}): GeminiVoiceEntry {
  const {
    gender,
    pitchHintHz,
    contentType = '',
    styleHint = '',
    alreadyUsedVoices = new Set<string>(),
    speakerIndex = 0
  } = params

  const pool = gender === 'female' ? FEMALE_VOICES : MALE_VOICES
  const ctx = `${contentType || ''} ${styleHint || ''}`.toLowerCase()

  const scored = pool.map((voice, idx) => {
    let score = 0
    if (!alreadyUsedVoices.has(voice.name)) {
      score += 50
    }

    const desc = voice.description.toLowerCase()

    // Pitch alignment using measured fundamental frequency
    if (typeof pitchHintHz === 'number' && Number.isFinite(pitchHintHz) && pitchHintHz > 50) {
      if (gender === 'male') {
        if (pitchHintHz < 112) {
          if (voice.pitchBucket === 'deep') score += 16
          else if (voice.pitchBucket === 'low') score += 9
        } else if (pitchHintHz <= 136) {
          if (voice.pitchBucket === 'low' || voice.pitchBucket === 'medium-low') score += 14
          else if (voice.pitchBucket === 'deep') score += 8
        } else {
          if (voice.pitchBucket === 'medium' || voice.pitchBucket === 'medium-high') score += 14
          else if (voice.pitchBucket === 'medium-low') score += 8
        }
      } else {
        if (pitchHintHz < 182) {
          if (voice.pitchBucket === 'low' || voice.pitchBucket === 'medium-low') score += 15
          else if (voice.pitchBucket === 'medium') score += 8
        } else if (pitchHintHz <= 212) {
          if (voice.pitchBucket === 'medium' || voice.pitchBucket === 'medium-high') score += 14
        } else {
          if (voice.pitchBucket === 'high' || voice.pitchBucket === 'very-high') score += 15
          else if (voice.pitchBucket === 'medium-high') score += 10
        }
      }
    }

    // Persona / content-type match
    if (/podcast|interview|conversational|host|guest/.test(ctx)) {
      if (/conversational|warm|engaging|approachable|natural|clear/.test(desc)) score += 10
    }
    if (/gaming|energetic|hype|excited|excitable/.test(ctx)) {
      if (/energetic|upbeat|lively|excitable|bright|eager/.test(desc)) score += 12
    }
    if (/educational|tutorial|presentation|documentary|explainer|informative/.test(ctx)) {
      if (/confident|clear|informative|professional|direct|knowledgeable/.test(desc)) score += 10
    }
    if (/calm|comforting|relaxed|intimate|story|soothing/.test(ctx)) {
      if (/calm|comforting|gentle|relaxed|intimate|smooth|soothing/.test(desc)) score += 10
    }

    // Slight deterministic diversity across Speaker 1 / Speaker 2
    if (speakerIndex % 2 === 0 && ['Knox', 'Arlo', 'Cleo', 'Veda'].includes(voice.name)) {
      score += 4
    }
    if (speakerIndex % 2 === 1 && ['Finn', 'Elio', 'Cruz', 'Nika', 'Enya', 'Tari'].includes(voice.name)) {
      score += 4
    }

    // Deterministic tie-break favoring descriptive studio voices near top of curated list
    score += Math.max(0, (pool.length - idx) * 0.05)

    return { voice, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored[0]!.voice
}

