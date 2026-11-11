import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { after, before, describe, it } from 'node:test'
import { createApp } from '../src/index.ts'
import { closeDb } from '../src/db/database.ts'
import { jobQueue } from '../src/queue/jobQueue.ts'
import { getMemorySnapshot } from '../src/utils/memoryMonitor.ts'

const execFileAsync = promisify(execFile)

describe('ClipForge HTTP API & Cancellation Tests', () => {
  let baseUrl = ''
  let server: ReturnType<Awaited<ReturnType<typeof createApp>>['listen']> | null = null
  let tmpDir = ''
  let tinyVideoPath = ''
  const createdProjectIds: string[] = []

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'clipforge-api-test-'))
    tinyVideoPath = path.join(tmpDir, 'sample.mp4')
    await execFileAsync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x141820:s=640x360:d=5:r=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=5',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-shortest',
      tinyVideoPath
    ])

    const app = await createApp()
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server!.once('listening', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  after(async () => {
    for (const id of createdProjectIds) {
      await fetch(`${baseUrl}/api/projects/${id}`, { method: 'DELETE' }).catch(() => {})
    }
    await jobQueue.shutdownAll()
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve())
      else resolve()
    })
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    closeDb()
  })

  it('serves health, stats, capabilities, and frontend SPA index', async () => {
    const healthRes = await fetch(`${baseUrl}/api/health`)
    assert.equal(healthRes.status, 200)
    const healthJson = (await healthRes.json()) as { ok: boolean; service: string }
    assert.equal(healthJson.ok, true)
    assert.equal(healthJson.service, 'clipforge-ai')

    const statsRes = await fetch(`${baseUrl}/api/system/stats`)
    assert.equal(statsRes.status, 200)
    const statsJson = (await statsRes.json()) as {
      memory: { totalAppRssMb: number }
      queue: { queuedCount: number }
      counts: { totalProjects: number }
    }
    assert.ok(statsJson.memory.totalAppRssMb > 0)
    assert.equal(typeof statsJson.queue.queuedCount, 'number')

    const capRes = await fetch(`${baseUrl}/api/system/capabilities`)
    assert.equal(capRes.status, 200)
    const capJson = (await capRes.json()) as {
      localModels: { whisperModelReady: boolean; yunetReady: boolean; faceLandmarkerReady: boolean }
      subtitlePresets: Record<string, unknown>
      dubbing: {
        configured: boolean
        englishSourceOnly: boolean
        languages: Array<{ code: string }>
        voices: { male: Array<{ name: string }>; female: Array<{ name: string }> }
      }
    }
    assert.equal(capJson.localModels.whisperModelReady, true)
    assert.equal(capJson.localModels.yunetReady, true)
    assert.equal(capJson.localModels.faceLandmarkerReady, true)
    assert.ok(capJson.subtitlePresets.modern)
    assert.equal(capJson.dubbing.englishSourceOnly, true)
    assert.ok(capJson.dubbing.languages.length >= 15)
    assert.equal(capJson.dubbing.voices.male.length, 37)
    assert.equal(capJson.dubbing.voices.female.length, 33)

    const spaRes = await fetch(`${baseUrl}/`)
    assert.equal(spaRes.status, 200)
    const html = await spaRes.text()
    assert.ok(html.toLowerCase().includes('<!doctype html>'))
  })

  it('rejects invalid payloads, missing resources, and unsafe identifiers', async () => {
    const badCreate = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    assert.equal(badCreate.status, 400)

    const missingProj = await fetch(`${baseUrl}/api/projects/proj_doesnotexist`)
    assert.equal(missingProj.status, 404)

    const badId = await fetch(`${baseUrl}/api/projects/bad!id$`)
    assert.equal(badId.status, 400)

    const missingClip = await fetch(`${baseUrl}/api/clips/clip_doesnotexist`)
    assert.equal(missingClip.status, 404)

    const badDubLang = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        youtubeUrl: 'local://sample.mp4',
        localVideoPath: tinyVideoPath,
        autoStart: false,
        config: {
          dubbingConfig: {
            enabled: true,
            targetLanguage: 'xx-invalid'
          }
        }
      })
    })
    assert.equal(badDubLang.status, 400)
  })

  it('creates a project, cancels active job cleanly with zero orphan PIDs, and deletes workspace', async () => {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        youtubeUrl: 'local://sample.mp4',
        localVideoPath: tinyVideoPath,
        title: 'API Cancellation Test',
        autoStart: false,
        config: {
          minClipDurationSec: 5,
          maxClipDurationSec: 15,
          targetClipCount: 1,
          enableVisionAnalysis: false,
          autoRenderTopClips: false
        }
      })
    })
    assert.equal(createRes.status, 201)
    const { project } = (await createRes.json()) as {
      project: { id: string; workspaceDir: string; status: string }
    }
    createdProjectIds.push(project.id)
    assert.equal(project.status, 'QUEUED')
    assert.ok(existsSync(project.workspaceDir))

    // Trigger analysis and cancel while running
    const analyzeRes = await fetch(`${baseUrl}/api/projects/${project.id}/analyze`, {
      method: 'POST'
    })
    assert.equal(analyzeRes.status, 202)

    await new Promise((r) => setTimeout(r, 120))
    const cancelRes = await fetch(`${baseUrl}/api/projects/${project.id}/cancel`, {
      method: 'POST'
    })
    assert.equal(cancelRes.status, 200)
    const cancelJson = (await cancelRes.json()) as { cancelled: boolean }
    assert.equal(cancelJson.cancelled, true)

    // Wait up to 2s for worker teardown to settle
    for (let i = 0; i < 40 && jobQueue.isBusy(); i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const detailRes = await fetch(`${baseUrl}/api/projects/${project.id}`)
    assert.equal(detailRes.status, 200)
    const detailJson = (await detailRes.json()) as { project: { status: string } }
    assert.equal(detailJson.project.status, 'CANCELLED')

    assert.equal(jobQueue.isBusy(), false, 'Queue should be idle after cancel settles')
    // Ensure zero leftover ffmpeg/ffprobe/python pipeline subprocesses under this PID
    const psOut = await execFileAsync('pgrep', ['-P', String(process.pid), '-a'])
      .then((r) => r.stdout)
      .catch(() => '')
    const orphanWorkers = psOut
      .split('\n')
      .filter((line) => /\b(ffmpeg|ffprobe|face_track|transcribe)\b/.test(line))
    assert.deepEqual(orphanWorkers, [], 'All worker subprocesses should terminate after cancel')
    assert.ok(getMemorySnapshot().processRssMb < 500)

    // Delete project and verify workspace cleanup
    const delRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: 'DELETE'
    })
    assert.equal(delRes.status, 200)
    assert.equal(existsSync(project.workspaceDir), false)

    const afterDelRes = await fetch(`${baseUrl}/api/projects/${project.id}`)
    assert.equal(afterDelRes.status, 404)
  })
})

