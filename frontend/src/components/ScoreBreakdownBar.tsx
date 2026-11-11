import type { ClipScoreBreakdown } from '../types'

const LABELS: Array<{ key: keyof Omit<ClipScoreBreakdown, 'weightedTotal'>; label: string }> = [
  { key: 'hookStrength', label: 'Hook' },
  { key: 'storyCompleteness', label: 'Story' },
  { key: 'emotionalImpact', label: 'Emotion' },
  { key: 'informationValue', label: 'Info' },
  { key: 'audienceInterest', label: 'Interest' },
  { key: 'endingPayoff', label: 'Payoff' },
  { key: 'visualQuality', label: 'Visual' }
]

export function ScoreBreakdownBar({
  breakdown,
  compact = false
}: {
  breakdown: ClipScoreBreakdown
  compact?: boolean
}) {
  return (
    <div
      className={
        compact
          ? 'grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]'
          : 'grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4'
      }
    >
      {LABELS.map(({ key, label }) => {
        const val = Math.round(breakdown[key] ?? 0)
        return (
          <div key={key} className="space-y-1">
            <div className="flex items-center justify-between text-zinc-400">
              <span>{label}</span>
              <span className="font-mono tabular-nums text-zinc-200">{val}</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-zinc-900 ring-1 ring-white/[0.04]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#00b8d4] via-[#00e8f5] to-[#5ff8ff]"
                style={{ width: `${Math.min(100, Math.max(0, val))}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
