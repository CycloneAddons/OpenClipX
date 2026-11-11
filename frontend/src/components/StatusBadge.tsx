import type { JobState } from '../types'

const COLOR_MAP: Record<string, string> = {
  QUEUED: 'bg-zinc-900/90 text-zinc-300 border-white/10',
  PENDING: 'bg-zinc-900/90 text-zinc-300 border-white/10',
  DOWNLOADING: 'bg-sky-500/12 text-sky-300 border-sky-500/30',
  EXTRACTING: 'bg-cyan-500/12 text-cyan-300 border-cyan-500/30',
  TRANSCRIBING: 'bg-teal-500/12 text-teal-300 border-teal-500/30',
  ANALYZING: 'bg-[#00f0ff]/12 text-[#66f7ff] border-[#00f0ff]/35',
  SELECTING_CLIPS: 'bg-cyan-400/12 text-cyan-200 border-cyan-400/35',
  TRACKING_FACES: 'bg-amber-500/12 text-amber-300 border-amber-500/30',
  DUBBING: 'bg-violet-500/12 text-violet-300 border-violet-500/35',
  GENERATING_SUBTITLES: 'bg-teal-400/12 text-teal-200 border-teal-400/30',
  RENDERING: 'bg-orange-500/12 text-orange-300 border-orange-500/30',
  COMPLETED: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/30',
  FAILED: 'bg-rose-500/12 text-rose-300 border-rose-500/30',
  CANCELLED: 'bg-zinc-900/90 text-zinc-400 border-white/10'
}

export function StatusBadge({ status }: { status: JobState | string }) {
  const cls = COLOR_MAP[status] || COLOR_MAP.QUEUED
  const isSpinning = ![
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'PENDING',
    'QUEUED'
  ].includes(status)

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium tracking-wide ${cls}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current ${isSpinning ? 'animate-pulse' : ''}`}
      />
      {status.replace(/_/g, ' ')}
    </span>
  )
}
