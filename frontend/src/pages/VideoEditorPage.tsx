import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronDown,
  Download,
  Eye,
  Languages,
  Loader2,
  Music,
  RefreshCw,
  Type
} from 'lucide-react'
import { api } from '../api/client'
import { StatusBadge } from '../components/StatusBadge'
import type {
  CapabilitiesResponse,
  ClipRecord,
  ClipTrackingResult,
  CompositionMode,
  DubSpeakerOverride,
  ProjectRecord,
  RenderQuality,
  SubtitleConfig,
  SubtitlePresetName
} from '../types'

export function VideoEditorPage() {
  const { id } = useParams<{ id: string }>()
  const [clip, setClip] = useState<ClipRecord | null>(null)
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [tracking, setTracking] = useState<ClipTrackingResult | null>(null)
  const [presets, setPresets] = useState<Record<SubtitlePresetName, SubtitleConfig> | null>(null)
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null)

  const [compositionMode, setCompositionMode] = useState<CompositionMode>('smart')
  const [renderQuality, setRenderQuality] = useState<RenderQuality>('high')
  const [targetFps, setTargetFps] = useState<string>('auto')
  const [startTimeSec, setStartTimeSec] = useState(0)
  const [endTimeSec, setEndTimeSec] = useState(30)
  const [subtitleConfig, setSubtitleConfig] = useState<SubtitleConfig | null>(null)
  const [backgroundAudioPath, setBackgroundAudioPath] = useState<string | null>(null)
  const [backgroundAudioVolume, setBackgroundAudioVolume] = useState(0.15)
  const [dubEnabled, setDubEnabled] = useState(false)
  const [dubTargetLanguage, setDubTargetLanguage] = useState('es')
  const [speakerOverrides, setSpeakerOverrides] = useState<
    Record<string, { gender: 'male' | 'female'; voiceName: string }>
  >({})
  const [regenerateDub, setRegenerateDub] = useState(false)
  const [showDubTurns, setShowDubTurns] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [uploadingAudio, setUploadingAudio] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sourceVideoRef = useRef<HTMLVideoElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)

  const syncDubStateFromClip = (c: ClipRecord) => {
    setDubEnabled(Boolean(c.dubbingConfig?.enabled))
    setDubTargetLanguage(
      c.dubbingConfig?.targetLanguage || c.dubbingPlan?.targetLanguage || 'es'
    )
    const nextOverrides: Record<string, { gender: 'male' | 'female'; voiceName: string }> = {}
    if (c.dubbingPlan?.speakers) {
      for (const sp of c.dubbingPlan.speakers) {
        nextOverrides[sp.speakerId] = {
          gender: sp.gender === 'female' ? 'female' : 'male',
          voiceName: sp.voiceName
        }
      }
    }
    for (const ov of c.dubbingConfig?.speakerOverrides ?? []) {
      const prev = nextOverrides[ov.speakerId]
      nextOverrides[ov.speakerId] = {
        gender: ov.gender ?? prev?.gender ?? 'male',
        voiceName: ov.voiceName ?? prev?.voiceName ?? ''
      }
    }
    setSpeakerOverrides(nextOverrides)
  }

  const loadAll = async () => {
    if (!id) return
    const [clipRes, capsRes] = await Promise.all([api.getClip(id), api.getCapabilities()])
    setClip(clipRes.clip)
    setProject(clipRes.project)
    setCaps(capsRes)
    setPresets(capsRes.subtitlePresets)

    setCompositionMode(clipRes.clip.compositionMode)
    setRenderQuality(clipRes.clip.renderQuality)
    setTargetFps(clipRes.clip.targetFps ? String(clipRes.clip.targetFps) : 'auto')
    setStartTimeSec(clipRes.clip.startTimeSec)
    setEndTimeSec(clipRes.clip.endTimeSec)
    setSubtitleConfig(clipRes.clip.subtitleConfig)
    setBackgroundAudioPath(clipRes.clip.backgroundAudioPath ?? null)
    setBackgroundAudioVolume(clipRes.clip.backgroundAudioVolume ?? 0.15)
    syncDubStateFromClip(clipRes.clip)
    setRegenerateDub(false)

    try {
      const tr = await api.getClipTracking(id)
      setTracking(tr)
    } catch {
      setTracking(null)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [id])

  // Poll while rendering
  useEffect(() => {
    if (!id || !clip) return
    if (
      !['TRACKING_FACES', 'DUBBING', 'GENERATING_SUBTITLES', 'RENDERING', 'PENDING'].includes(
        clip.status
      )
    ) {
      setRendering(false)
      return
    }
    const timer = setInterval(() => {
      void api.getClip(id).then((res) => {
        setClip(res.clip)
        if (res.project) setProject(res.project)
        if (res.clip.status === 'COMPLETED') {
          syncDubStateFromClip(res.clip)
          setRegenerateDub(false)
          api.getClipTracking(id).then(setTracking).catch(() => {})
        }
      })
    }, 2000)
    return () => clearInterval(timer)
  }, [id, clip?.status])

  // Draw synchronized face tracking boxes + dynamic 9:16 crop overlay onto source video canvas
  useEffect(() => {
    const video = sourceVideoRef.current
    const canvas = overlayCanvasRef.current
    if (!video || !canvas || !tracking) return

    let rafId = 0
    const draw = () => {
      const rect = video.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
          canvas.width = Math.round(rect.width)
          canvas.height = Math.round(rect.height)
        }
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          const relT = Math.max(0, video.currentTime - (clip?.startTimeSec ?? 0))

          // Find closest tracking sample
          let sample = tracking.frames[0]
          for (const fr of tracking.frames) {
            if (fr.timeSec <= relT) sample = fr
            else break
          }

          if (sample) {
            const drawCrop = (
              crop: { x: number; y: number; w: number; h: number },
              color: string,
              textColor: string,
              label: string
            ) => {
              const cx = crop.x * canvas.width
              const cy = crop.y * canvas.height
              const cw = crop.w * canvas.width
              const ch = crop.h * canvas.height
              ctx.strokeStyle = color
              ctx.lineWidth = 2.5
              ctx.strokeRect(cx, cy, cw, ch)
              ctx.fillStyle = color
              ctx.fillRect(cx, Math.max(0, cy - 18), 86, 18)
              ctx.fillStyle = textColor
              ctx.font = 'bold 11px monospace'
              ctx.fillText(label, cx + 4, Math.max(13, cy - 5))
            }

            drawCrop(
              sample.cropPrimary,
              '#00f0ff',
              '#021216',
              sample.layoutMode === 'dual_split' ? 'TOP CROP' : '9:16 CROP'
            )
            if (sample.cropSecondary) {
              drawCrop(sample.cropSecondary, '#ec4899', '#ffffff', 'BOT CROP')
            }

            for (const f of sample.faces) {
              const fx = f.x * canvas.width
              const fy = f.y * canvas.height
              const fw = f.w * canvas.width
              const fh = f.h * canvas.height
              ctx.strokeStyle = f.isActiveSpeaker ? '#10b981' : '#f59e0b'
              ctx.lineWidth = f.isActiveSpeaker ? 2.5 : 1.5
              ctx.strokeRect(fx, fy, fw, fh)
              ctx.fillStyle = f.isActiveSpeaker ? '#10b981' : '#f59e0b'
              ctx.font = 'bold 11px monospace'
              ctx.fillText(
                `ID#${f.trackId}${f.isActiveSpeaker ? ' SPEAKING' : ''}`,
                fx,
                Math.max(12, fy - 4)
              )
            }
          }
        }
      }
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafId)
  }, [tracking, clip?.startTimeSec])

  const handlePresetChange = (preset: SubtitlePresetName) => {
    if (!presets?.[preset]) return
    setSubtitleConfig({ ...presets[preset] })
  }

  const handleUploadBgm = async (file: File | undefined) => {
    if (!file) return
    setUploadingAudio(true)
    try {
      const res = await api.uploadAudio(file)
      setBackgroundAudioPath(res.audioPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audio upload failed')
    } finally {
      setUploadingAudio(false)
    }
  }

  const handleApplyAndRender = async () => {
    if (!id || !subtitleConfig) return
    setRendering(true)
    setError(null)
    try {
      const overridesList: DubSpeakerOverride[] = Object.entries(speakerOverrides).map(
        ([speakerId, val]) => ({
          speakerId,
          gender: val.gender,
          ...(val.voiceName ? { voiceName: val.voiceName } : {})
        })
      )
      await api.renderClip(id, {
        compositionMode,
        renderQuality,
        targetFps: targetFps === 'auto' ? null : Number(targetFps),
        startTimeSec,
        endTimeSec,
        subtitleConfig,
        backgroundAudioPath,
        backgroundAudioVolume,
        dubbingConfig: dubEnabled
          ? {
              enabled: true,
              targetLanguage: dubTargetLanguage || 'es',
              ...(overridesList.length > 0 ? { speakerOverrides: overridesList } : {})
            }
          : {
              enabled: false,
              targetLanguage: dubTargetLanguage || 'es'
            },
        regenerateDub: dubEnabled ? regenerateDub : false
      })
      const res = await api.getClip(id)
      setClip(res.clip)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start render')
      setRendering(false)
    }
  }

  if (!clip || !subtitleConfig) {
    return <div className="p-8 text-sm text-zinc-400">Loading Video Editor...</div>
  }

  const srcLang = project?.sourceLanguage?.trim().toLowerCase() || ''
  const isEnglishSource =
    !srcLang ||
    srcLang === 'en' ||
    srcLang === 'english' ||
    srcLang.startsWith('en-') ||
    srcLang.startsWith('en_')
  const dubVoices = caps?.dubbing?.voices
  const maleVoices = dubVoices?.male ?? []
  const femaleVoices = dubVoices?.female ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Link
            to={`/projects/${clip.projectId}/clips`}
            className="rounded-xl border border-white/[0.1] bg-[#080b0e] p-2 text-zinc-300 transition hover:border-[#00f0ff]/40 hover:text-[#66f7ff]"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold text-white">{clip.title}</h1>
              <StatusBadge status={clip.status} />
            </div>
            <p className="text-xs text-zinc-400">
              Interactive 9:16 framing, face-tracking visualizer, subtitle styling &amp; re-render studio
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {clip.status === 'COMPLETED' && (
            <a
              href={`/api/clips/${clip.id}/download`}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#00f0ff]/40 bg-[#00f0ff]/12 px-4 py-2 text-xs font-semibold text-[#66f7ff] transition hover:bg-[#00f0ff]/22"
            >
              <Download className="h-4 w-4" />
              Export 9:16 MP4
            </a>
          )}
          <button
            onClick={handleApplyAndRender}
            disabled={rendering}
            className="inline-flex items-center gap-2 rounded-xl bg-[#00e8f5] px-5 py-2 text-sm font-semibold text-[#021216] shadow-[0_0_24px_-4px_rgba(0,240,255,0.45)] transition hover:bg-[#33f3ff] disabled:opacity-50"
          >
            {rendering ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Apply &amp; Re-render
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-12">
        {/* Left: Previews */}
        <div className="space-y-6 xl:col-span-7">
          <div className="grid gap-5 md:grid-cols-12">
            {/* 9:16 Output Preview */}
            <div className="rounded-2xl border border-white/[0.08] bg-[#07090b] p-4 md:col-span-5">
              <div className="mb-2.5 flex items-center justify-between text-xs font-semibold text-zinc-300">
                <span>9:16 Output Preview</span>
                <span className="font-mono text-zinc-500">1080×1920</span>
              </div>
              <div className="aspect-[9/16] overflow-hidden rounded-xl border border-white/[0.08] bg-black">
                {clip.status === 'COMPLETED' ? (
                  <video
                    key={clip.updatedAt}
                    src={`/api/clips/${clip.id}/video?t=${encodeURIComponent(clip.updatedAt)}`}
                    controls
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-4 text-center text-xs text-zinc-500">
                    Render clip to preview final 9:16 MP4
                  </div>
                )}
              </div>
            </div>

            {/* Source Crop + Face Tracking Overlay */}
            <div className="rounded-2xl border border-white/[0.08] bg-[#07090b] p-4 md:col-span-7">
              <div className="mb-2.5 flex items-center justify-between text-xs font-semibold text-zinc-300">
                <span className="flex items-center gap-1.5">
                  <Eye className="h-3.5 w-3.5 text-[#00f0ff]" />
                  Face Tracking &amp; Crop Trajectory
                </span>
                <span className="font-mono text-[11px] text-zinc-400">
                  {tracking
                    ? `${tracking.speakersDetected} tracks · ${
                        tracking.compositionModeResolved === 'dynamic'
                          ? 'dynamic (9:16 + split)'
                          : tracking.compositionModeResolved
                      }`
                    : 'Not tracked yet'}
                </span>
              </div>

              <div className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-black">
                {project ? (
                  <>
                    <video
                      ref={sourceVideoRef}
                      src={`/api/projects/${project.id}/source-video#t=${startTimeSec},${endTimeSec}`}
                      controls
                      onLoadedMetadata={() => {
                        if (sourceVideoRef.current) {
                          sourceVideoRef.current.currentTime = startTimeSec
                        }
                      }}
                      className="w-full"
                    />
                    <canvas
                      ref={overlayCanvasRef}
                      className="pointer-events-none absolute inset-0 h-full w-full"
                    />
                  </>
                ) : null}
              </div>
              <p className="mt-2 text-[11px] text-zinc-500">
                Cyan/Pink box shows the dynamic crop trajectory; Emerald box highlights the active speaker.
              </p>
            </div>
          </div>

          {/* Trim & Rendering Settings */}
          <div className="space-y-4 rounded-2xl border border-white/[0.08] bg-[#07090b] p-5">
            <h2 className="text-sm font-semibold text-white">Framing, Trim &amp; Export Options</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Start (sec)</label>
                <input
                  type="number"
                  step="0.5"
                  min={0}
                  value={startTimeSec}
                  onChange={(e) => setStartTimeSec(Number(e.target.value))}
                  className="w-full rounded-lg border border-white/[0.1] bg-[#030406] px-3 py-2 font-mono text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">End (sec)</label>
                <input
                  type="number"
                  step="0.5"
                  min={startTimeSec + 2}
                  value={endTimeSec}
                  onChange={(e) => setEndTimeSec(Number(e.target.value))}
                  className="w-full rounded-lg border border-white/[0.1] bg-[#030406] px-3 py-2 font-mono text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Composition Mode</label>
                <select
                  value={compositionMode}
                  onChange={(e) => setCompositionMode(e.target.value as CompositionMode)}
                  className="w-full rounded-lg border border-white/[0.1] bg-[#030406] px-3 py-2 text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
                >
                  <option value="smart">Smart Composition</option>
                  <option value="single">Single Active Speaker</option>
                  <option value="dual">Dual Speaker</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Quality &amp; FPS</label>
                <div className="flex gap-2">
                  <select
                    value={renderQuality}
                    onChange={(e) => setRenderQuality(e.target.value as RenderQuality)}
                    className="flex-1 rounded-lg border border-white/[0.1] bg-[#030406] px-2 py-2 text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Med</option>
                    <option value="high">High</option>
                    <option value="ultra">Ultra</option>
                  </select>
                  <select
                    value={targetFps}
                    onChange={(e) => setTargetFps(e.target.value)}
                    className="w-20 rounded-lg border border-white/[0.1] bg-[#030406] px-2 py-2 text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
                  >
                    <option value="auto">Auto</option>
                    <option value="24">24</option>
                    <option value="30">30</option>
                    <option value="60">60</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 border-t border-white/[0.07] pt-3 text-xs">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[#00f0ff]/30 bg-[#00f0ff]/10 px-3 py-2 text-[#66f7ff] transition hover:bg-[#00f0ff]/20">
                <Music className="h-3.5 w-3.5 text-[#00f0ff]" />
                {uploadingAudio ? 'Uploading...' : 'Optional Background Music'}
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => void handleUploadBgm(e.target.files?.[0])}
                />
              </label>
              {backgroundAudioPath && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-400">
                      Vol ({Math.round(backgroundAudioVolume * 100)}%)
                    </span>
                    <input
                      type="range"
                      min={0.05}
                      max={0.5}
                      step={0.05}
                      value={backgroundAudioVolume}
                      onChange={(e) => setBackgroundAudioVolume(Number(e.target.value))}
                      className="accent-[#00e8f5]"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setBackgroundAudioPath(null)}
                    className="text-rose-400 hover:underline"
                  >
                    Remove BGM
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Multi-Speaker AI Dubbing Card */}
          <div className="space-y-4 rounded-2xl border border-white/[0.08] bg-[#07090b] p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Languages className="h-4 w-4 text-[#00f0ff]" />
                <h2 className="text-sm font-semibold text-white">Multi-Speaker AI Dubbing</h2>
                {srcLang && (
                  <span className="rounded-full border border-white/[0.08] bg-black px-2 py-0.5 font-mono text-[10px] uppercase text-zinc-400">
                    src: {srcLang}
                  </span>
                )}
              </div>

              <label
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  !isEnglishSource
                    ? 'cursor-not-allowed border-white/[0.06] bg-black/50 text-zinc-500'
                    : dubEnabled
                      ? 'cursor-pointer border-[#00f0ff]/45 bg-[#00f0ff]/12 text-[#66f7ff]'
                      : 'cursor-pointer border-white/[0.1] bg-[#030406] text-zinc-300 hover:border-white/20'
                }`}
              >
                <input
                  type="checkbox"
                  checked={dubEnabled}
                  disabled={!isEnglishSource}
                  onChange={(e) => setDubEnabled(e.target.checked)}
                  className="accent-[#00e8f5]"
                />
                Enable Dubbing
              </label>
            </div>

            {!isEnglishSource ? (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-300">
                AI Dubbing currently supports English source videos only (detected language:{' '}
                <span className="font-mono">{project?.sourceLanguage}</span>).
              </div>
            ) : (
              <>
                {!caps?.dubbing?.configured && (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-300">
                    Set <span className="font-mono text-amber-200">GEMINI_API_KEY</span> in{' '}
                    <span className="font-mono">.env</span> and restart backend to synthesize audio
                    via <span className="font-mono">{caps?.dubbing?.model || 'gemini-3.8-flash-tts'}</span>.
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">
                      Target Language (English → Target)
                    </label>
                    <select
                      value={dubTargetLanguage}
                      onChange={(e) => setDubTargetLanguage(e.target.value)}
                      className="w-full rounded-lg border border-white/[0.1] bg-[#030406] px-3 py-2 text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
                    >
                      {(caps?.dubbing?.languages ?? []).map((lang) => (
                        <option key={lang.code} value={lang.code}>
                          {lang.name} ({lang.nativeName})
                        </option>
                      ))}
                    </select>
                  </div>

                  {clip.dubbingPlan && dubEnabled && (
                    <div className="flex items-end pb-1">
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                        <input
                          type="checkbox"
                          checked={regenerateDub}
                          onChange={(e) => setRegenerateDub(e.target.checked)}
                          className="accent-[#00e8f5]"
                        />
                        Re-translate &amp; regenerate TTS on re-render
                      </label>
                    </div>
                  )}
                </div>

                {clip.dubbingPlan && clip.dubbingPlan.speakers.length > 0 && (
                  <div className="space-y-2.5 border-t border-white/[0.06] pt-3">
                    <div className="flex items-center justify-between text-[11px] font-medium text-zinc-400">
                      <span>Detected Speakers &amp; Assigned Voices</span>
                      <span className="font-mono text-zinc-500">
                        {clip.dubbingPlan.speakers.length} speaker(s)
                      </span>
                    </div>

                    <div className="space-y-2">
                      {clip.dubbingPlan.speakers.map((sp) => {
                        const override = speakerOverrides[sp.speakerId]
                        const currentGender: 'male' | 'female' =
                          override?.gender ?? (sp.gender === 'female' ? 'female' : 'male')
                        const voicePool = currentGender === 'female' ? femaleVoices : maleVoices
                        const currentVoice =
                          override?.voiceName &&
                          voicePool.some((v) => v.name === override.voiceName)
                            ? override.voiceName
                            : voicePool.some((v) => v.name === sp.voiceName)
                              ? sp.voiceName
                              : voicePool[0]?.name || sp.voiceName

                        return (
                          <div
                            key={sp.speakerId}
                            className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.06] bg-[#030406] p-2.5 text-xs"
                          >
                            <div className="min-w-[120px] flex-1">
                              <div className="flex items-center gap-2 font-medium text-zinc-200">
                                <span>{sp.speakerId}</span>
                                {sp.pitchHz != null && (
                                  <span className="rounded bg-black px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                                    {sp.pitchHz} Hz
                                  </span>
                                )}
                              </div>
                              {sp.styleHint && (
                                <div className="truncate text-[10px] text-zinc-500">
                                  {sp.styleHint}
                                </div>
                              )}
                            </div>

                            <select
                              value={currentGender}
                              aria-label={`${sp.speakerId} gender`}
                              onChange={(e) => {
                                const nextGender = e.target.value === 'female' ? 'female' : 'male'
                                const nextPool = nextGender === 'female' ? femaleVoices : maleVoices
                                setSpeakerOverrides((prev) => ({
                                  ...prev,
                                  [sp.speakerId]: {
                                    gender: nextGender,
                                    voiceName: nextPool[0]?.name || ''
                                  }
                                }))
                              }}
                              className="rounded-lg border border-white/[0.1] bg-black px-2 py-1.5 text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
                            >
                              <option value="male">Male</option>
                              <option value="female">Female</option>
                            </select>

                            <select
                              value={currentVoice}
                              aria-label={`${sp.speakerId} voice`}
                              onChange={(e) => {
                                const chosenVoice = e.target.value
                                setSpeakerOverrides((prev) => ({
                                  ...prev,
                                  [sp.speakerId]: {
                                    gender: currentGender,
                                    voiceName: chosenVoice
                                  }
                                }))
                              }}
                              className="min-w-[180px] flex-1 rounded-lg border border-white/[0.1] bg-black px-2 py-1.5 text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
                            >
                              {voicePool.length > 0 ? (
                                voicePool.map((v) => (
                                  <option key={v.name} value={v.name}>
                                    {v.name} · {v.pitchLabel}
                                  </option>
                                ))
                              ) : (
                                <option value={currentVoice}>{currentVoice}</option>
                              )}
                            </select>
                          </div>
                        )
                      })}
                    </div>

                    {clip.dubbingPlan.turns.length > 0 && (
                      <div className="pt-1">
                        <button
                          type="button"
                          onClick={() => setShowDubTurns((v) => !v)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-[#66f7ff] hover:underline"
                        >
                          <span>
                            {showDubTurns ? 'Hide' : 'Show'} translated dialogue ({clip.dubbingPlan.turns.length} turns)
                          </span>
                          <ChevronDown
                            className={`h-3 w-3 transition-transform ${
                              showDubTurns ? 'rotate-180' : ''
                            }`}
                          />
                        </button>
                        {showDubTurns && (
                          <div className="mt-2 max-h-48 space-y-2 overflow-y-auto rounded-xl border border-white/[0.06] bg-black p-3 text-[11px]">
                            {clip.dubbingPlan.turns.map((turn, i) => (
                              <div key={i} className="space-y-0.5 border-b border-white/[0.05] pb-1.5 last:border-none last:pb-0">
                                <div className="flex items-center justify-between font-mono text-[10px] text-zinc-500">
                                  <span className="text-[#4ff8ff]">{turn.speakerId}</span>
                                  <span>
                                    {(turn.placedStartSec ?? turn.startSec).toFixed(1)}s–
                                    {(turn.placedEndSec ?? turn.endSec).toFixed(1)}s
                                  </span>
                                </div>
                                <div className="text-zinc-200">{turn.translatedText}</div>
                                <div className="text-zinc-500">{turn.originalText}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right: Subtitle Customization */}
        <div className="space-y-5 rounded-2xl border border-white/[0.08] bg-[#07090b] p-5 xl:col-span-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Type className="h-4 w-4 text-[#00f0ff]" />
            Subtitle Styling &amp; Safe Margins
          </div>

          <div>
            <label className="mb-2 block text-xs text-zinc-400">Caption Preset</label>
            <div className="grid grid-cols-3 gap-2">
              {(
                ['modern', 'minimal', 'bold', 'podcast', 'gaming', 'educational'] as SubtitlePresetName[]
              ).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => handlePresetChange(p)}
                  className={`rounded-lg border px-3 py-2 text-xs font-medium capitalize transition ${
                    subtitleConfig.preset === p
                      ? 'border-[#00f0ff]/60 bg-[#00f0ff]/15 text-[#7ef9ff] shadow-[0_0_14px_-6px_rgba(0,240,255,0.5)]'
                      : 'border-white/[0.08] bg-[#030406] text-zinc-400 hover:border-white/[0.16] hover:text-zinc-200'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Font Family</label>
              <select
                value={subtitleConfig.fontName}
                onChange={(e) =>
                  setSubtitleConfig((s) => (s ? { ...s, fontName: e.target.value } : s))
                }
                className="w-full rounded-lg border border-white/[0.1] bg-[#030406] px-3 py-2 text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
              >
                <option value="Noto Sans">Noto Sans</option>
                <option value="Liberation Sans">Liberation Sans</option>
                <option value="DejaVu Sans">DejaVu Sans</option>
                <option value="DejaVu Serif">DejaVu Serif</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs text-zinc-400">Placement</label>
              <select
                value={subtitleConfig.position}
                onChange={(e) =>
                  setSubtitleConfig((s) =>
                    s
                      ? { ...s, position: e.target.value as SubtitleConfig['position'] }
                      : s
                  )
                }
                className="w-full rounded-lg border border-white/[0.1] bg-[#030406] px-3 py-2 text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
              >
                <option value="auto">Auto (Face-Safe)</option>
                <option value="bottom">Bottom Safe Zone</option>
                <option value="middle">Middle</option>
                <option value="top">Top Safe Zone</option>
              </select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                Font Size (<span className="font-mono text-[#66f7ff]">{subtitleConfig.fontSize}px</span>)
              </label>
              <input
                type="range"
                min={36}
                max={105}
                value={subtitleConfig.fontSize}
                onChange={(e) =>
                  setSubtitleConfig((s) =>
                    s ? { ...s, fontSize: Number(e.target.value) } : s
                  )
                }
                className="w-full accent-[#00e8f5]"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                Words Per Line (<span className="font-mono text-[#66f7ff]">{subtitleConfig.maxWordsPerLine}</span>)
              </label>
              <input
                type="range"
                min={2}
                max={7}
                value={subtitleConfig.maxWordsPerLine}
                onChange={(e) =>
                  setSubtitleConfig((s) =>
                    s ? { ...s, maxWordsPerLine: Number(e.target.value) } : s
                  )
                }
                className="w-full accent-[#00e8f5]"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Text Color</label>
              <input
                type="color"
                value={subtitleConfig.primaryColor}
                onChange={(e) =>
                  setSubtitleConfig((s) =>
                    s ? { ...s, primaryColor: e.target.value } : s
                  )
                }
                className="h-9 w-full cursor-pointer rounded-lg border border-white/[0.1] bg-[#030406]"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Highlight</label>
              <input
                type="color"
                value={subtitleConfig.highlightColor}
                onChange={(e) =>
                  setSubtitleConfig((s) =>
                    s ? { ...s, highlightColor: e.target.value } : s
                  )
                }
                className="h-9 w-full cursor-pointer rounded-lg border border-white/[0.1] bg-[#030406]"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Outline</label>
              <input
                type="color"
                value={subtitleConfig.outlineColor}
                onChange={(e) =>
                  setSubtitleConfig((s) =>
                    s ? { ...s, outlineColor: e.target.value } : s
                  )
                }
                className="h-9 w-full cursor-pointer rounded-lg border border-white/[0.1] bg-[#030406]"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                Outline Width (<span className="font-mono text-[#66f7ff]">{subtitleConfig.outlineWidth}px</span>)
              </label>
              <input
                type="range"
                min={0}
                max={12}
                value={subtitleConfig.outlineWidth}
                onChange={(e) =>
                  setSubtitleConfig((s) =>
                    s ? { ...s, outlineWidth: Number(e.target.value) } : s
                  )
                }
                className="w-full accent-[#00e8f5]"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                Bottom Safe Margin (<span className="font-mono text-[#66f7ff]">{subtitleConfig.safeMarginBottomPx}px</span>)
              </label>
              <input
                type="range"
                min={180}
                max={540}
                step={10}
                value={subtitleConfig.safeMarginBottomPx}
                onChange={(e) =>
                  setSubtitleConfig((s) =>
                    s ? { ...s, safeMarginBottomPx: Number(e.target.value) } : s
                  )
                }
                className="w-full accent-[#00e8f5]"
              />
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={subtitleConfig.highlightKeywords}
              onChange={(e) =>
                setSubtitleConfig((s) =>
                  s ? { ...s, highlightKeywords: e.target.checked } : s
                )
              }
              className="accent-[#00e8f5]"
            />
            Animate active word highlighting synchronized with speech
          </label>

          {/* Live Caption Mockup Preview */}
          <div className="rounded-xl border border-white/[0.08] bg-black p-5 text-center">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">
              Caption Style Preview
            </div>
            <div
              className="font-bold tracking-tight"
              style={{
                fontFamily: subtitleConfig.fontName,
                fontSize: `${Math.round(subtitleConfig.fontSize * 0.42)}px`,
                color: subtitleConfig.primaryColor,
                textShadow: `0 0 ${subtitleConfig.outlineWidth * 1.5}px ${subtitleConfig.outlineColor}, 0 2px ${subtitleConfig.shadowDepth * 2}px #000`
              }}
            >
              THIS IS{' '}
              <span style={{ color: subtitleConfig.highlightColor }}>DYNAMIC</span>{' '}
              TRACKING
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
