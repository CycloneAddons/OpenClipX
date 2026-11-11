import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  Cpu,
  Film,
  HardDrive,
  Plus,
  Sparkles,
  Trash2,
  Wrench
} from 'lucide-react'
import { api } from '../api/client'
import { StatusBadge } from '../components/StatusBadge'
import type { CapabilitiesResponse, ProjectRecord, SystemStats } from '../types'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function DashboardPage() {
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [cleaning, setCleaning] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const [pRes, sRes, cRes] = await Promise.all([
        api.listProjects(),
        api.getStats(),
        api.getCapabilities()
      ])
      setProjects(pRes.projects)
      setStats(sRes)
      setCaps(cRes)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      void Promise.all([api.listProjects(), api.getStats()])
        .then(([pRes, sRes]) => {
          setProjects(pRes.projects)
          setStats(sRes)
        })
        .catch(() => {})
    }, 4000)
    return () => clearInterval(timer)
  }, [])

  const handleCleanup = async () => {
    setCleaning(true)
    try {
      const res = await api.cleanupTemp()
      setMessage(`Cleaned temporary files (${formatBytes(res.reclaimedBytes)} reclaimed).`)
      await refresh()
    } finally {
      setCleaning(false)
    }
  }

  const handleDelete = async (id: string, title: string) => {
    if (!window.confirm(`Delete project "${title}" and all generated files?`)) return
    await api.deleteProject(id)
    await refresh()
  }

  const activeProjects = projects.filter(
    (p) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(p.status)
  )

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Studio Dashboard</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Ultra-lightweight Shorts studio — turn long-form YouTube videos into face-tracked, captioned 9:16 Shorts (even under 1.5 GB RAM).
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleCleanup}
            disabled={cleaning}
            className="inline-flex items-center gap-2 rounded-xl border border-white/[0.1] bg-[#080b0e] px-3.5 py-2 text-xs font-medium text-zinc-300 transition hover:border-[#00f0ff]/35 hover:bg-[#00f0ff]/10 hover:text-[#66f7ff] disabled:opacity-50"
          >
            <Wrench className="h-3.5 w-3.5" />
            {cleaning ? 'Cleaning...' : 'Clean Temp Storage'}
          </button>
          <Link
            to="/create"
            className="inline-flex items-center gap-2 rounded-xl bg-[#00e8f5] px-4 py-2 text-sm font-semibold text-[#021216] shadow-[0_0_24px_-4px_rgba(0,240,255,0.45)] transition hover:bg-[#33f3ff] hover:shadow-[0_0_28px_-2px_rgba(0,240,255,0.6)]"
          >
            <Plus className="h-4 w-4" />
            New Project
          </Link>
        </div>
      </div>

      {message && (
        <div className="rounded-xl border border-[#00f0ff]/30 bg-[#00f0ff]/10 px-4 py-3 text-sm text-[#7ef9ff]">
          {message}
        </div>
      )}

      {/* Telemetry Cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-white/[0.08] bg-[#07090b] p-5 transition hover:border-white/[0.14]">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>System &amp; App RAM</span>
            <Cpu className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="mt-2 text-2xl font-semibold tabular-nums text-white">
            {stats ? `${stats.memory.totalAppRssMb.toFixed(0)} MB` : '—'}
          </div>
          <div className="mt-1 text-xs tabular-nums text-zinc-500">
            {stats
              ? `Peak ${stats.memory.peakObservedAppRssMb.toFixed(0)} MB · OS Avail ${stats.memory.systemAvailableMb} MB`
              : 'Measuring...'}
          </div>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-[#07090b] p-5 transition hover:border-white/[0.14]">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>Processing Stats</span>
            <Film className="h-4 w-4 text-[#00f0ff]" />
          </div>
          <div className="mt-2 text-2xl font-semibold tabular-nums text-white">
            {stats ? `${stats.counts.renderedClips} / ${stats.counts.totalClips}` : '—'}
          </div>
          <div className="mt-1 text-xs tabular-nums text-zinc-500">
            {stats
              ? `${stats.counts.completedProjects} completed projects · Avg score ${stats.counts.averageClipScore}`
              : 'Loading...'}
          </div>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-[#07090b] p-5 transition hover:border-white/[0.14]">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>Storage Usage</span>
            <HardDrive className="h-4 w-4 text-sky-400" />
          </div>
          <div className="mt-2 text-2xl font-semibold tabular-nums text-white">
            {stats ? formatBytes(stats.storage.totalBytes) : '—'}
          </div>
          <div className="mt-1 truncate text-xs text-zinc-500">
            {stats?.storage.dataDir ?? 'data/'}
          </div>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-[#07090b] p-5 transition hover:border-white/[0.14]">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>AI &amp; Local CV</span>
            <Sparkles className="h-4 w-4 text-[#00f0ff]" />
          </div>
          <div className="mt-2 text-lg font-semibold text-white">
            {caps?.ai.reachable ? 'Cloud AI Ready' : 'Local CV + Heuristic'}
          </div>
          <div className="mt-1 truncate text-xs text-zinc-500">
            {caps
              ? `Whisper ${caps.localModels.whisperModelReady ? 'OK' : 'Pending'} · YuNet ${caps.localModels.yunetReady ? 'OK' : 'Pending'}`
              : 'Checking capabilities...'}
          </div>
        </div>
      </div>

      {/* Active Jobs */}
      {activeProjects.length > 0 && (
        <div className="rounded-2xl border border-[#00f0ff]/30 bg-[#00f0ff]/[0.04] p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#66f7ff]">
            <Activity className="h-4 w-4 animate-pulse text-[#00f0ff]" />
            Active Pipeline Jobs ({activeProjects.length})
          </div>
          <div className="space-y-3">
            {activeProjects.map((p) => (
              <div
                key={p.id}
                className="flex flex-col gap-3 rounded-xl border border-white/[0.08] bg-[#040608] p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className="truncate font-medium text-white">{p.title}</span>
                    <StatusBadge status={p.status} />
                  </div>
                  <p className="mt-1 truncate text-xs text-zinc-400">{p.currentStageLabel}</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-28">
                    <div className="mb-1 text-right font-mono text-xs tabular-nums text-zinc-300">
                      {p.overallProgress}%
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-900">
                      <div
                        className="h-full bg-gradient-to-r from-[#00c8e0] to-[#00f8ff] transition-all"
                        style={{ width: `${p.overallProgress}%` }}
                      />
                    </div>
                  </div>
                  <Link
                    to={`/projects/${p.id}/processing`}
                    className="rounded-lg border border-[#00f0ff]/30 bg-[#00f0ff]/12 px-3 py-1.5 text-xs font-medium text-[#66f7ff] transition hover:bg-[#00f0ff]/20"
                  >
                    Monitor
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Projects */}
      <div className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Recent Projects
        </h2>

        {loading ? (
          <div className="rounded-2xl border border-white/[0.08] bg-[#07090b] p-8 text-center text-sm text-zinc-500">
            Loading projects...
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/[0.12] bg-[#050709] p-12 text-center">
            <img
              src="/logo.png"
              alt="OpenClipX"
              className="mx-auto h-14 w-14 rounded-2xl object-contain drop-shadow-[0_0_20px_rgba(0,248,255,0.28)]"
            />
            <h3 className="mt-4 text-base font-semibold text-white">No projects yet</h3>
            <p className="mx-auto mt-1 max-w-md text-sm text-zinc-400">
              Paste a YouTube video URL to automatically extract highlights, track faces, and render 9:16 Shorts.
            </p>
            <Link
              to="/create"
              className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[#00e8f5] px-5 py-2.5 text-sm font-semibold text-[#021216] shadow-[0_0_24px_-4px_rgba(0,240,255,0.45)] transition hover:bg-[#33f3ff] hover:shadow-[0_0_28px_-2px_rgba(0,240,255,0.6)]"
            >
              <Plus className="h-4 w-4" />
              Create Your First Short
            </Link>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {projects.map((p) => (
              <div
                key={p.id}
                className="flex flex-col justify-between rounded-2xl border border-white/[0.08] bg-[#07090b] p-5 transition hover:border-[#00f0ff]/35"
              >
                <div className="flex gap-4">
                  {p.thumbnailUrl ? (
                    <img
                      src={p.thumbnailUrl}
                      alt={p.title}
                      className="h-20 w-32 shrink-0 rounded-xl bg-black object-cover ring-1 ring-white/[0.06]"
                    />
                  ) : (
                    <div className="flex h-20 w-32 shrink-0 items-center justify-center rounded-xl bg-[#030406] text-zinc-600 ring-1 ring-white/[0.06]">
                      <Film className="h-6 w-6" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="line-clamp-2 text-sm font-semibold text-white">{p.title}</h3>
                    </div>
                    <p className="mt-1 truncate text-xs text-zinc-400">
                      {p.author || p.youtubeUrl}
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <StatusBadge status={p.status} />
                      <span className="text-xs tabular-nums text-zinc-500">
                        {p.renderedCount ?? 0}/{p.clipCount ?? 0} clips ready
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-white/[0.07] pt-3.5">
                  <span className="text-xs text-zinc-500">
                    {new Date(p.createdAt).toLocaleString()}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleDelete(p.id, p.title)}
                      className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-rose-500/12 hover:text-rose-400"
                      title="Delete project"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    {['COMPLETED', 'SELECTING_CLIPS'].includes(p.status) ||
                    (p.clipCount ?? 0) > 0 ? (
                      <Link
                        to={`/projects/${p.id}/clips`}
                        className="rounded-lg bg-[#00f0ff]/12 px-3 py-1.5 text-xs font-medium text-[#66f7ff] ring-1 ring-[#00f0ff]/35 transition hover:bg-[#00f0ff]/22"
                      >
                        View Clips
                      </Link>
                    ) : (
                      <Link
                        to={`/projects/${p.id}/processing`}
                        className="rounded-lg border border-white/[0.1] bg-[#0b0e12] px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-[#00f0ff]/35 hover:text-[#66f7ff]"
                      >
                        Pipeline
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
