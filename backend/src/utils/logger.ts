import { EventEmitter } from 'node:events'
import { env } from '../config/env.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

const minRank = LEVEL_RANK[(env.logLevel as LogLevel) || 'info'] ?? 20

export interface JobLogEntry {
  projectId?: string
  level: LogLevel
  scope: string
  message: string
  timestamp: string
}

export const logEvents = new EventEmitter()
logEvents.setMaxListeners(50)

export function log(
  level: LogLevel,
  scope: string,
  message: string,
  projectId?: string
): void {
  const rank = LEVEL_RANK[level] ?? 20
  const timestamp = new Date().toISOString()
  const entry: JobLogEntry = { projectId, level, scope, message, timestamp }

  if (projectId) {
    logEvents.emit(`log:${projectId}`, entry)
  }
  logEvents.emit('log', entry)

  if (rank >= minRank) {
    const line = `[${timestamp}] [${level.toUpperCase()}] [${scope}]${projectId ? ` [${projectId}]` : ''} ${message}`
    if (level === 'error') {
      console.error(line)
    } else if (level === 'warn') {
      console.warn(line)
    } else {
      console.log(line)
    }
  }
}

