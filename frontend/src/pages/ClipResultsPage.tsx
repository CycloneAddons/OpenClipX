import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Download,
  Film,
  Loader2,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  X
} from 'lucide-react'
import { api } from '../api/client'
import { ScoreBreakdownBar } from '../components/ScoreBreakdownBar'
import { StatusBadge } from '../components/StatusBadge'
import type { ClipRecord, ProjectRecord } from '../types'

const ACTIVE_CLIP_STATES = new Set([
  'PENDING',
  'TRACKING_FACES',
  'DUBBING',
  'GENERATING_SUBTITLES',
  'RENDERING'
])

function formatTimecode(sec: number): string {
  const whole = Math.max(0, Math.round(sec))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

export function ClipResultsPage() {
  const { id } = useParams<{ id: string }>()
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [clips, setClips] = useState<ClipRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})
  const [showContext, setShowContext] = useState(false)
  const [submittingIds, setSubmittingIds] = useState<Record<string, boolean>>({})
  const [renderVersions, setRenderVersions] = useState<Record<string, number>>({})
  const [mountSeed] = useState(() => Date.now())
  const prevStatusRef = useRef<Record<string, string>>({})

  const load = useCallback(async () => {
    if (!id) return
    try {
      const res = await api.getProject(id)
      setProject(res.project)
      setClips(res.clips)

      const bumped: string[] = []
      const nextStatuses: Record<string, string> = {}
      for (const clip of res.clips) {
        const prev = prevStatusRef.current[clip.id]
        if (prev && prev !== 'COMPLETED' && clip.status === 'COMPLETED') {
          bumped.push(clip.id)
        }
        nextStatuses[clip.id] = clip.status
      }
      prevStatusRef.current = nextStatuses

      if (bumped.length > 0) {
        setRenderVersions((prev) => {
          const updated = { ...prev }
          for (const clipId of bumped) {
            updated[clipId] = (updated[clipId] ?? 0) + 1
          }
          return updated
        })
      }
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      void load()
    }, 3500)
    return () => clearInterval(timer)
  }, [load])

  const handleToggleApprove = async (clip: ClipRecord) => {
    const nextApproved = !clip.approved
    setClips((prev) =>
      prev.map((item) => (item.id === clip.id ? { ...item, approved: nextApproved } : item))
    )
    try {
      await api.updateClip(clip.id, { approved: nextApproved })
      await load()
    } catch {
      await load()
    }
  }

  const handleRenderClip = async (clipId: string) => {
    setSubmittingIds((prev) => ({ ...prev, [clipId]: true }))
    if (activePreviewId === clipId) {
      setActivePreviewId(null)
    }
    try {
      await api.renderClip(clipId, {})
      setRenderVersions((prev) => ({ ...prev, [clipId]: (prev[clipId] ?? 0) + 1 }))
      await load()
    } finally {
      setSubmittingIds((prev) => ({ ...prev, [clipId]: false }))
    }
  }

  const toggleExpanded = (clipId: string) => {
    setExpandedIds((prev) => ({ ...prev, [clipId]: !prev[clipId] }))
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin text-[#00f0ff]" />
        <span>Loading clips...</span>
      </div>
    )
  }

  const readyCount = clips.filter((c) => c.status === 'COMPLETED').length
  const approvedCount = clips.filter((c) => c.approved).length
  const avgScore =
    clips.length > 0 ? clips.reduce((acc, c) => acc + c.overallScore, 0) / clips.length : 0

  return (
    <div className="space-y-5">
      {/* Compact Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <Link
              to="/"
              title="Back to Dashboard"
              aria-label="Back to Dashboard"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.1] bg-[#080b0e] text-zinc-400 transition hover:border-[#00f0ff]/35 hover:text-[#66f7ff]"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="truncate text-xl font-bold tracking-tight text-white">
              {project?.title || 'Clips'}
            </h1>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-10.5 text-xs text-zinc-500">
            <span className="tabular-nums">
              {clips.length} {clips.length === 1 ? 'clip' : 'clips'}
            </span>
            {clips.length > 0 && readyCount < clips.length && (
              <span>· {readyCount} ready</span>
            )}
            {approvedCount > 0 && (
              <span className="text-emerald-400/90">· {approvedCount} approved</span>
            )}
            {clips.length > 0 && (
              <span className="tabular-nums text-zinc-400">· avg {avgScore.toFixed(1)}</span>
            )}
            {project?.visualAnalysis?.contentType && (
              <span className="capitalize">· {project.visualAnalysis.contentType}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {project?.visualAnalysis && (
            <button
              type="button"
              onClick={() => setShowContext((v) => !v)}
              aria-expanded={showContext}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                showContext
                  ? 'border-[#00f0ff]/40 bg-[#00f0ff]/12 text-[#66f7ff]'
                  : 'border-white/[0.1] bg-[#080b0e] text-zinc-300 hover:border-[#00f0ff]/35 hover:text-[#66f7ff]'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5 text-[#00f0ff]" />
              AI Context
            </button>
          )}
          <Link
            to={`/projects/${id}/processing`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#080b0e] px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-[#00f0ff]/35 hover:text-[#66f7ff]"
          >
            <Activity className="h-3.5 w-3.5 text-zinc-400" />
            Pipeline
          </Link>
        </div>
      </div>

      {/* Optional Collapsible AI Visual Context */}
      {showContext && project?.visualAnalysis && (
        <div className="rounded-xl border border-[#00f0ff]/25 bg-[#00f0ff]/[0.05] px-4 py-3 text-xs leading-relaxed text-zinc-300">
          <span className="font-semibold capitalize text-[#66f7ff]">
            {project.visualAnalysis.contentType}:{' '}
          </span>
          <span className="text-zinc-400">{project.visualAnalysis.notes}</span>
        </div>
      )}

      {/* Clips Grid */}
      {clips.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.08] bg-[#07090b] p-10 text-center">
          <Film className="mx-auto mb-2.5 h-6 w-6 text-zinc-600" />
          <p className="text-sm text-zinc-400">No clip candidates generated yet.</p>
          <Link
            to={`/projects/${id}/processing`}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-[#00f0ff]/30 bg-[#00f0ff]/10 px-3.5 py-1.5 text-xs font-medium text-[#66f7ff] transition hover:bg-[#00f0ff]/20"
          >
            <Activity className="h-3.5 w-3.5" />
            View Pipeline Progress
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {clips.map((clip) => {
            const isCompleted = clip.status === 'COMPLETED'
            const isFailed = clip.status === 'FAILED'
            const isBusy = Boolean(submittingIds[clip.id]) || ACTIVE_CLIP_STATES.has(clip.status)
            const isPlaying = isCompleted && activePreviewId === clip.id
            const isExpanded = Boolean(expandedIds[clip.id])
            const cacheTag = `v=${mountSeed}-${renderVersions[clip.id] ?? 0}-${clip.outputSizeBytes ?? 0}`

            return (
              <div
                key={clip.id}
                className={`overflow-hidden rounded-2xl border bg-[#07090b] transition ${
                  clip.approved
                    ? 'border-emerald-500/35'
                    : 'border-white/[0.08] hover:border-[#00f0ff]/30'
                }`}
              >
                {/* 9:16 Video / Thumbnail */}
                <div className="relative aspect-[9/16] bg-black">
                  {!isPlaying && (
                    <div className="pointer-events-none absolute inset-x-2.5 top-2.5 z-10 flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/75 px-2.5 py-0.5 text-[11px] backdrop-blur-md">
                        <span className="font-mono text-zinc-400">#{clip.rank}</span>
                        <span className="font-mono font-semibold tabular-nums text-[#4ff8ff]">
                          {clip.overallScore.toFixed(1)}
                        </span>
                      </span>
                      <span className="rounded-full border border-white/10 bg-black/75 px-2 py-0.5 font-mono text-[11px] tabular-nums text-zinc-200 backdrop-blur-md">
                        {formatTimecode(clip.durationSec)}
                      </span>
                    </div>
                  )}

                  {isPlaying && (
                    <button
                      type="button"
                      onClick={() => setActivePreviewId(null)}
                      title="Close preview"
                      aria-label="Close preview"
                      className="absolute top-2.5 right-2.5 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/80 text-zinc-200 backdrop-blur-md transition hover:border-[#00f0ff]/45 hover:text-white"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}

                  {isPlaying ? (
                    <video
                      src={`/api/clips/${clip.id}/video?${cacheTag}`}
                      controls
                      autoPlay
                      playsInline
                      className="h-full w-full object-contain"
                    />
                  ) : isCompleted ? (
                    <button
                      type="button"
                      onClick={() => setActivePreviewId(clip.id)}
                      aria-label={`Play ${clip.title}`}
                      className="group relative h-full w-full"
                    >
                      <img
                        src={`/api/clips/${clip.id}/thumbnail?${cacheTag}`}
                        alt={clip.title}
                        loading="lazy"
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
                      />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition group-hover:opacity-100">
                        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#00e8f5] text-[#021216] shadow-[0_0_24px_rgba(0,240,255,0.55)]">
                          <Play className="ml-0.5 h-5 w-5 fill-current" />
                        </span>
                      </div>
                    </button>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2.5 p-4 text-center">
                      {isBusy ? (
                        <Loader2 className="h-6 w-6 animate-spin text-[#00f0ff]" />
                      ) : isFailed ? (
                        <AlertTriangle className="h-6 w-6 text-rose-400" />
                      ) : (
                        <Film className="h-6 w-6 text-zinc-600" />
                      )}
                      <StatusBadge status={clip.status} />
                    </div>
                  )}
                </div>

                {/* Minimal Card Footer */}
                <div className="space-y-2.5 p-3">
                  <div className="space-y-1">
                    <h2
                      className="line-clamp-2 min-h-[2.375rem] text-[13px] font-semibold leading-snug text-white"
                      title={clip.title}
                    >
                      {clip.title}
                    </h2>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-500">
                      <span className="truncate font-mono tabular-nums">
                        {formatTimecode(clip.startTimeSec)} – {formatTimecode(clip.endTimeSec)}
                        {clip.dubbingConfig?.enabled && clip.dubbingPlan
                          ? ` · DUB ${clip.dubbingConfig.targetLanguage.toUpperCase()}`
                          : ''}
                        {clip.outputSizeBytes
                          ? ` · ${(clip.outputSizeBytes / (1024 * 1024)).toFixed(1)} MB`
                          : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleExpanded(clip.id)}
                        aria-expanded={isExpanded}
                        className={`inline-flex shrink-0 items-center gap-0.5 font-medium transition ${
                          isExpanded ? 'text-[#66f7ff]' : 'text-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        <span>Details</span>
                        <ChevronDown
                          className={`h-3 w-3 transition-transform ${
                            isExpanded ? 'rotate-180' : ''
                          }`}
                        />
                      </button>
                    </div>
                  </div>

                  {clip.errorMessage && (
                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] leading-snug text-rose-300">
                      {clip.errorMessage}
                    </div>
                  )}

                  {/* Single-row Action Bar */}
                  <div className="flex items-center gap-1 pt-0.5">
                    {isCompleted ? (
                      <a
                        href={`/api/clips/${clip.id}/download`}
                        className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#00e8f5] px-2 text-xs font-semibold text-[#021216] shadow-[0_0_18px_-5px_rgba(0,240,255,0.45)] transition hover:bg-[#33f3ff]"
                      >
                        <Download className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">Download</span>
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleRenderClip(clip.id)}
                        disabled={isBusy}
                        className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#00f0ff]/35 bg-[#00f0ff]/12 px-2 text-xs font-medium text-[#66f7ff] transition hover:bg-[#00f0ff]/22 disabled:opacity-50"
                      >
                        <RefreshCw
                          className={`h-3.5 w-3.5 shrink-0 ${isBusy ? 'animate-spin' : ''}`}
                        />
                        <span className="truncate">{isBusy ? 'Rendering' : 'Render'}</span>
                      </button>
                    )}

                    <Link
                      to={`/clips/${clip.id}/edit`}
                      title="Open Video Editor"
                      className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg border border-white/[0.1] bg-[#0a0d10] px-2 text-xs font-medium text-zinc-200 transition hover:border-[#00f0ff]/40 hover:bg-[#00f0ff]/10 hover:text-[#66f7ff]"
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" />
                      <span>Edit</span>
                    </Link>

                    {isCompleted && (
                      <button
                        type="button"
                        onClick={() => handleRenderClip(clip.id)}
                        disabled={isBusy}
                        title="Re-render clip"
                        aria-label="Re-render clip"
                        className="inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.1] bg-[#0a0d10] text-zinc-400 transition hover:border-[#00f0ff]/40 hover:text-[#66f7ff] disabled:opacity-50"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${isBusy ? 'animate-spin' : ''}`} />
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleToggleApprove(clip)}
                      title={clip.approved ? 'Approved' : 'Approve clip'}
                      aria-label={clip.approved ? 'Approved' : 'Approve clip'}
                      aria-pressed={clip.approved}
                      className={`inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-lg border transition ${
                        clip.approved
                          ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300'
                          : 'border-white/[0.1] bg-[#0a0d10] text-zinc-500 hover:border-white/20 hover:text-zinc-200'
                      }`}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Collapsible Details Drawer */}
                  {isExpanded && (
                    <div className="space-y-3 border-t border-white/[0.06] pt-3 text-[11px] leading-relaxed">
                      <div className="flex items-center justify-between text-zinc-500">
                        <span className="capitalize">
                          {clip.compositionMode} · {clip.engagementPotential}
                        </span>
                        <span className="font-mono tabular-nums text-zinc-400">
                          {clip.startTimeSec.toFixed(1)}s–{clip.endTimeSec.toFixed(1)}s
                        </span>
                      </div>

                      {clip.hook && (
                        <p className="text-zinc-300">
                          <span className="font-medium text-amber-300/90">Hook: </span>
                          {clip.hook}
                        </p>
                      )}

                      {clip.reason && (
                        <p className="text-zinc-400">
                          <span className="font-medium text-zinc-300">Note: </span>
                          {clip.reason}
                        </p>
                      )}

                      <ScoreBreakdownBar breakdown={clip.scoreBreakdown} compact />

                      <div className="max-h-28 overflow-y-auto rounded-lg border border-white/[0.06] bg-black/75 p-2.5 text-zinc-400">
                        {(clip.dubbingConfig?.enabled && clip.dubbingPlan?.dubbedTranscriptText) ||
                          clip.transcriptText ||
                          'No speech detected in clip window.'}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
