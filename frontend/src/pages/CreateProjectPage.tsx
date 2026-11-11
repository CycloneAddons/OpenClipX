import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  Languages,
  Loader2,
  Play,
  Search,
  Sliders,
  Sparkles,
  Youtube
} from 'lucide-react'
import { api } from '../api/client'
import type {
  CapabilitiesResponse,
  CompositionMode,
  RenderQuality,
  SubtitlePresetName,
  VideoPreviewInfo
} from '../types'

export function CreateProjectPage() {
  const navigate = useNavigate()
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [preview, setPreview] = useState<VideoPreviewInfo | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null)
  const [minClipDurationSec, setMinClipDurationSec] = useState(20)
  const [maxClipDurationSec, setMaxClipDurationSec] = useState(60)
  const [targetClipCount, setTargetClipCount] = useState(4)
  const [compositionMode, setCompositionMode] = useState<CompositionMode>('smart')
  const [subtitlePreset, setSubtitlePreset] = useState<SubtitlePresetName>('modern')
  const [renderQuality, setRenderQuality] = useState<RenderQuality>('high')
  const [videoQualityPref, setVideoQualityPref] = useState<'1080p' | '720p' | '1440p' | '2160p' | 'best'>('1080p')
  const [enableVisionAnalysis, setEnableVisionAnalysis] = useState(true)
  const [autoRenderTopClips, setAutoRenderTopClips] = useState(true)
  const [whisperModel, setWhisperModel] = useState('base-q5_1')
  const [aiModel, setAiModel] = useState('')
  const [aiVisionModel, setAiVisionModel] = useState('')
  const [dubTargetLanguage, setDubTargetLanguage] = useState('')

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [weights, setWeights] = useState({
    hookStrength: 0.2,
    storyCompleteness: 0.2,
    emotionalImpact: 0.15,
    informationValue: 0.15,
    audienceInterest: 0.15,
    endingPayoff: 0.1,
    visualQuality: 0.05
  })

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    api
      .getCapabilities()
      .then((c) => {
        setCaps(c)
        if (c.ai.selectedModel) setAiModel(c.ai.selectedModel)
        if (c.ai.selectedVisionModel) setAiVisionModel(c.ai.selectedVisionModel)
      })
      .catch(() => {})
  }, [])

  const handlePreview = async () => {
    if (!youtubeUrl.trim()) return
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const info = await api.previewYouTube(youtubeUrl.trim())
      setPreview(info)
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to preview video')
      setPreview(null)
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!youtubeUrl.trim()) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const res = await api.createProject({
        youtubeUrl: youtubeUrl.trim(),
        title: preview?.title,
        author: preview?.author,
        thumbnailUrl: preview?.thumbnailUrl ?? null,
        autoStart: true,
        config: {
          minClipDurationSec,
          maxClipDurationSec: Math.max(minClipDurationSec + 5, maxClipDurationSec),
          targetClipCount,
          compositionMode,
          subtitlePreset,
          renderQuality,
          videoQualityPref,
          enableVisionAnalysis,
          aiModel: aiModel || undefined,
          aiVisionModel: aiVisionModel || undefined,
          whisperModel,
          autoRenderTopClips,
          scoringWeights: weights,
          dubbingConfig: dubTargetLanguage
            ? { enabled: true, targetLanguage: dubTargetLanguage }
            : null
        }
      })
      navigate(`/projects/${res.project.id}/processing`)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create project')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Create New Project</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Resolve a YouTube video using Ytora, configure viral detection &amp; 9:16 face-tracking, and launch the pipeline.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* URL Input + Preview */}
        <div className="rounded-2xl border border-white/[0.08] bg-[#07090b] p-6">
          <label className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Youtube className="h-4 w-4 text-rose-400" />
            YouTube Video URL (only content you own or have permission to process)
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              value={youtubeUrl}
              onChange={(e) => setYoutubeUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="flex-1 rounded-xl border border-white/[0.1] bg-[#030406] px-4 py-2.5 text-sm text-white placeholder-zinc-500 transition focus:border-[#00f0ff]/70 focus:ring-1 focus:ring-[#00f0ff]/25 focus:outline-none"
              required
            />
            <button
              type="button"
              onClick={handlePreview}
              disabled={previewLoading || !youtubeUrl.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#00f0ff]/35 bg-[#00f0ff]/10 px-4 py-2.5 text-sm font-medium text-[#66f7ff] transition hover:bg-[#00f0ff]/20 disabled:opacity-50"
            >
              {previewLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              Preview Video
            </button>
          </div>

          {previewError && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {previewError}
            </div>
          )}

          {preview && (
            <div className="mt-4 flex flex-col gap-4 rounded-xl border border-white/[0.08] bg-[#030406] p-4 sm:flex-row">
              {preview.thumbnailUrl && (
                <img
                  src={preview.thumbnailUrl}
                  alt={preview.title}
                  className="h-28 w-48 shrink-0 rounded-lg object-cover ring-1 ring-white/[0.08]"
                />
              )}
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="text-sm font-semibold text-white">{preview.title}</div>
                <div className="text-xs text-zinc-400">
                  {preview.author} · {Math.floor(preview.durationSec / 60)}m{' '}
                  {preview.durationSec % 60}s
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {preview.formats.slice(0, 6).map((f) => (
                    <span
                      key={f.itag}
                      className="rounded-md border border-white/[0.07] bg-black px-2 py-0.5 font-mono text-[11px] text-zinc-300"
                    >
                      {f.qualityLabel || `${f.height}p`} {f.codecs.split('.')[0]}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Clip & Tracking Configuration */}
        <div className="space-y-5 rounded-2xl border border-white/[0.08] bg-[#07090b] p-6">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Sliders className="h-4 w-4 text-[#00f0ff]" />
            Clip Selection, Tracking &amp; Rendering Settings
          </div>

          <div className="grid gap-5 sm:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                Min Duration (<span className="font-mono text-[#66f7ff]">{minClipDurationSec}s</span>)
              </label>
              <input
                type="range"
                min={10}
                max={60}
                value={minClipDurationSec}
                onChange={(e) => setMinClipDurationSec(Number(e.target.value))}
                className="w-full accent-[#00e8f5]"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                Max Duration (<span className="font-mono text-[#66f7ff]">{maxClipDurationSec}s</span>)
              </label>
              <input
                type="range"
                min={20}
                max={120}
                value={maxClipDurationSec}
                onChange={(e) => setMaxClipDurationSec(Number(e.target.value))}
                className="w-full accent-[#00e8f5]"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                Number of Clips
              </label>
              <input
                type="number"
                min={1}
                max={12}
                value={targetClipCount}
                onChange={(e) => setTargetClipCount(Number(e.target.value))}
                className="w-full rounded-xl border border-white/[0.1] bg-[#030406] px-3 py-2 text-sm text-white focus:border-[#00f0ff]/70 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                Face Composition
              </label>
              <select
                value={compositionMode}
                onChange={(e) => setCompositionMode(e.target.value as CompositionMode)}
                className="w-full rounded-xl border border-white/[0.1] bg-[#030406] px-3 py-2 text-sm text-white focus:border-[#00f0ff]/70 focus:outline-none"
              >
                <option value="smart">Smart Auto</option>
                <option value="single">Single Active Speaker</option>
                <option value="dual">Dual Speaker</option>
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                Subtitle Preset
              </label>
              <select
                value={subtitlePreset}
                onChange={(e) => setSubtitlePreset(e.target.value as SubtitlePresetName)}
                className="w-full rounded-xl border border-white/[0.1] bg-[#030406] px-3 py-2 text-sm text-white focus:border-[#00f0ff]/70 focus:outline-none"
              >
                <option value="modern">Modern</option>
                <option value="minimal">Minimal</option>
                <option value="bold">Bold</option>
                <option value="podcast">Podcast</option>
                <option value="gaming">Gaming</option>
                <option value="educational">Educational</option>
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                Source Download
              </label>
              <select
                value={videoQualityPref}
                onChange={(e) => setVideoQualityPref(e.target.value as typeof videoQualityPref)}
                className="w-full rounded-xl border border-white/[0.1] bg-[#030406] px-3 py-2 text-sm text-white focus:border-[#00f0ff]/70 focus:outline-none"
              >
                <option value="1080p">1080p (Recommended)</option>
                <option value="720p">720p (Low Disk/RAM)</option>
                <option value="1440p">1440p</option>
                <option value="2160p">4K (2160p)</option>
                <option value="best">Best Available</option>
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                Export Quality
              </label>
              <select
                value={renderQuality}
                onChange={(e) => setRenderQuality(e.target.value as RenderQuality)}
                className="w-full rounded-xl border border-white/[0.1] bg-[#030406] px-3 py-2 text-sm text-white focus:border-[#00f0ff]/70 focus:outline-none"
              >
                <option value="high">High (CRF 18)</option>
                <option value="medium">Medium (CRF 22)</option>
                <option value="ultra">Ultra (CRF 16)</option>
                <option value="low">Fast / Compact</option>
              </select>
            </div>
          </div>

          {/* AI Analysis Options */}
          <div className="space-y-3 rounded-xl border border-white/[0.08] bg-[#030406] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
                <Sparkles className="h-3.5 w-3.5 text-[#00f0ff]" />
                AI Understanding &amp; Vision Options
                {caps && (
                  <span className="rounded-full border border-white/[0.08] bg-black px-2 py-0.5 text-[11px] text-zinc-400">
                    {caps.ai.reachable
                      ? `${caps.ai.availableModels.length} models detected`
                      : 'Heuristic fallback (no API key configured)'}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="text-xs font-medium text-[#33f3ff] hover:text-[#80fbff]"
              >
                {showAdvanced ? 'Hide Scoring Weights' : 'Configure Scoring Weights'}
              </button>
            </div>

            <div className="flex flex-wrap gap-6 text-xs text-zinc-300">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={enableVisionAnalysis}
                  onChange={(e) => setEnableVisionAnalysis(e.target.checked)}
                  className="rounded border-zinc-700 bg-black accent-[#00e8f5]"
                />
                Enable AI sampled-frame visual analysis
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={autoRenderTopClips}
                  onChange={(e) => setAutoRenderTopClips(e.target.checked)}
                  className="rounded border-zinc-700 bg-black accent-[#00e8f5]"
                />
                Auto-render selected clips immediately (uncheck to review before rendering)
              </label>
            </div>

            <div className="grid gap-3 pt-1 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-[11px] text-zinc-400">
                  Speech Recognition (whisper.cpp)
                </label>
                <select
                  value={whisperModel}
                  onChange={(e) => setWhisperModel(e.target.value)}
                  className="w-full rounded-lg border border-white/[0.1] bg-black px-2.5 py-1.5 text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
                >
                  <option value="base-q5_1">Multilingual Auto + Translate (base-q5_1)</option>
                  <option value="tiny.en-q5_1">Fast English-only (tiny.en-q5_1)</option>
                </select>
              </div>
              {caps?.ai.availableModels && caps.ai.availableModels.length > 0 && (
                <>
                  <div>
                    <label className="mb-1 block text-[11px] text-zinc-400">Text Model</label>
                    <select
                      value={aiModel}
                      onChange={(e) => setAiModel(e.target.value)}
                      className="w-full rounded-lg border border-white/[0.1] bg-black px-2.5 py-1.5 text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
                    >
                      {caps.ai.availableModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-zinc-400">Vision Model</label>
                    <select
                      value={aiVisionModel}
                      onChange={(e) => setAiVisionModel(e.target.value)}
                      className="w-full rounded-lg border border-white/[0.1] bg-black px-2.5 py-1.5 text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
                    >
                      {caps.ai.availableModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>

            {/* Multi-Speaker AI Dubbing Selector */}
            <div className="border-t border-white/[0.06] pt-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <Languages className="h-3.5 w-3.5 text-[#00f0ff]" />
                    AI Dubbing (English source → Target language)
                  </label>
                  <select
                    value={dubTargetLanguage}
                    onChange={(e) => setDubTargetLanguage(e.target.value)}
                    className="w-full rounded-lg border border-white/[0.1] bg-black px-2.5 py-1.5 text-xs text-white focus:border-[#00f0ff]/70 focus:outline-none"
                  >
                    <option value="">Original Audio (No Dubbing)</option>
                    {(caps?.dubbing?.languages ?? []).map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.name} ({lang.nativeName})
                      </option>
                    ))}
                  </select>
                </div>

                {dubTargetLanguage && (
                  <div className="flex flex-col justify-end text-[11px]">
                    {caps?.dubbing?.configured ? (
                      <div className="rounded-lg border border-[#00f0ff]/25 bg-[#00f0ff]/8 px-3 py-1.5 text-[#66f7ff]">
                        Multi-speaker M/F voice detection enabled ({caps.dubbing.model})
                      </div>
                    ) : (
                      <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-1.5 text-amber-300">
                        Set GEMINI_API_KEY in .env to enable dubbing audio synthesis.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {showAdvanced && (
              <div className="grid gap-3 border-t border-white/[0.08] pt-3 sm:grid-cols-4">
                {Object.entries(weights).map(([k, val]) => (
                  <div key={k}>
                    <label className="mb-1 block text-[11px] text-zinc-400">
                      {k} ({Math.round(val * 100)}%)
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={0.5}
                      step={0.05}
                      value={val}
                      onChange={(e) =>
                        setWeights((prev) => ({ ...prev, [k]: Number(e.target.value) }))
                      }
                      className="w-full accent-[#00e8f5]"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {submitError && (
          <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {submitError}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button
            type="submit"
            disabled={submitting || !youtubeUrl.trim()}
            className="inline-flex items-center gap-2 rounded-xl bg-[#00e8f5] px-6 py-3 text-sm font-semibold text-[#021216] shadow-[0_0_26px_-4px_rgba(0,240,255,0.5)] transition hover:bg-[#33f3ff] hover:shadow-[0_0_32px_-2px_rgba(0,240,255,0.65)] disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4 fill-current" />
            )}
            Start Processing Pipeline
          </button>
        </div>
      </form>
    </div>
  )
}
