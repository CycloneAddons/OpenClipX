import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  Activity,
  Cpu,
  Film,
  LayoutDashboard,
  PlusCircle
} from 'lucide-react'
import { api } from '../api/client'
import type { SystemStats } from '../types'

export function Layout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [stats, setStats] = useState<SystemStats | null>(null)

  useEffect(() => {
    let active = true
    const load = () => {
      api
        .getStats()
        .then((s) => {
          if (active) setStats(s)
        })
        .catch(() => {})
    }
    load()
    const id = setInterval(load, 4000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  const navItems = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/create', label: 'New Project', icon: PlusCircle }
  ]

  const mem = stats?.memory
  const memPct = mem
    ? Math.min(100, Math.round((mem.totalAppRssMb / Math.max(512, mem.effectiveBudgetMb)) * 100))
    : 0
  const memColor =
    mem?.pressure === 'CRITICAL'
      ? 'bg-rose-500'
      : mem?.pressure === 'HIGH'
        ? 'bg-amber-500'
        : 'bg-gradient-to-r from-[#00c8e0] to-[#00f8ff]'

  return (
    <div className="flex min-h-screen flex-col bg-black text-zinc-100 lg:flex-row">
      <aside className="flex w-full flex-col border-b border-white/[0.08] bg-black lg:w-64 lg:shrink-0 lg:border-r lg:border-b-0">
        <Link
          to="/"
          className="group flex items-center gap-3 border-b border-white/[0.08] px-5 py-4 transition hover:bg-white/[0.02]"
        >
          <img
            src="/logo.png"
            alt="OpenClipX logo"
            className="h-10 w-10 shrink-0 rounded-xl object-contain drop-shadow-[0_0_12px_rgba(0,248,255,0.28)] transition group-hover:drop-shadow-[0_0_16px_rgba(0,248,255,0.45)]"
          />
          <div>
            <div className="text-base font-bold tracking-tight text-white">
              OpenClip<span className="text-[#00f0ff]">X</span>
            </div>
            <div className="text-[11px] text-zinc-400">v1.0.0 · Studio</div>
          </div>
        </Link>

        <nav className="flex gap-1.5 overflow-x-auto p-3 lg:flex-1 lg:flex-col">
          {navItems.map((item) => {
            const Icon = item.icon
            const active = location.pathname === item.to
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
                  active
                    ? 'bg-[#00f0ff]/12 text-[#66f7ff] ring-1 ring-[#00f0ff]/35 shadow-[0_0_20px_-6px_rgba(0,240,255,0.4)]'
                    : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
                }`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-[#00f0ff]' : ''}`} />
                <span>{item.label}</span>
              </Link>
            )
          })}

          {stats?.queue.active && (
            <Link
              to={`/projects/${stats.queue.active.projectId}/processing`}
              className="mt-1 flex items-center gap-2.5 rounded-xl border border-[#00f0ff]/30 bg-[#00f0ff]/10 px-3.5 py-2 text-xs font-medium text-[#66f7ff] transition hover:bg-[#00f0ff]/15"
            >
              <Activity className="h-4 w-4 shrink-0 animate-pulse text-[#00f0ff]" />
              <span className="truncate">Active Job Running</span>
            </Link>
          )}
        </nav>

        <div className="hidden border-t border-white/[0.08] p-4 lg:block">
          <div className="rounded-xl border border-white/[0.07] bg-[#06080a] p-3.5">
            <div className="mb-2 flex items-center justify-between text-xs text-zinc-400">
              <span className="flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5 text-[#00f0ff]" />
                Memory Usage
              </span>
              <span className="font-mono tabular-nums text-zinc-200">
                {mem ? `${mem.totalAppRssMb.toFixed(0)} MB` : '—'}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-900">
              <div
                className={`h-full transition-all duration-300 ${memColor}`}
                style={{ width: `${memPct}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] tabular-nums text-zinc-500">
              <span>Peak: {mem ? `${mem.peakObservedAppRssMb.toFixed(0)} MB` : '—'}</span>
              <span
                className={
                  mem?.pressure === 'CRITICAL'
                    ? 'text-rose-400'
                    : mem?.pressure === 'HIGH'
                      ? 'text-amber-400'
                      : 'text-[#4ff8ff]'
                }
              >
                {mem?.pressure ?? 'NORMAL'}
              </span>
            </div>
            {stats && (
              <div className="mt-3 flex items-center justify-between border-t border-white/[0.07] pt-2.5 text-[11px] tabular-nums text-zinc-400">
                <span className="flex items-center gap-1">
                  <Film className="h-3 w-3 text-[#00f0ff]" />
                  {stats.counts.renderedClips} rendered
                </span>
                <span>{(stats.storage.totalBytes / (1024 * 1024)).toFixed(1)} MB disk</span>
              </div>
            )}
          </div>
        </div>
      </aside>

      <main className="relative flex-1 overflow-y-auto bg-black px-4 py-6 sm:px-8 lg:py-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(ellipse_at_top,rgba(0,240,255,0.06),transparent_65%)]"
        />
        <div className="relative mx-auto max-w-7xl">{children}</div>
      </main>
    </div>
  )
}
