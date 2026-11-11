import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Activity,
  Ban,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  Film,
  Layers,
  Loader2,
  RotateCcw,
  Terminal,
  XCircle
} from 'lucide-react'
import { api } from '../api/client'
import { StatusBadge } from '../components/StatusBadge'
import type { ClipRecord, JobState, MemorySnapshot, ProjectRecord } from '../types'

const BASE_STAGES: JobState[] = [
  'QUEUED',
  'DOWNLOADING',
  'EXTRACTING',
  'TRANSCRIBING',
  'ANALYZING',
  'SELECTING_CLIPS',
  'TRACKING_FACES',
  'GENERATING_SUBTITLES',
  'RENDERING',
  'COMPLETED'
]

const DUB_STAGES: JobState[] = [
  'QUEUED',
  'DOWNLOADING',
  'EXTRACTING',
  'TRANSCRIBING',
  'ANALYZING',
  'SELECTING_CLIPS',
  'TRACKING_FACES',
  'DUBBING',
  'GENERATING_SUBTITLES',
  'RENDERING',
  'COMPLETED'
]

interface StageMeta {
  label: string
  shortLabel: string
  defaultDesc: string
}

const STAGE_META: Record<JobState, StageMeta> = {
  QUEUED: {
    label: 'Job Queue',
    shortLabel: 'Queued',
    defaultDesc: 'Waiting in FIFO execution queue'
  },
  DOWNLOADING: {
    label: 'Video Download',
    shortLabel: 'Download',
    defaultDesc: 'Fetching source video via Ytora or local file'
  },
  EXTRACTING: {
    label: 'Audio & Metadata',
    shortLabel: 'Extract',
    defaultDesc: 'FFprobe inspection & 16 kHz mono WAV'
  },
  TRANSCRIBING: {
    label: 'Speech Transcription',
    shortLabel: 'Transcribe',
    defaultDesc: 'Quantized whisper.cpp + 20 Hz RMS audio energy'
  },
  ANALYZING: {
    label: 'AI Context & Vision',
    shortLabel: 'Analyze',
    defaultDesc: 'Keyframes & multimodal context analysis'
  },
  SELECTING_CLIPS: {
    label: 'Viral Clip Selection',
    shortLabel: 'Select Clips',
    defaultDesc: '7-factor ranking, snapping & caption polish'
  },
  TRACKING_FACES: {
    label: 'Active-Speaker Tracking',
    shortLabel: 'Face Track',
    defaultDesc: 'YuNet + MediaPipe streamed face tracking'
  },
  DUBBING: {
    label: 'Multi-Speaker AI Dubbing',
    shortLabel: 'Dubbing',
    defaultDesc: 'Pitch + visual speaker detection & Gemini TTS dub'
  },
  GENERATING_SUBTITLES: {
    label: 'Animated Subtitles',
    shortLabel: 'Subtitles',
    defaultDesc: 'Face-safe word-level libass ASS captions'
  },
  RENDERING: {
    label: '9:16 Video Rendering',
    shortLabel: 'Render',
    defaultDesc: '1080×1920 libx264/AAC MP4 export'
  },
  COMPLETED: {
    label: 'Finalize & Cleanup',
    shortLabel: 'Completed',
    defaultDesc: 'Workspace cleanup & clips ready for review'
  },
  FAILED: {
    label: 'Failed',
    shortLabel: 'Failed',
    defaultDesc: 'Pipeline encountered an error'
  },
  CANCELLED: {
    label: 'Cancelled',
    shortLabel: 'Cancelled',
    defaultDesc: 'Processing cancelled by user'
  }
}

interface LogEntry {
  timestamp: string
  level?: string
  scope: string
  message: string
}

interface StageSnapshot {
  percent: number
  detail: string
}

type VisualStageState = 'done' | 'active' | 'pending' | 'failed' | 'cancelled' | 'skipped'

interface ComputedStageRow {
  stage: JobState
  stepNumber: number
  label: string
  shortLabel: string
  visualState: VisualStageState
  percent: number
  detail: string
  subBadge?: string
}

function isPipelineStage(scope: string): scope is JobState {
  return (DUB_STAGES as string[]).includes(scope)
}

function computeClipProgress(
  clip: ClipRecord,
  isActiveClip: boolean,
  activeStage: JobState | undefined,
  activeStagePct: number
): { percent: number; label: string; visualState: VisualStageState } {
  const effectiveStatus = isActiveClip && activeStage ? activeStage : clip.status
  const hasDub = Boolean(clip.dubbingConfig?.enabled)
  if (clip.status === 'COMPLETED' && !(isActiveClip && activeStage && activeStage !== 'COMPLETED')) {
    return { percent: 100, label: 'Ready', visualState: 'done' }
  }
  if (effectiveStatus === 'FAILED') {
    return { percent: 100, label: 'Failed', visualState: 'failed' }
  }
  if (effectiveStatus === 'CANCELLED') {
    return { percent: 100, label: 'Cancelled', visualState: 'cancelled' }
  }
  if (effectiveStatus === 'TRACKING_FACES') {
    const cap = hasDub ? 28 : 35
    const pct = Math.max(4, Math.min(cap, Math.round((activeStagePct * cap) / 100)))
    return {
      percent: pct,
      label: `Tracking ${isActiveClip ? `${activeStagePct}%` : '...'}`,
      visualState: 'active'
    }
  }
  if (effectiveStatus === 'DUBBING') {
    const pct = Math.max(29, Math.min(58, Math.round(29 + activeStagePct * 0.29)))
    return {
      percent: pct,
      label: `Dubbing ${isActiveClip ? `${activeStagePct}%` : '...'}`,
      visualState: 'active'
    }
  }
  if (effectiveStatus === 'GENERATING_SUBTITLES') {
    const base = hasDub ? 59 : 36
    const pct = Math.max(base, Math.min(base + 8, Math.round(base + activeStagePct * 0.08)))
    return { percent: pct, label: 'Subtitles', visualState: 'active' }
  }
  if (effectiveStatus === 'RENDERING') {
    const base = hasDub ? 68 : 45
    const pct = Math.max(base, Math.min(99, Math.round(base + activeStagePct * ((99 - base) / 100))))
    return {
      percent: pct,
      label: `Rendering ${isActiveClip ? `${activeStagePct}%` : '...'}`,
      visualState: 'active'
    }
  }
  return { percent: 0, label: 'Pending', visualState: 'pending' }
}

export function ProcessingPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [clips, setClips] = useState<ClipRecord[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [memory, setMemory] = useState<MemorySnapshot | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [copiedLogs, setCopiedLogs] = useState(false)
  const [activeClipId, setActiveClipId] = useState<string | null>(null)
  const [stageSnapshots, setStageSnapshots] = useState<Partial<Record<JobState, StageSnapshot>>>({})

  const logBoxRef = useRef<HTMLDivElement>(null)
  const lastClipRefreshKeyRef = useRef<string>('')

  const syncProjectSnapshot = useCallback(async (projectId: string, isMounted?: () => boolean) => {
    const res = await api.getProject(projectId)
    if (isMounted && !isMounted()) return

    setProject(res.project)
    setClips(res.clips)
    setLogs(
      res.logs.map((l) => ({
        timestamp: l.createdAt,
        level: l.level,
        scope: l.scope,
        message: l.message
      }))
    )

    setStageSnapshots((prev) => {
      const next = { ...prev }
      for (const entry of res.logs) {
        if (isPipelineStage(entry.scope)) {
          const prevPct = next[entry.scope]?.percent ?? 0
          next[entry.scope] = {
            percent: prevPct,
            detail: entry.message
          }
        }
      }
      if (isPipelineStage(res.project.status)) {
        next[res.project.status] = {
          percent: res.project.stageProgress,
          detail: res.project.currentStageLabel || next[res.project.status]?.detail || ''
        }
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (!id) return
    let active = true

    syncProjectSnapshot(id, () => active).catch(() => {})

    const es = new EventSource(`/api/projects/${id}/events`)
    es.addEventListener('progress', (ev) => {
      const payload = JSON.parse((ev as MessageEvent).data) as {
        clipId?: string
        state: JobState
        stageProgress: number
        overallProgress: number
        message: string
        memory?: MemorySnapshot
      }

      setProject((prev) =>
        prev
          ? {
              ...prev,
              status: payload.state,
              stageProgress: payload.stageProgress,
              overallProgress: payload.overallProgress,
              currentStageLabel: payload.message
            }
          : prev
      )

      if (payload.clipId) {
        setActiveClipId(payload.clipId)
      } else if (payload.state === 'COMPLETED') {
        setActiveClipId(null)
      }

      if (isPipelineStage(payload.state)) {
        setStageSnapshots((prev) => ({
          ...prev,
          [payload.state]: {
            percent: payload.stageProgress,
            detail: payload.message
          }
        }))
      }

      if (payload.memory) setMemory(payload.memory)

      const shouldRefreshClips =
        (payload.state === 'SELECTING_CLIPS' && payload.stageProgress >= 100) ||
        payload.state === 'TRACKING_FACES' ||
        payload.state === 'DUBBING' ||
        payload.state === 'GENERATING_SUBTITLES' ||
        payload.state === 'RENDERING' ||
        payload.state === 'COMPLETED' ||
        payload.state === 'FAILED'

      if (shouldRefreshClips) {
        const key = `${payload.state}:${payload.clipId ?? ''}:${payload.stageProgress >= 100 ? '100' : ''}`
        if (key !== lastClipRefreshKeyRef.current) {
          lastClipRefreshKeyRef.current = key
          api
            .getProject(id)
            .then((res) => {
              if (!active) return
              setClips(res.clips)
              if (res.project) {
                setProject((curr) =>
                  curr
                    ? {
                        ...curr,
                        metadata: res.project.metadata ?? curr.metadata,
                        visualAnalysis: res.project.visualAnalysis ?? curr.visualAnalysis,
                        errorMessage: res.project.errorMessage ?? curr.errorMessage
                      }
                    : res.project
                )
              }
            })
            .catch(() => {})
        }
      }
    })

    es.addEventListener('log', (ev) => {
      const entry = JSON.parse((ev as MessageEvent).data) as LogEntry
      setLogs((prev) => [...prev.slice(-199), entry])
      if (isPipelineStage(entry.scope)) {
        setStageSnapshots((prev) => ({
          ...prev,
          [entry.scope]: {
            percent: prev[entry.scope as JobState]?.percent ?? 0,
            detail: entry.message
          }
        }))
      }
    })

    es.addEventListener('memory', (ev) => {
      setMemory(JSON.parse((ev as MessageEvent).data) as MemorySnapshot)
    })

    return () => {
      active = false
      es.close()
    }
  }, [id, syncProjectSnapshot])

  useEffect(() => {
    if (showLogs && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight
    }
  }, [logs, showLogs])

  const handleCancel = async () => {
    if (!id) return
    setCancelling(true)
    try {
      await api.cancelProject(id)
    } finally {
      setCancelling(false)
    }
  }

  const handleRetry = async () => {
    if (!id) return
    setStageSnapshots({})
    setActiveClipId(null)
    setClips([])
    lastClipRefreshKeyRef.current = ''
    await api.analyzeProject(id)
  }

  const handleCopyLogs = async () => {
    const text = logs
      .map(
        (entry) =>
          `[${new Date(entry.timestamp).toLocaleTimeString()}] [${entry.scope}] ${entry.message}`
      )
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopiedLogs(true)
      setTimeout(() => setCopiedLogs(false), 1800)
    } catch {
      // Clipboard may be unavailable in restricted contexts
    }
  }

  const dubStagesActive =
    Boolean(project?.config?.dubbingConfig?.enabled) ||
    clips.some((c) => Boolean(c.dubbingConfig?.enabled)) ||
    project?.status === 'DUBBING'
  const stagesList = dubStagesActive ? DUB_STAGES : BASE_STAGES

  const stageRows = useMemo<ComputedStageRow[]>(() => {
    const status = project?.status ?? 'QUEUED'
    const currentStagePct = project?.stageProgress ?? 0
    const visionEnabled = project?.config?.enableVisionAnalysis ?? true
    const autoRender = project?.config?.autoRenderTopClips ?? true

    // Find the last pipeline stage present in logs (essential when FAILED or CANCELLED)
    let lastStageSeen: JobState = 'QUEUED'
    for (let i = logs.length - 1; i >= 0; i--) {
      const sc = logs[i]?.scope
      if (sc && isPipelineStage(sc) && sc !== 'COMPLETED') {
        lastStageSeen = sc
        break
      }
    }

    const activeStageForCompare: JobState =
      status === 'FAILED' || status === 'CANCELLED' ? lastStageSeen : status

    const currentIdx = stagesList.indexOf(activeStageForCompare)
    const clipLoopActive =
      status === 'TRACKING_FACES' ||
      status === 'DUBBING' ||
      status === 'GENERATING_SUBTITLES' ||
      status === 'RENDERING'

    const totalClips = clips.length
    const activeClipIdx =
      activeClipId && totalClips > 0 ? clips.findIndex((c) => c.id === activeClipId) : -1

    return stagesList.map((stage, idx) => {
      const meta = STAGE_META[stage]
      const snap = stageSnapshots[stage]
      let visualState: VisualStageState = 'pending'
      let percent = 0
      let detail = snap?.detail || meta.defaultDesc
      let subBadge: string | undefined

      if (status === 'COMPLETED') {
        if (stage === 'ANALYZING' && !visionEnabled) {
          visualState = 'skipped'
          percent = 100
          detail = snap?.detail || 'Vision analysis disabled — transcript context used'
        } else if (
          (stage === 'TRACKING_FACES' ||
            stage === 'DUBBING' ||
            stage === 'GENERATING_SUBTITLES' ||
            stage === 'RENDERING') &&
          !autoRender &&
          totalClips > 0 &&
          clips.every((c) => c.status === 'PENDING')
        ) {
          visualState = 'skipped'
          percent = 0
          detail = 'Auto-render disabled — render manually in Clips'
        } else if (
          stage === 'DUBBING' &&
          totalClips > 0 &&
          clips.every((c) => !c.dubbedAudioPath)
        ) {
          visualState = 'skipped'
          percent = 100
          detail = 'Dubbing skipped (English source required)'
        } else {
          visualState = 'done'
          percent = 100
          if (
            totalClips > 0 &&
            (stage === 'TRACKING_FACES' ||
              stage === 'DUBBING' ||
              stage === 'GENERATING_SUBTITLES' ||
              stage === 'RENDERING')
          ) {
            const doneCount = clips.filter((c) => c.status === 'COMPLETED').length
            subBadge = `${doneCount}/${totalClips} clips`
          }
        }
        return {
          stage,
          stepNumber: idx + 1,
          label: meta.label,
          shortLabel: meta.shortLabel,
          visualState,
          percent,
          detail,
          subBadge
        }
      }

      if (stage === 'QUEUED') {
        if (status === 'QUEUED') {
          visualState = 'active'
          percent = 50
          detail = project?.currentStageLabel || meta.defaultDesc
        } else {
          visualState = 'done'
          percent = 100
          detail = snap?.detail || 'Started'
        }
        return {
          stage,
          stepNumber: idx + 1,
          label: meta.label,
          shortLabel: meta.shortLabel,
          visualState,
          percent,
          detail
        }
      }

      if (stage === 'COMPLETED') {
        visualState = 'pending'
        percent = 0
        return {
          stage,
          stepNumber: idx + 1,
          label: meta.label,
          shortLabel: meta.shortLabel,
          visualState,
          percent,
          detail
        }
      }

      // Multi-clip stages: compute aggregate progress across discovered clips when available
      if (
        totalClips > 0 &&
        (stage === 'TRACKING_FACES' ||
          stage === 'DUBBING' ||
          stage === 'GENERATING_SUBTITLES' ||
          stage === 'RENDERING')
      ) {
        let doneCount = 0
        for (let ci = 0; ci < clips.length; ci++) {
          const c = clips[ci]!
          const beforeActive = activeClipIdx > -1 && ci < activeClipIdx
          if (stage === 'TRACKING_FACES') {
            if (
              beforeActive ||
              c.status === 'DUBBING' ||
              c.status === 'GENERATING_SUBTITLES' ||
              c.status === 'RENDERING' ||
              c.status === 'COMPLETED' ||
              (c.id === activeClipId &&
                (status === 'DUBBING' ||
                  status === 'GENERATING_SUBTITLES' ||
                  status === 'RENDERING'))
            ) {
              doneCount++
            }
          } else if (stage === 'DUBBING') {
            if (
              beforeActive ||
              c.status === 'GENERATING_SUBTITLES' ||
              c.status === 'RENDERING' ||
              c.status === 'COMPLETED' ||
              (c.id === activeClipId &&
                (status === 'GENERATING_SUBTITLES' || status === 'RENDERING'))
            ) {
              doneCount++
            }
          } else if (stage === 'GENERATING_SUBTITLES') {
            if (
              beforeActive ||
              c.status === 'RENDERING' ||
              c.status === 'COMPLETED' ||
              (c.id === activeClipId && status === 'RENDERING')
            ) {
              doneCount++
            }
          } else if (stage === 'RENDERING') {
            if (beforeActive || c.status === 'COMPLETED') {
              doneCount++
            }
          }
        }

        const activeFraction =
          status === stage ? Math.max(0, Math.min(1, currentStagePct / 100)) : 0
        const computedPct = Math.min(
          100,
          Math.round(((Math.min(totalClips, doneCount) + (doneCount < totalClips ? activeFraction : 0)) / totalClips) * 100)
        )

        subBadge = `${Math.min(totalClips, doneCount)}/${totalClips} clips`

        if (status === 'FAILED' || status === 'CANCELLED') {
          if (doneCount >= totalClips) {
            visualState = 'done'
            percent = 100
          } else if (activeStageForCompare === stage) {
            visualState = status === 'FAILED' ? 'failed' : 'cancelled'
            percent = computedPct
            detail = project?.errorMessage || snap?.detail || meta.defaultDesc
          } else if (doneCount > 0 || clipLoopActive) {
            visualState = 'pending'
            percent = computedPct
          }
        } else if (doneCount >= totalClips) {
          visualState = 'done'
          percent = 100
          detail = `Completed for all ${totalClips} clips`
        } else if (status === stage) {
          visualState = 'active'
          percent = computedPct
          detail = project?.currentStageLabel || snap?.detail || meta.defaultDesc
        } else if (doneCount > 0 || idx < currentIdx || clipLoopActive) {
          visualState = 'pending'
          percent = computedPct
          detail =
            doneCount > 0
              ? `${doneCount} of ${totalClips} clips complete · waiting for next clip`
              : meta.defaultDesc
        }

        return {
          stage,
          stepNumber: idx + 1,
          label: meta.label,
          shortLabel: meta.shortLabel,
          visualState,
          percent,
          detail,
          subBadge
        }
      }

      // Single-pass stages (DOWNLOADING .. SELECTING_CLIPS or fallback before clips exist)
      if (status === 'FAILED' || status === 'CANCELLED') {
        if (currentIdx > idx) {
          if (stage === 'ANALYZING' && !visionEnabled) {
            visualState = 'skipped'
            percent = 100
            detail = 'Vision analysis disabled'
          } else {
            visualState = 'done'
            percent = 100
          }
        } else if (currentIdx === idx) {
          visualState = status === 'FAILED' ? 'failed' : 'cancelled'
          percent = snap?.percent ?? currentStagePct
          detail = project?.errorMessage || project?.currentStageLabel || snap?.detail || meta.defaultDesc
        } else {
          visualState = 'pending'
          percent = 0
        }
      } else if (currentIdx > idx) {
        if (stage === 'ANALYZING' && !visionEnabled) {
          visualState = 'skipped'
          percent = 100
          detail = snap?.detail || 'Vision analysis disabled — transcript context used'
        } else {
          visualState = 'done'
          percent = 100
        }
      } else if (currentIdx === idx) {
        visualState = 'active'
        percent = currentStagePct
        detail = project?.currentStageLabel || snap?.detail || meta.defaultDesc
      } else {
        visualState = 'pending'
        percent = 0
      }

      return {
        stage,
        stepNumber: idx + 1,
        label: meta.label,
        shortLabel: meta.shortLabel,
        visualState,
        percent,
        detail,
        subBadge
      }
    })
  }, [project, clips, logs, stageSnapshots, activeClipId, stagesList])

  const completedStagesCount = stageRows.filter(
    (s) => s.visualState === 'done' || s.visualState === 'skipped'
  ).length

  const isTerminal = project && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(project.status)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">
              {project?.title || 'Processing Pipeline'}
            </h1>
            {project && <StatusBadge status={project.status} />}
          </div>
          <p className="mt-1 text-sm text-zinc-400">
            {project?.currentStageLabel || 'Waiting for real-time telemetry...'}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {!isTerminal ? (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="inline-flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm font-medium text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-50"
            >
              <XCircle className="h-4 w-4" />
              {cancelling ? 'Cancelling...' : 'Cancel Processing'}
            </button>
          ) : project?.status === 'COMPLETED' ? (
            <button
              onClick={() => navigate(`/projects/${id}/clips`)}
              className="inline-flex items-center gap-2 rounded-xl bg-[#00e8f5] px-5 py-2.5 text-sm font-semibold text-[#021216] shadow-[0_0_24px_-4px_rgba(0,240,255,0.45)] transition hover:bg-[#33f3ff]"
            >
              <Film className="h-4 w-4" />
              View Generated Clips
            </button>
          ) : (
            <button
              onClick={handleRetry}
              className="inline-flex items-center gap-2 rounded-xl bg-[#00e8f5] px-4 py-2 text-sm font-semibold text-[#021216] shadow-[0_0_22px_-4px_rgba(0,240,255,0.45)] transition hover:bg-[#33f3ff]"
            >
              <RotateCcw className="h-4 w-4" />
              Retry Analysis
            </button>
          )}
        </div>
      </div>

      {/* Overall Progress + Live Memory */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-white/[0.08] bg-[#07090b] p-5 lg:col-span-2">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-zinc-200">Overall Pipeline Progress</span>
            <span className="font-mono tabular-nums text-[#4ff8ff]">
              {project?.overallProgress ?? 0}%
            </span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-zinc-900 ring-1 ring-white/[0.05]">
            <div
              className={`h-full transition-all duration-300 ${
                project?.status === 'FAILED'
                  ? 'bg-rose-500'
                  : project?.status === 'CANCELLED'
                    ? 'bg-amber-500'
                    : project?.status === 'COMPLETED'
                      ? 'bg-emerald-500'
                      : 'bg-gradient-to-r from-[#00b8d4] via-[#00e8f5] to-[#66f7ff]'
              }`}
              style={{ width: `${project?.overallProgress ?? 0}%` }}
            />
          </div>

          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {stageRows.map((row) => {
              const done = row.visualState === 'done' || row.visualState === 'skipped'
              const active = row.visualState === 'active'
              const failed = row.visualState === 'failed'
              const cancelled = row.visualState === 'cancelled'
              return (
                <div
                  key={row.stage}
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-[11px] font-medium ${
                    done
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : active
                        ? 'border-[#00f0ff]/45 bg-[#00f0ff]/12 text-[#7ef9ff] shadow-[0_0_16px_-6px_rgba(0,240,255,0.45)]'
                        : failed
                          ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                          : cancelled
                            ? 'border-amber-500/35 bg-amber-500/10 text-amber-300'
                            : 'border-white/[0.07] bg-[#030406] text-zinc-500'
                  }`}
                >
                  {done ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  ) : active ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#00f0ff]" />
                  ) : failed ? (
                    <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                  ) : cancelled ? (
                    <Ban className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                  ) : (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-zinc-700" />
                  )}
                  <span className="truncate">{row.shortLabel}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-[#07090b] p-5">
          <div className="flex items-center justify-between text-xs font-medium text-zinc-400">
            <span className="flex items-center gap-1.5">
              <Cpu className="h-4 w-4 text-[#00f0ff]" />
              Ram Usage
            </span>
            <span className="font-mono text-zinc-200">{memory?.pressure ?? 'NORMAL'}</span>
          </div>
          <div className="text-2xl font-semibold tabular-nums text-white">
            {memory ? `${memory.totalAppRssMb.toFixed(0)} MB` : '—'}
          </div>
          <div className="space-y-1 text-xs tabular-nums text-zinc-400">
            <div className="flex justify-between">
              <span>Node RSS:</span>
              <span className="font-mono text-zinc-200">
                {memory ? `${memory.processRssMb.toFixed(1)} MB` : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Worker Tree RSS:</span>
              <span className="font-mono text-zinc-200">
                {memory ? `${memory.childTreeRssMb.toFixed(1)} MB` : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Peak Observed RSS:</span>
              <span className="font-mono text-zinc-200">
                {memory ? `${memory.peakObservedAppRssMb.toFixed(1)} MB` : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>OS Available RAM:</span>
              <span className="font-mono text-zinc-200">
                {memory ? `${memory.systemAvailableMb} MB` : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Per-Stage Progress Bars (default) or Live Logs (toggled via Logs button) */}
      <div className="rounded-2xl border border-white/[0.08] bg-[#050709] p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {showLogs ? (
              <Terminal className="h-4 w-4 text-[#00f0ff]" />
            ) : (
              <Activity className="h-4 w-4 text-[#00f0ff]" />
            )}
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
              {showLogs ? 'Live Processing Logs' : 'Stage Progress Breakdown'}
            </span>
            <span className="rounded-full border border-white/[0.08] bg-[#0a0d10] px-2.5 py-0.5 font-mono text-[11px] tabular-nums text-zinc-400">
              {showLogs
                ? `${logs.length} ${logs.length === 1 ? 'entry' : 'entries'}`
                : `${completedStagesCount}/${stagesList.length} stages`}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {showLogs && (
              <button
                type="button"
                onClick={handleCopyLogs}
                disabled={logs.length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#0a0d10] px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-[#00f0ff]/40 hover:text-[#66f7ff] disabled:opacity-40"
              >
                {copiedLogs ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowLogs((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                showLogs
                  ? 'border-[#00f0ff]/45 bg-[#00f0ff]/12 text-[#66f7ff] shadow-[0_0_16px_-6px_rgba(0,240,255,0.45)] hover:bg-[#00f0ff]/20'
                  : 'border-white/[0.12] bg-[#0b0e12] text-zinc-200 hover:border-[#00f0ff]/40 hover:bg-[#00f0ff]/10 hover:text-[#66f7ff]'
              }`}
            >
              {showLogs ? (
                <>
                  <Layers className="h-3.5 w-3.5" />
                  Show Progress
                </>
              ) : (
                <>
                  <Terminal className="h-3.5 w-3.5 text-[#00f0ff]" />
                  Logs
                  <span className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-zinc-300">
                    {logs.length}
                  </span>
                </>
              )}
            </button>

            <Link
              to={`/projects/${id}/clips`}
              className="text-xs font-medium text-[#33f3ff] hover:underline"
            >
              Jump to Clips →
            </Link>
          </div>
        </div>

        {showLogs ? (
          <div
            ref={logBoxRef}
            className="h-80 overflow-y-auto rounded-xl border border-white/[0.06] bg-black p-3.5 font-mono text-xs leading-relaxed text-zinc-300"
          >
            {logs.length === 0 ? (
              <div className="text-zinc-600">Waiting for pipeline events...</div>
            ) : (
              logs.map((entry, idx) => (
                <div key={idx} className="whitespace-pre-wrap">
                  <span className="text-zinc-600">
                    [{new Date(entry.timestamp).toLocaleTimeString()}]
                  </span>{' '}
                  <span
                    className={
                      entry.level === 'error'
                        ? 'text-rose-400'
                        : entry.level === 'warn'
                          ? 'text-amber-400'
                          : 'text-[#2cefff]'
                    }
                  >
                    [{entry.scope}]
                  </span>{' '}
                  <span>{entry.message}</span>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-5">
            <div
              className={`grid grid-cols-1 gap-3 md:grid-flow-col md:grid-cols-2 ${
                stagesList.length > 10 ? 'md:grid-rows-6' : 'md:grid-rows-5'
              }`}
            >
              {stageRows.map((row) => {
                const barWidth =
                  row.visualState === 'active'
                    ? Math.max(4, row.percent)
                    : row.percent

                const hasPartialClipProgress =
                  row.visualState === 'pending' && row.percent > 0

                const barClass =
                  row.visualState === 'done'
                    ? 'bg-gradient-to-r from-emerald-500 to-emerald-400'
                    : row.visualState === 'skipped'
                      ? 'bg-emerald-500/50'
                      : row.visualState === 'active'
                        ? 'bg-gradient-to-r from-[#00b8d4] via-[#00e8f5] to-[#66f7ff] shadow-[0_0_12px_rgba(0,240,255,0.45)]'
                        : hasPartialClipProgress
                          ? 'bg-gradient-to-r from-emerald-500/80 to-[#00d8f0]/80'
                          : row.visualState === 'failed'
                            ? 'bg-rose-500'
                            : row.visualState === 'cancelled'
                              ? 'bg-amber-500/80'
                              : 'bg-zinc-800'

                const statusText =
                  row.visualState === 'done'
                    ? 'Done'
                    : row.visualState === 'skipped'
                      ? 'Skipped'
                      : row.visualState === 'active'
                        ? 'Running'
                        : hasPartialClipProgress
                          ? 'In Progress'
                          : row.visualState === 'failed'
                            ? 'Failed'
                            : row.visualState === 'cancelled'
                              ? 'Cancelled'
                              : 'Pending'

                const statusCls =
                  row.visualState === 'done'
                    ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/25'
                    : row.visualState === 'skipped'
                      ? 'text-zinc-300 bg-white/[0.05] border-white/[0.1]'
                      : row.visualState === 'active'
                        ? 'text-[#66f7ff] bg-[#00f0ff]/12 border-[#00f0ff]/35'
                        : hasPartialClipProgress
                          ? 'text-[#66f7ff]/85 bg-[#00f0ff]/8 border-[#00f0ff]/25'
                          : row.visualState === 'failed'
                            ? 'text-rose-300 bg-rose-500/12 border-rose-500/35'
                            : row.visualState === 'cancelled'
                              ? 'text-amber-300 bg-amber-500/12 border-amber-500/35'
                              : 'text-zinc-500 bg-black border-white/[0.06]'

                return (
                  <div
                    key={row.stage}
                    className={`rounded-xl border p-3.5 transition ${
                      row.visualState === 'active'
                        ? 'border-[#00f0ff]/40 bg-[#081014] shadow-[0_0_24px_-10px_rgba(0,240,255,0.35)]'
                        : row.visualState === 'failed'
                          ? 'border-rose-500/35 bg-[#12070a]'
                          : 'border-white/[0.07] bg-[#07090b]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        {row.visualState === 'done' || row.visualState === 'skipped' ? (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                        ) : row.visualState === 'active' ? (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#00f0ff]" />
                        ) : row.visualState === 'failed' ? (
                          <XCircle className="h-4 w-4 shrink-0 text-rose-400" />
                        ) : row.visualState === 'cancelled' ? (
                          <Ban className="h-4 w-4 shrink-0 text-amber-400" />
                        ) : (
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-white/[0.12] font-mono text-[9px] text-zinc-500">
                            {row.stepNumber}
                          </span>
                        )}
                        <span
                          className={`truncate text-sm font-medium ${
                            row.visualState === 'pending' ? 'text-zinc-400' : 'text-white'
                          }`}
                        >
                          {row.label}
                        </span>
                        {row.subBadge && (
                          <span className="shrink-0 rounded-md border border-white/[0.08] bg-black px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-zinc-300">
                            {row.subBadge}
                          </span>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={`rounded-md border px-2 py-0.5 text-[10px] font-medium ${statusCls}`}
                        >
                          {statusText}
                        </span>
                        <span
                          className={`w-10 text-right font-mono text-xs font-semibold tabular-nums ${
                            row.visualState === 'active'
                              ? 'text-[#66f7ff]'
                              : row.visualState === 'done'
                                ? 'text-emerald-300'
                                : row.visualState === 'failed'
                                  ? 'text-rose-300'
                                  : 'text-zinc-400'
                          }`}
                        >
                          {row.percent}%
                        </span>
                      </div>
                    </div>

                    <p
                      className="mt-1.5 truncate text-xs text-zinc-400"
                      title={row.detail}
                    >
                      {row.detail}
                    </p>

                    <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-zinc-900 ring-1 ring-white/[0.05]">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${barClass}`}
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            {clips.length > 0 && (
              <div className="border-t border-white/[0.07] pt-4">
                <div className="mb-3 flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-zinc-400">
                    <Film className="h-3.5 w-3.5 text-[#00f0ff]" />
                    Per-Clip Output Progress
                  </span>
                  <span className="font-mono tabular-nums text-zinc-400">
                    {clips.filter((c) => c.status === 'COMPLETED').length}/{clips.length} ready
                  </span>
                </div>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {clips.map((clip) => {
                    const effectiveActiveClipId =
                      activeClipId ??
                      clips.find((c) =>
                        ['TRACKING_FACES', 'DUBBING', 'GENERATING_SUBTITLES', 'RENDERING'].includes(c.status)
                      )?.id ??
                      null
                    const isActive = effectiveActiveClipId === clip.id
                    const clipProg = computeClipProgress(
                      clip,
                      isActive,
                      isActive && project ? project.status : undefined,
                      project?.stageProgress ?? 0
                    )
                    return (
                      <div
                        key={clip.id}
                        className={`rounded-xl border p-3 ${
                          clipProg.visualState === 'active'
                            ? 'border-[#00f0ff]/35 bg-[#081014]'
                            : 'border-white/[0.06] bg-[#040608]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate font-medium text-zinc-200">
                            <span className="mr-1.5 font-mono text-[#00f0ff]">#{clip.rank}</span>
                            {clip.title}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-400">
                            {clipProg.label} · {clipProg.percent}%
                          </span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-900">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${
                              clipProg.visualState === 'done'
                                ? 'bg-emerald-500'
                                : clipProg.visualState === 'failed'
                                  ? 'bg-rose-500'
                                  : clipProg.visualState === 'cancelled'
                                    ? 'bg-amber-500'
                                    : clipProg.visualState === 'active'
                                      ? 'bg-gradient-to-r from-[#00c8e0] to-[#00f8ff]'
                                      : 'bg-zinc-800'
                            }`}
                            style={{
                              width: `${
                                clipProg.visualState === 'active'
                                  ? Math.max(4, clipProg.percent)
                                  : clipProg.percent
                              }%`
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
