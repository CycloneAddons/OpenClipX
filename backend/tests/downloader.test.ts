import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { downloadYouTubeVideo, previewYouTubeVideo } from '../src/services/downloader.ts'

describe('Ytora Downloader Integration', () => {
  it('resolves video metadata and format inventory via Ytora previewYouTubeVideo', async () => {
    const preview = await previewYouTubeVideo('https://www.youtube.com/watch?v=jNQXAC9IVRw')
    assert.equal(preview.videoId, 'jNQXAC9IVRw')
    assert.ok(preview.title.length > 0)
    assert.ok(preview.durationSec >= 15)
    assert.ok(preview.formats.length > 0)
  })

  it('downloads real YouTube video cleanly and leaves zero .part temp files', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'clipforge-ytora-'))
    try {
      const result = await downloadYouTubeVideo({
        youtubeUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
        outDir: tmpDir,
        videoQuality: '720p'
      })
      assert.equal(result.videoId, 'jNQXAC9IVRw')
      assert.ok(existsSync(result.filePath))
      assert.ok(result.sizeBytes > 10_000)

      const remaining = await readdir(tmpDir)
      assert.equal(
        remaining.some((f) => f.endsWith('.part')),
        false,
        'No .part temporary files should remain after download'
      )
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

