import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Ytora } from 'ytora'
import type {
  DownloadProgressEvent,
  DownloadedItemResult,
  FormatSummary,
  PlaylistData,
  TrackData,
  TrackInfo,
  VideoQualityPref
} from 'ytora/types'
import { ensureDir } from '../utils/fsSafe.ts'
import { log } from '../utils/logger.ts'

export interface VideoPreviewInfo {
  videoId: string
  title: string
  author: string
  durationSec: number
  thumbnailUrl: string | null
  isStream: boolean
  formats: Array<{
    itag: number
    qualityLabel: string | null
    width: number | null
    height: number | null
    fps: number | null
    container: string
    codecs: string
    kind: FormatSummary['kind']
  }>
}

function extractTrackFromSourceResult(
  sourceResult: Awaited<ReturnType<Ytora['resolveInput']>>['sourceResult'],
  explicitWatchId: string | null
): TrackInfo {
  if (sourceResult.loadType === 'error') {
    throw new Error(sourceResult.exception?.message || 'Failed to resolve YouTube URL')
  }
  if (sourceResult.loadType === 'empty' || !sourceResult.data) {
    throw new Error('No YouTube video found for the provided URL')
  }
  if (sourceResult.loadType === 'track') {
    return (sourceResult.data as TrackData).info
  }
  if (sourceResult.loadType === 'search') {
    const arr = sourceResult.data as TrackData[]
    if (!arr[0]) throw new Error('No matching video found')
    return arr[0].info
  }
  if (sourceResult.loadType === 'playlist') {
    const pl = sourceResult.data as PlaylistData
    if (explicitWatchId) {
      const matched = pl.tracks.find((t) => t.info.identifier === explicitWatchId)
      if (matched) return matched.info
    }
    const idx = Math.max(0, Math.min(pl.info.selectedTrack || 0, pl.tracks.length - 1))
    if (pl.tracks[idx]) return pl.tracks[idx].info
    throw new Error('Playlist did not yield a selectable video')
  }
  throw new Error('Unsupported YouTube source result')
}

export async function previewYouTubeVideo(youtubeUrl: string): Promise<VideoPreviewInfo> {
  const downloader = new Ytora({ hl: 'en', gl: 'US' })
  try {
    const { sourceResult, explicitWatchId } = await downloader.resolveInput(youtubeUrl)
    const track = extractTrackFromSourceResult(sourceResult, explicitWatchId)

    let formats: VideoPreviewInfo['formats'] = []
    try {
      const inv = await downloader.listFormats(track)
      formats = inv.formats
        .filter((f) => f.kind !== 'audio-only')
        .map((f) => ({
          itag: f.itag,
          qualityLabel: f.qualityLabel,
          width: f.width,
          height: f.height,
          fps: f.fps,
          container: f.container,
          codecs: f.codecs,
          kind: f.kind
        }))
    } catch (err) {
      log('warn', 'Downloader', `Format inventory probe failed, continuing with metadata: ${(err as Error).message}`)
    }

    return {
      videoId: track.identifier,
      title: track.title,
      author: track.author,
      durationSec: Math.round((track.length || 0) / 1000),
      thumbnailUrl: track.artworkUrl || `https://i.ytimg.com/vi/${track.identifier}/hqdefault.jpg`,
      isStream: Boolean(track.isStream),
      formats
    }
  } finally {
    downloader.destroy()
  }
}

export async function downloadYouTubeVideo(params: {
  youtubeUrl: string
  outDir: string
  videoQuality: VideoQualityPref
  abortSignal?: AbortSignal
  onProgress?: (event: {
    phase: DownloadProgressEvent['phase']
    percent: number
    detail: string
  }) => void
  projectId?: string
}): Promise<DownloadedItemResult> {
  const { youtubeUrl, outDir, videoQuality, abortSignal, onProgress, projectId } = params
  await ensureDir(outDir)

  const downloader = new Ytora({ hl: 'en', gl: 'US' })
  let aborted = false

  const onAbort = () => {
    aborted = true
    log('warn', 'Downloader', 'Abort signal received, destroying Ytora downloader', projectId)
    downloader.destroy()
  }

  if (abortSignal?.aborted) {
    downloader.destroy()
    throw new Error('Download aborted before starting')
  }
  abortSignal?.addEventListener('abort', onAbort, { once: true })

  try {
    const results = await downloader.download(youtubeUrl, {
      mode: 'video',
      videoQuality,
      audioQuality: 'high',
      codec: 'h264',
      itag: null,
      outDir,
      filenameTemplate: 'source_{id}',
      playlist: false,
      onProgress: (ev) => {
        if (aborted) return
        let pct = 0
        if (ev.totalBytes && ev.bytesDownloaded !== undefined && ev.totalBytes > 0) {
          pct = Math.min(99, Math.round((ev.bytesDownloaded / ev.totalBytes) * 100))
        } else if (ev.phase === 'muxing') {
          pct = 96
        } else if (ev.phase === 'done') {
          pct = 100
        }
        const detailParts: string[] = [ev.phase]
        if (ev.detail) detailParts.push(ev.detail)
        if (ev.bytesDownloaded) {
          const mb = (ev.bytesDownloaded / (1024 * 1024)).toFixed(1)
          if (ev.totalBytes) {
            const totalMb = (ev.totalBytes / (1024 * 1024)).toFixed(1)
            detailParts.push(`${mb}/${totalMb} MB`)
          } else {
            detailParts.push(`${mb} MB`)
          }
        }
        onProgress?.({
          phase: ev.phase,
          percent: pct,
          detail: detailParts.join(' · ')
        })
      }
    })

    if (aborted || abortSignal?.aborted) {
      throw new Error('Download cancelled')
    }

    const first = results[0]
    if (!first || !existsSync(first.filePath)) {
      throw new Error('Ytora download completed without an output file')
    }

    return first
  } catch (err) {
    // If H.264 adaptive failed (e.g. rare codec unavailability), retry with codec: 'any' unless aborted
    if (!aborted && !abortSignal?.aborted) {
      log(
        'warn',
        'Downloader',
        `H.264 download attempt failed (${(err as Error).message}), retrying with codec='any'`,
        projectId
      )
      const fallbackDownloader = new Ytora({ hl: 'en', gl: 'US' })
      const onFallbackAbort = () => fallbackDownloader.destroy()
      abortSignal?.addEventListener('abort', onFallbackAbort, { once: true })
      try {
        const results = await fallbackDownloader.download(youtubeUrl, {
          mode: 'video',
          videoQuality,
          audioQuality: 'high',
          codec: 'any',
          itag: null,
          outDir,
          filenameTemplate: 'source_{id}',
          playlist: false,
          onProgress: (ev) => {
            if (abortSignal?.aborted) return
            const pct =
              ev.totalBytes && ev.bytesDownloaded !== undefined && ev.totalBytes > 0
                ? Math.min(99, Math.round((ev.bytesDownloaded / ev.totalBytes) * 100))
                : ev.phase === 'done'
                  ? 100
                  : 0
            onProgress?.({
              phase: ev.phase,
              percent: pct,
              detail: `${ev.phase}${ev.detail ? ` · ${ev.detail}` : ''}`
            })
          }
        })
        const first = results[0]
        if (!first || !existsSync(first.filePath)) {
          throw new Error('Fallback download failed to produce an output file')
        }
        return first
      } finally {
        abortSignal?.removeEventListener('abort', onFallbackAbort)
        fallbackDownloader.destroy()
      }
    }
    if (aborted) {
      await rm(outDir, { recursive: true, force: true }).catch(() => {})
    }
    throw err
  } finally {
    abortSignal?.removeEventListener('abort', onAbort)
    downloader.destroy()
  }
}
