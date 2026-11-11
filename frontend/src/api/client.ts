import type {
  CapabilitiesResponse,
  ClipRecord,
  ClipTrackingResult,
  ProjectRecord,
  SystemStats,
  VideoPreviewInfo
} from '../types'

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers
    }
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`)
  }
  return data as T
}

export const api = {
  getStats: () => requestJson<SystemStats>('/api/system/stats'),
  getCapabilities: (refresh = false) =>
    requestJson<CapabilitiesResponse>(`/api/system/capabilities${refresh ? '?refresh=1' : ''}`),
  cleanupTemp: () =>
    requestJson<{ reclaimedBytes: number }>('/api/system/cleanup', { method: 'POST' }),
  uploadAudio: async (file: File) => {
    const form = new FormData()
    form.append('audio', file)
    return requestJson<{ audioPath: string; originalName: string; sizeBytes: number }>(
      '/api/system/audio/upload',
      { method: 'POST', body: form }
    )
  },

  previewYouTube: (youtubeUrl: string) =>
    requestJson<VideoPreviewInfo>('/api/projects/preview', {
      method: 'POST',
      body: JSON.stringify({ youtubeUrl })
    }),

  listProjects: () => requestJson<{ projects: ProjectRecord[] }>('/api/projects'),
  createProject: (payload: Record<string, unknown>) =>
    requestJson<{ project: ProjectRecord; queuePosition?: number }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  getProject: (id: string) =>
    requestJson<{
      project: ProjectRecord
      clips: ClipRecord[]
      logs: Array<{ id: number; level: string; scope: string; message: string; createdAt: string }>
    }>(`/api/projects/${id}`),
  analyzeProject: (id: string) =>
    requestJson<{ projectId: string; status: string }>(`/api/projects/${id}/analyze`, {
      method: 'POST'
    }),
  cancelProject: (id: string) =>
    requestJson<{ projectId: string; cancelled: boolean }>(`/api/projects/${id}/cancel`, {
      method: 'POST'
    }),
  deleteProject: (id: string) =>
    requestJson<{ deleted: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  getClip: (id: string) =>
    requestJson<{ clip: ClipRecord; project: ProjectRecord }>(`/api/clips/${id}`),
  updateClip: (id: string, payload: Record<string, unknown>) =>
    requestJson<{ clip: ClipRecord }>(`/api/clips/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }),
  renderClip: (id: string, payload: Record<string, unknown>) =>
    requestJson<{ clipId: string; projectId: string; status: string }>(`/api/clips/${id}/render`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  cancelClip: (id: string) =>
    requestJson<{ clipId: string; cancelled: boolean }>(`/api/clips/${id}/cancel`, {
      method: 'POST'
    }),
  getClipTracking: (id: string) =>
    requestJson<ClipTrackingResult>(`/api/clips/${id}/tracking`)
}

