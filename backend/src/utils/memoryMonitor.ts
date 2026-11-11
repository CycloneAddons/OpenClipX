import { readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import { env } from '../config/env.ts'
import type { MemoryPressureLevel, MemorySnapshot } from '../types/index.ts'

let peakObservedAppRssMb = 0
const trackedChildPids = new Set<number>()

export function registerChildPid(pid: number | undefined): void {
  if (typeof pid === 'number' && pid > 0) {
    trackedChildPids.add(pid)
  }
}

export function unregisterChildPid(pid: number | undefined): void {
  if (typeof pid === 'number') {
    trackedChildPids.delete(pid)
  }
}

function readProcVmRssMb(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m)
    if (match?.[1]) {
      return Number.parseInt(match[1], 10) / 1024
    }
  } catch {
    // Process may have exited
  }
  return 0
}

function collectDescendantPids(rootPid: number): number[] {
  const result: number[] = []
  try {
    const entries = readdirSync('/proc', { withFileTypes: true })
    const childrenMap = new Map<number, number[]>()
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
      const pid = Number.parseInt(entry.name, 10)
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const rparen = stat.lastIndexOf(')')
        if (rparen === -1) continue
        const rest = stat.slice(rparen + 2).split(' ')
        const ppid = Number.parseInt(rest[1] ?? '0', 10)
        if (ppid > 0) {
          const arr = childrenMap.get(ppid) ?? []
          arr.push(pid)
          childrenMap.set(ppid, arr)
        }
      } catch {
        // Ignore vanished proc entry
      }
    }

    const queue = [rootPid]
    const seen = new Set<number>([rootPid])
    while (queue.length > 0) {
      const current = queue.shift()!
      const kids = childrenMap.get(current) ?? []
      for (const kid of kids) {
        if (!seen.has(kid)) {
          seen.add(kid)
          result.push(kid)
          queue.push(kid)
        }
      }
    }
  } catch {
    // Fallback to trackedChildPids if /proc unreadable
  }
  return result
}

function readSystemAvailableMb(): { totalMb: number; availableMb: number } {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8')
    const totalMatch = meminfo.match(/^MemTotal:\s+(\d+)\s+kB/m)
    const availMatch = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m)
    const totalMb = totalMatch?.[1] ? Number.parseInt(totalMatch[1], 10) / 1024 : os.totalmem() / (1024 * 1024)
    const availableMb = availMatch?.[1] ? Number.parseInt(availMatch[1], 10) / 1024 : os.freemem() / (1024 * 1024)
    return { totalMb, availableMb }
  } catch {
    return {
      totalMb: os.totalmem() / (1024 * 1024),
      availableMb: os.freemem() / (1024 * 1024)
    }
  }
}

export function getMemorySnapshot(): MemorySnapshot {
  const mem = process.memoryUsage()
  const processRssMb = mem.rss / (1024 * 1024)
  const processHeapUsedMb = mem.heapUsed / (1024 * 1024)

  const descendantPids = new Set<number>([
    ...collectDescendantPids(process.pid),
    ...trackedChildPids
  ])
  descendantPids.delete(process.pid)

  let childTreeRssMb = 0
  for (const pid of descendantPids) {
    const rss = readProcVmRssMb(pid)
    if (rss === 0) {
      trackedChildPids.delete(pid)
    } else {
      childTreeRssMb += rss
    }
  }

  const totalAppRssMb = processRssMb + childTreeRssMb
  if (totalAppRssMb > peakObservedAppRssMb) {
    peakObservedAppRssMb = totalAppRssMb
  }

  const { totalMb: systemTotalMb, availableMb: systemAvailableMb } = readSystemAvailableMb()
  const effectiveBudgetMb = Math.min(env.memory.peakRamBudgetMb, Math.max(512, systemTotalMb - 350))

  let pressure: MemoryPressureLevel = 'NORMAL'
  if (
    totalAppRssMb >= env.memory.emergencyRamCeilingMb ||
    systemAvailableMb < 220
  ) {
    pressure = 'CRITICAL'
  } else if (
    totalAppRssMb >= env.memory.peakRamBudgetMb ||
    systemAvailableMb < 420
  ) {
    pressure = 'HIGH'
  } else if (
    totalAppRssMb >= env.memory.normalRamTargetMb ||
    systemAvailableMb < 700
  ) {
    pressure = 'ELEVATED'
  }

  return {
    timestamp: new Date().toISOString(),
    processRssMb: Math.round(processRssMb * 10) / 10,
    processHeapUsedMb: Math.round(processHeapUsedMb * 10) / 10,
    childTreeRssMb: Math.round(childTreeRssMb * 10) / 10,
    totalAppRssMb: Math.round(totalAppRssMb * 10) / 10,
    systemTotalMb: Math.round(systemTotalMb),
    systemAvailableMb: Math.round(systemAvailableMb),
    effectiveBudgetMb: Math.round(effectiveBudgetMb),
    pressure,
    peakObservedAppRssMb: Math.round(peakObservedAppRssMb * 10) / 10
  }
}

export function resetPeakObservedMemory(): void {
  peakObservedAppRssMb = 0
}

export interface AdaptiveProcessingProfile {
  pressure: MemoryPressureLevel
  ffmpegThreads: number
  cvAnalysisWidth: number
  cvBaseFps: number
  cvBoostFps: number
  allowMediaPipeMouth: boolean
  allowVisionAnalysis: boolean
}

export function getAdaptiveProcessingProfile(): AdaptiveProcessingProfile {
  const snap = getMemorySnapshot()
  switch (snap.pressure) {
    case 'CRITICAL':
      return {
        pressure: snap.pressure,
        ffmpegThreads: 1,
        cvAnalysisWidth: 320,
        cvBaseFps: 3,
        cvBoostFps: 6,
        allowMediaPipeMouth: false,
        allowVisionAnalysis: false
      }
    case 'HIGH':
      return {
        pressure: snap.pressure,
        ffmpegThreads: 1,
        cvAnalysisWidth: 426,
        cvBaseFps: 4,
        cvBoostFps: 8,
        allowMediaPipeMouth: false,
        allowVisionAnalysis: false
      }
    case 'ELEVATED':
      return {
        pressure: snap.pressure,
        ffmpegThreads: Math.min(2, env.processing.ffmpegThreads),
        cvAnalysisWidth: Math.min(480, env.processing.cvAnalysisWidth),
        cvBaseFps: env.processing.cvBaseFps,
        cvBoostFps: Math.min(10, env.processing.cvBoostFps),
        allowMediaPipeMouth: true,
        allowVisionAnalysis: true
      }
    default:
      return {
        pressure: snap.pressure,
        ffmpegThreads: env.processing.ffmpegThreads,
        cvAnalysisWidth: env.processing.cvAnalysisWidth,
        cvBaseFps: env.processing.cvBaseFps,
        cvBoostFps: env.processing.cvBoostFps,
        allowMediaPipeMouth: true,
        allowVisionAnalysis: true
      }
  }
}

