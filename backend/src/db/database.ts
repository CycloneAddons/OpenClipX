import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { env } from '../config/env.ts'
import type {
  ClipRecord,
  JobState,
  ProjectConfig,
  ProjectRecord
} from '../types/index.ts'

let dbInstance: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance
  mkdirSync(env.dataDir, { recursive: true })
  const dbPath = path.join(env.dataDir, 'clipforge.db')
  const db = new DatabaseSync(dbPath)

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      youtube_url TEXT NOT NULL,
      local_video_path TEXT,
      title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      thumbnail_url TEXT,
      status TEXT NOT NULL,
      stage_progress INTEGER NOT NULL DEFAULT 0,
      overall_progress INTEGER NOT NULL DEFAULT 0,
      current_stage_label TEXT NOT NULL DEFAULT '',
      error_message TEXT,
      config_json TEXT NOT NULL,
      metadata_json TEXT,
      visual_analysis_json TEXT,
      workspace_dir TEXT NOT NULL,
      source_video_path TEXT,
      audio_wav_path TEXT,
      transcript_path TEXT,
      audio_energy_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      hook TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      start_time_sec REAL NOT NULL,
      end_time_sec REAL NOT NULL,
      duration_sec REAL NOT NULL,
      transcript_text TEXT NOT NULL DEFAULT '',
      words_json TEXT NOT NULL DEFAULT '[]',
      score_breakdown_json TEXT NOT NULL,
      overall_score REAL NOT NULL,
      engagement_potential TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      composition_mode TEXT NOT NULL,
      subtitle_config_json TEXT NOT NULL,
      render_quality TEXT NOT NULL,
      target_fps INTEGER,
      background_audio_path TEXT,
      background_audio_volume REAL DEFAULT 0.15,
      output_path TEXT,
      thumbnail_path TEXT,
      tracking_path TEXT,
      subtitle_path TEXT,
      output_size_bytes INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_clips_project_id ON clips(project_id, rank);

    CREATE TABLE IF NOT EXISTS job_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      level TEXT NOT NULL,
      scope TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_job_logs_project_id ON job_logs(project_id, id);
  `)

  const ensureColumn = (table: string, col: string, definition: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${definition}`)
    }
  }
  ensureColumn('projects', 'source_language', 'TEXT')
  ensureColumn('clips', 'dubbing_config_json', 'TEXT')
  ensureColumn('clips', 'dubbing_plan_json', 'TEXT')
  ensureColumn('clips', 'dubbed_audio_path', 'TEXT')

  // Recover any projects/clips left mid-flight from an unexpected server crash
  const activeStates: JobState[] = [
    'QUEUED',
    'DOWNLOADING',
    'EXTRACTING',
    'TRANSCRIBING',
    'ANALYZING',
    'SELECTING_CLIPS',
    'TRACKING_FACES',
    'DUBBING',
    'GENERATING_SUBTITLES',
    'RENDERING'
  ]
  const placeholders = activeStates.map(() => '?').join(',')
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE projects SET status = 'FAILED', error_message = 'Interrupted by server restart', updated_at = ? WHERE status IN (${placeholders})`
  ).run(now, ...activeStates)

  db.prepare(
    `UPDATE clips SET status = 'FAILED', error_message = 'Interrupted by server restart', updated_at = ? WHERE status IN ('TRACKING_FACES', 'DUBBING', 'GENERATING_SUBTITLES', 'RENDERING')`
  ).run(now)

  dbInstance = db
  return db
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}

function rowToProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    youtubeUrl: String(row.youtube_url),
    localVideoPath: row.local_video_path ? String(row.local_video_path) : null,
    title: String(row.title),
    author: String(row.author ?? ''),
    thumbnailUrl: row.thumbnail_url ? String(row.thumbnail_url) : null,
    sourceLanguage: row.source_language ? String(row.source_language) : null,
    status: String(row.status) as JobState,
    stageProgress: Number(row.stage_progress ?? 0),
    overallProgress: Number(row.overall_progress ?? 0),
    currentStageLabel: String(row.current_stage_label ?? ''),
    errorMessage: row.error_message ? String(row.error_message) : null,
    config: JSON.parse(String(row.config_json)) as ProjectConfig,
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null,
    visualAnalysis: row.visual_analysis_json
      ? JSON.parse(String(row.visual_analysis_json))
      : null,
    workspaceDir: String(row.workspace_dir),
    sourceVideoPath: row.source_video_path ? String(row.source_video_path) : null,
    audioWavPath: row.audio_wav_path ? String(row.audio_wav_path) : null,
    transcriptPath: row.transcript_path ? String(row.transcript_path) : null,
    audioEnergyPath: row.audio_energy_path ? String(row.audio_energy_path) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function rowToClip(row: Record<string, unknown>): ClipRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    rank: Number(row.rank),
    title: String(row.title),
    description: String(row.description ?? ''),
    hook: String(row.hook ?? ''),
    reason: String(row.reason ?? ''),
    startTimeSec: Number(row.start_time_sec),
    endTimeSec: Number(row.end_time_sec),
    durationSec: Number(row.duration_sec),
    transcriptText: String(row.transcript_text ?? ''),
    words: JSON.parse(String(row.words_json || '[]')),
    scoreBreakdown: JSON.parse(String(row.score_breakdown_json)),
    overallScore: Number(row.overall_score),
    engagementPotential: String(row.engagement_potential) as ClipRecord['engagementPotential'],
    approved: Number(row.approved) === 1,
    status: String(row.status) as ClipRecord['status'],
    compositionMode: String(row.composition_mode) as ClipRecord['compositionMode'],
    subtitleConfig: JSON.parse(String(row.subtitle_config_json)),
    renderQuality: String(row.render_quality) as ClipRecord['renderQuality'],
    targetFps: row.target_fps != null ? Number(row.target_fps) : null,
    backgroundAudioPath: row.background_audio_path
      ? String(row.background_audio_path)
      : null,
    backgroundAudioVolume:
      row.background_audio_volume != null ? Number(row.background_audio_volume) : 0.15,
    dubbingConfig: row.dubbing_config_json
      ? JSON.parse(String(row.dubbing_config_json))
      : null,
    dubbingPlan: row.dubbing_plan_json
      ? JSON.parse(String(row.dubbing_plan_json))
      : null,
    dubbedAudioPath: row.dubbed_audio_path ? String(row.dubbed_audio_path) : null,
    outputPath: row.output_path ? String(row.output_path) : null,
    thumbnailPath: row.thumbnail_path ? String(row.thumbnail_path) : null,
    trackingPath: row.tracking_path ? String(row.tracking_path) : null,
    subtitlePath: row.subtitle_path ? String(row.subtitle_path) : null,
    outputSizeBytes: row.output_size_bytes != null ? Number(row.output_size_bytes) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

export const projectRepo = {
  create(project: ProjectRecord): ProjectRecord {
    const db = getDb()
    db.prepare(`
      INSERT INTO projects (
        id, youtube_url, local_video_path, title, author, thumbnail_url, source_language, status,
        stage_progress, overall_progress, current_stage_label, error_message,
        config_json, metadata_json, visual_analysis_json, workspace_dir,
        source_video_path, audio_wav_path, transcript_path, audio_energy_path,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      project.id,
      project.youtubeUrl,
      project.localVideoPath ?? null,
      project.title,
      project.author,
      project.thumbnailUrl ?? null,
      project.sourceLanguage ?? null,
      project.status,
      project.stageProgress,
      project.overallProgress,
      project.currentStageLabel,
      project.errorMessage ?? null,
      JSON.stringify(project.config),
      project.metadata ? JSON.stringify(project.metadata) : null,
      project.visualAnalysis ? JSON.stringify(project.visualAnalysis) : null,
      project.workspaceDir,
      project.sourceVideoPath ?? null,
      project.audioWavPath ?? null,
      project.transcriptPath ?? null,
      project.audioEnergyPath ?? null,
      project.createdAt,
      project.updatedAt
    )
    return project
  },

  findById(id: string): ProjectRecord | null {
    const db = getDb()
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToProject(row) : null
  },

  listAll(limit = 50): ProjectRecord[] {
    const db = getDb()
    const rows = db
      .prepare('SELECT * FROM projects ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[]
    return rows.map(rowToProject)
  },

  update(id: string, patch: Partial<ProjectRecord>): ProjectRecord | null {
    const existing = this.findById(id)
    if (!existing) return null
    const merged: ProjectRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    }
    const db = getDb()
    db.prepare(`
      UPDATE projects SET
        youtube_url = ?, local_video_path = ?, title = ?, author = ?, thumbnail_url = ?, source_language = ?,
        status = ?, stage_progress = ?, overall_progress = ?, current_stage_label = ?,
        error_message = ?, config_json = ?, metadata_json = ?, visual_analysis_json = ?,
        workspace_dir = ?, source_video_path = ?, audio_wav_path = ?,
        transcript_path = ?, audio_energy_path = ?, updated_at = ?
      WHERE id = ?
    `).run(
      merged.youtubeUrl,
      merged.localVideoPath ?? null,
      merged.title,
      merged.author,
      merged.thumbnailUrl ?? null,
      merged.sourceLanguage ?? null,
      merged.status,
      merged.stageProgress,
      merged.overallProgress,
      merged.currentStageLabel,
      merged.errorMessage ?? null,
      JSON.stringify(merged.config),
      merged.metadata ? JSON.stringify(merged.metadata) : null,
      merged.visualAnalysis ? JSON.stringify(merged.visualAnalysis) : null,
      merged.workspaceDir,
      merged.sourceVideoPath ?? null,
      merged.audioWavPath ?? null,
      merged.transcriptPath ?? null,
      merged.audioEnergyPath ?? null,
      merged.updatedAt,
      id
    )
    return merged
  },

  delete(id: string): void {
    const db = getDb()
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  },

  appendLog(projectId: string, level: string, scope: string, message: string): void {
    const db = getDb()
    try {
      db.prepare(
        'INSERT INTO job_logs (project_id, level, scope, message, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(projectId, level, scope, message, new Date().toISOString())
    } catch {
      // Ignore if project was deleted concurrently during cancellation/shutdown
    }
  },

  getLogs(projectId: string, limit = 200): Array<{ id: number; level: string; scope: string; message: string; createdAt: string }> {
    const db = getDb()
    const rows = db
      .prepare('SELECT id, level, scope, message, created_at FROM job_logs WHERE project_id = ? ORDER BY id DESC LIMIT ?')
      .all(projectId, limit) as Record<string, unknown>[]
    return rows.reverse().map((r) => ({
      id: Number(r.id),
      level: String(r.level),
      scope: String(r.scope),
      message: String(r.message),
      createdAt: String(r.created_at)
    }))
  }
}

export const clipRepo = {
  replaceForProject(projectId: string, clips: ClipRecord[]): void {
    const db = getDb()
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM clips WHERE project_id = ?').run(projectId)
      const stmt = db.prepare(`
        INSERT INTO clips (
          id, project_id, rank, title, description, hook, reason,
          start_time_sec, end_time_sec, duration_sec, transcript_text, words_json,
          score_breakdown_json, overall_score, engagement_potential, approved,
          status, composition_mode, subtitle_config_json, render_quality,
          target_fps, background_audio_path, background_audio_volume,
          dubbing_config_json, dubbing_plan_json, dubbed_audio_path,
          output_path, thumbnail_path, tracking_path, subtitle_path,
          output_size_bytes, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const c of clips) {
        stmt.run(
          c.id,
          c.projectId,
          c.rank,
          c.title,
          c.description,
          c.hook,
          c.reason,
          c.startTimeSec,
          c.endTimeSec,
          c.durationSec,
          c.transcriptText,
          JSON.stringify(c.words),
          JSON.stringify(c.scoreBreakdown),
          c.overallScore,
          c.engagementPotential,
          c.approved ? 1 : 0,
          c.status,
          c.compositionMode,
          JSON.stringify(c.subtitleConfig),
          c.renderQuality,
          c.targetFps ?? null,
          c.backgroundAudioPath ?? null,
          c.backgroundAudioVolume ?? 0.15,
          c.dubbingConfig ? JSON.stringify(c.dubbingConfig) : null,
          c.dubbingPlan ? JSON.stringify(c.dubbingPlan) : null,
          c.dubbedAudioPath ?? null,
          c.outputPath ?? null,
          c.thumbnailPath ?? null,
          c.trackingPath ?? null,
          c.subtitlePath ?? null,
          c.outputSizeBytes ?? null,
          c.errorMessage ?? null,
          c.createdAt,
          c.updatedAt
        )
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },

  findById(id: string): ClipRecord | null {
    const db = getDb()
    const row = db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToClip(row) : null
  },

  findByProjectId(projectId: string): ClipRecord[] {
    const db = getDb()
    const rows = db
      .prepare('SELECT * FROM clips WHERE project_id = ? ORDER BY rank ASC')
      .all(projectId) as Record<string, unknown>[]
    return rows.map(rowToClip)
  },

  listRecent(limit = 50): ClipRecord[] {
    const db = getDb()
    const rows = db
      .prepare('SELECT * FROM clips ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[]
    return rows.map(rowToClip)
  },

  update(id: string, patch: Partial<ClipRecord>): ClipRecord | null {
    const existing = this.findById(id)
    if (!existing) return null
    const merged: ClipRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    }
    const db = getDb()
    db.prepare(`
      UPDATE clips SET
        title = ?, description = ?, hook = ?, reason = ?,
        start_time_sec = ?, end_time_sec = ?, duration_sec = ?,
        transcript_text = ?, words_json = ?,
        approved = ?, status = ?, composition_mode = ?,
        subtitle_config_json = ?, render_quality = ?, target_fps = ?,
        background_audio_path = ?, background_audio_volume = ?,
        dubbing_config_json = ?, dubbing_plan_json = ?, dubbed_audio_path = ?,
        output_path = ?, thumbnail_path = ?, tracking_path = ?,
        subtitle_path = ?, output_size_bytes = ?, error_message = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      merged.title,
      merged.description,
      merged.hook,
      merged.reason,
      merged.startTimeSec,
      merged.endTimeSec,
      merged.durationSec,
      merged.transcriptText,
      JSON.stringify(merged.words),
      merged.approved ? 1 : 0,
      merged.status,
      merged.compositionMode,
      JSON.stringify(merged.subtitleConfig),
      merged.renderQuality,
      merged.targetFps ?? null,
      merged.backgroundAudioPath ?? null,
      merged.backgroundAudioVolume ?? 0.15,
      merged.dubbingConfig ? JSON.stringify(merged.dubbingConfig) : null,
      merged.dubbingPlan ? JSON.stringify(merged.dubbingPlan) : null,
      merged.dubbedAudioPath ?? null,
      merged.outputPath ?? null,
      merged.thumbnailPath ?? null,
      merged.trackingPath ?? null,
      merged.subtitlePath ?? null,
      merged.outputSizeBytes ?? null,
      merged.errorMessage ?? null,
      merged.updatedAt,
      id
    )
    return merged
  }
}

