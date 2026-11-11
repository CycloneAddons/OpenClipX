import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../config/env.ts'

export function sanitizeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{4,64}$/.test(id)) {
    throw new Error(`Invalid resource identifier: ${id}`)
  }
  return id
}

export function resolveSafeDataPath(...segments: string[]): string {
  const root = path.resolve(env.dataDir)
  const target = path.resolve(root, ...segments)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('Path traversal rejected')
  }
  return target
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

export async function getDirectorySizeBytes(dirPath: string): Promise<number> {
  if (!existsSync(dirPath)) return 0
  let total = 0
  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name)
    try {
      if (entry.isDirectory()) {
        total += await getDirectorySizeBytes(full)
      } else if (entry.isFile()) {
        const s = await stat(full)
        total += s.size
      }
    } catch {
      // Ignore transient files
    }
  }
  return total
}

export async function removeSafePath(targetPath: string): Promise<void> {
  if (!targetPath) return
  const resolved = path.resolve(targetPath)
  const root = path.resolve(env.dataDir)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to delete path outside dataDir: ${targetPath}`)
  }
  await rm(resolved, { recursive: true, force: true })
}

export async function cleanupTempFilesInProject(
  workspaceDir: string,
  options?: { removeSourceVideo?: boolean }
): Promise<number> {
  let reclaimedBytes = 0
  const tempSubdirs = ['temp', 'frames']
  for (const sub of tempSubdirs) {
    const dir = path.join(workspaceDir, sub)
    if (existsSync(dir)) {
      reclaimedBytes += await getDirectorySizeBytes(dir)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const sourceDir = path.join(workspaceDir, 'source')
  if (existsSync(sourceDir)) {
    const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.endsWith('.part') || entry.name.startsWith('.')) {
        const p = path.join(sourceDir, entry.name)
        const s = await stat(p).catch(() => null)
        if (s) reclaimedBytes += s.size
        await rm(p, { force: true }).catch(() => {})
      } else if (options?.removeSourceVideo && entry.isFile()) {
        const p = path.join(sourceDir, entry.name)
        const s = await stat(p).catch(() => null)
        if (s) reclaimedBytes += s.size
        await rm(p, { force: true }).catch(() => {})
      }
    }
  }
  return reclaimedBytes
}

