import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'
import { env } from '../src/config/env.ts'
import {
  normalizeAiClipCandidate,
  parseJsonFromLlm
} from '../src/services/aiClient.ts'
import {
  computeWeightedScore,
  selectAndRankClips,
  snapTimestampsToTranscript
} from '../src/services/clipSelector.ts'
import {
  buildAudioBufferFromChunks,
  createWavHeader,
  distributeTranslatedWords,
  groupTurnsIntoSynthesisBlocks,
  parseAudioMimeType,
  synthesizeDubbedClipAudio
} from '../src/services/dubbingService.ts'
import {
  buildSendcmdCropScript,
  extractDualSplitIntervals,
  renderVerticalShort
} from '../src/services/renderService.ts'
import { resolveSpeakerProfilesAndTurns } from '../src/services/speakerAnalysisService.ts'
import {
  buildSubtitlePhrases,
  formatAssTime,
  generateAssSubtitleContent,
  SUBTITLE_PRESETS,
  writeClipAssFile
} from '../src/services/subtitleService.ts'
import {
  buildSmoothTrajectory,
  calculate916CropDimensions,
  computeTargetCropForFace,
  type RawTrackingPayload
} from '../src/services/trajectoryEngine.ts'
import {
  ALL_VOICES,
  FEMALE_VOICES,
  getDubTargetLanguage,
  isEnglishSourceLanguage,
  MALE_VOICES,
  pickVoiceForSpeaker
} from '../src/services/voiceCatalog.ts'
import {
  DEFAULT_SCORING_WEIGHTS,
  type ProjectConfig,
  type TranscriptData
} from '../src/types/index.ts'

const execFileAsync = promisify(execFile)

describe('Clip Selection & Timestamp Snapping', () => {
  const sampleTranscript: TranscriptData = {
    language: 'en',
    durationSec: 90,
    model: 'tiny.en-q5_1',
    segments: [
      {
        id: 0,
        start: 1.0,
        end: 6.5,
        text: 'Welcome back everyone.',
        words: [
          { word: 'Welcome', start: 1.0, end: 1.5, probability: 0.9 },
          { word: 'back', start: 1.5, end: 1.9, probability: 0.9 },
          { word: 'everyone.', start: 2.0, end: 2.6, probability: 0.9 }
        ]
      },
      {
        id: 1,
        start: 8.0,
        end: 18.0,
        text: 'Why do most AI video tools crash on small servers?',
        words: [
          { word: 'Why', start: 8.0, end: 8.4, probability: 0.95 },
          { word: 'do', start: 8.4, end: 8.6, probability: 0.95 },
          { word: 'most', start: 8.6, end: 9.0, probability: 0.95 },
          { word: 'AI', start: 9.0, end: 9.3, probability: 0.95 },
          { word: 'video', start: 9.3, end: 9.8, probability: 0.95 },
          { word: 'tools', start: 9.8, end: 10.2, probability: 0.95 },
          { word: 'crash', start: 10.2, end: 10.7, probability: 0.95 },
          { word: 'on', start: 10.7, end: 10.9, probability: 0.95 },
          { word: 'small', start: 10.9, end: 11.4, probability: 0.95 },
          { word: 'servers?', start: 11.4, end: 12.0, probability: 0.95 }
        ]
      },
      {
        id: 2,
        start: 18.2,
        end: 31.0,
        text: 'Because they buffer entire 4K frames in memory instead of streaming!',
        words: [
          { word: 'Because', start: 18.2, end: 18.7, probability: 0.9 },
          { word: 'they', start: 18.7, end: 19.0, probability: 0.9 },
          { word: 'buffer', start: 19.0, end: 19.5, probability: 0.9 },
          { word: 'entire', start: 19.5, end: 20.0, probability: 0.9 },
          { word: '4K', start: 20.0, end: 20.5, probability: 0.9 },
          { word: 'frames', start: 20.5, end: 21.0, probability: 0.9 },
          { word: 'in', start: 21.0, end: 21.2, probability: 0.9 },
          { word: 'memory', start: 21.2, end: 21.8, probability: 0.9 },
          { word: 'instead', start: 21.8, end: 22.3, probability: 0.9 },
          { word: 'of', start: 22.3, end: 22.5, probability: 0.9 },
          { word: 'streaming!', start: 22.5, end: 23.2, probability: 0.9 }
        ]
      },
      {
        id: 3,
        start: 45.0,
        end: 60.0,
        text: 'Here is the exact secret to keeping peak RAM below 1.5 GB.',
        words: [
          { word: 'Here', start: 45.0, end: 45.4, probability: 0.9 },
          { word: 'is', start: 45.4, end: 45.6, probability: 0.9 },
          { word: 'the', start: 45.6, end: 45.8, probability: 0.9 },
          { word: 'exact', start: 45.8, end: 46.3, probability: 0.9 },
          { word: 'secret', start: 46.3, end: 46.9, probability: 0.9 },
          { word: 'to', start: 46.9, end: 47.1, probability: 0.9 },
          { word: 'keeping', start: 47.1, end: 47.6, probability: 0.9 },
          { word: 'peak', start: 47.6, end: 48.0, probability: 0.9 },
          { word: 'RAM', start: 48.0, end: 48.4, probability: 0.9 },
          { word: 'below', start: 48.4, end: 48.9, probability: 0.9 },
          { word: '1.5', start: 48.9, end: 49.4, probability: 0.9 },
          { word: 'GB.', start: 49.4, end: 50.0, probability: 0.9 }
        ]
      },
      {
        id: 4,
        start: 60.5,
        end: 78.0,
        text: 'Unload every model right after each stage finishes.',
        words: [
          { word: 'Unload', start: 60.5, end: 61.0, probability: 0.9 },
          { word: 'every', start: 61.0, end: 61.5, probability: 0.9 },
          { word: 'model', start: 61.5, end: 62.0, probability: 0.9 },
          { word: 'right', start: 62.0, end: 62.5, probability: 0.9 },
          { word: 'after', start: 62.5, end: 63.0, probability: 0.9 },
          { word: 'each', start: 63.0, end: 63.4, probability: 0.9 },
          { word: 'stage', start: 63.4, end: 64.0, probability: 0.9 },
          { word: 'finishes.', start: 64.0, end: 64.8, probability: 0.9 }
        ]
      }
    ]
  }

  it('computes weighted score accurately', () => {
    const score = computeWeightedScore(
      {
        hookStrength: 90,
        storyCompleteness: 80,
        emotionalImpact: 70,
        informationValue: 85,
        audienceInterest: 75,
        endingPayoff: 80,
        visualQuality: 60
      },
      DEFAULT_SCORING_WEIGHTS
    )
    assert.equal(score.weightedTotal, 79.5)
  })

  it('snaps timestamps cleanly to sentence boundaries within min/max duration', () => {
    const snapped = snapTimestampsToTranscript({
      rawStartSec: 8.5,
      rawEndSec: 26.0,
      segments: sampleTranscript.segments,
      videoDurationSec: 90,
      minDurationSec: 20,
      maxDurationSec: 45
    })
    assert.ok(snapped.startSec <= 8.0)
    assert.ok(snapped.endSec - snapped.startSec >= 20)
    assert.ok(snapped.endSec - snapped.startSec <= 45)
  })

  it('ranks and deduplicates non-overlapping clip candidates', () => {
    const cfg: ProjectConfig = {
      minClipDurationSec: 20,
      maxClipDurationSec: 45,
      targetClipCount: 2,
      compositionMode: 'smart',
      subtitleConfig: SUBTITLE_PRESETS.modern,
      renderQuality: 'high',
      videoQualityPref: '1080p',
      enableVisionAnalysis: false,
      scoringWeights: DEFAULT_SCORING_WEIGHTS,
      autoRenderTopClips: false
    }
    const clips = selectAndRankClips({
      projectId: 'proj_test',
      config: cfg,
      transcript: sampleTranscript,
      videoDurationSec: 90,
      aiCandidates: []
    })
    assert.equal(clips.length, 2)
    assert.ok(clips[0]!.overallScore >= clips[1]!.overallScore)
    // Verify non-excessive overlap
    const overlap = Math.max(
      0,
      Math.min(clips[0]!.endTimeSec, clips[1]!.endTimeSec) -
        Math.max(clips[0]!.startTimeSec, clips[1]!.startTimeSec)
    )
    const minDur = Math.min(clips[0]!.durationSec, clips[1]!.durationSec)
    assert.ok(overlap / minDur <= 0.35)
  })
})

describe('Dynamic Crop Geometry & Trajectory Smoothing', () => {
  it('computes 9:16 crop dimensions inside 16:9, 4K, and 4:3 frames', () => {
    const hd = calculate916CropDimensions(1920, 1080)
    assert.equal(hd.cropH, 1080)
    assert.equal(hd.cropW, 608)

    const uhd = calculate916CropDimensions(3840, 2160)
    assert.equal(uhd.cropH, 2160)
    assert.equal(uhd.cropW % 2, 0)
    assert.ok(Math.abs(uhd.cropW - 1215) <= 1)

    const sd43 = calculate916CropDimensions(1440, 1080)
    assert.equal(sd43.cropH, 1080)
    assert.equal(sd43.cropW, 608)
  })

  it('clamps extreme left and extreme right faces inside source bounds', () => {
    const leftCrop = computeTargetCropForFace({
      faceCx: 0.04,
      faceCy: 0.35,
      faceW: 0.08,
      faceH: 0.14,
      cropNormW: 608 / 1920,
      cropNormH: 1
    })
    assert.equal(leftCrop.x, 0)

    const rightCrop = computeTargetCropForFace({
      faceCx: 0.96,
      faceCy: 0.35,
      faceW: 0.08,
      faceH: 0.14,
      cropNormW: 608 / 1920,
      cropNormH: 1
    })
    assert.ok(Math.abs(rightCrop.x - (1 - 608 / 1920)) < 1e-4)
  })

  it('smooths moving person trajectory without overshoot or out-of-bounds crop', () => {
    const frames = []
    for (let i = 0; i < 50; i++) {
      const t = i * 0.2
      const cx = 0.12 + (i / 49) * 0.76
      frames.push({
        timeSec: t,
        sceneCut: false,
        activeSpeakerId: 1,
        faces: [
          {
            trackId: 1,
            x: cx - 0.05,
            y: 0.28,
            w: 0.1,
            h: 0.16,
            cx,
            cy: 0.36,
            confidence: 0.95,
            mouthActivity: 0.6,
            speakerScore: 0.85,
            isActiveSpeaker: true
          }
        ]
      })
    }
    const raw: RawTrackingPayload = {
      sourceWidth: 1920,
      sourceHeight: 1080,
      analysisWidth: 640,
      analysisHeight: 360,
      sampleFps: 5,
      durationSec: 10,
      frames
    }
    const traj = buildSmoothTrajectory({
      clipId: 'clip_move',
      raw,
      sourceFps: 30,
      compositionMode: 'single'
    })
    assert.equal(traj.compositionModeResolved, 'single')
    assert.ok(traj.frames[0]!.cropPrimary.x < 0.05)
    assert.ok(traj.frames[traj.frames.length - 1]!.cropPrimary.x > 0.55)
    for (const fr of traj.frames) {
      assert.ok(fr.cropPrimary.x >= 0 && fr.cropPrimary.x + fr.cropPrimary.w <= 1.0001)
      assert.ok(fr.cropPrimary.y >= 0 && fr.cropPrimary.y + fr.cropPrimary.h <= 1.0001)
    }

    const cmd = buildSendcmdCropScript({
      tracking: traj,
      targetName: 'crop@main',
      durationSec: 10,
      fps: 30
    })
    assert.ok(cmd.script.includes('crop@main x'))
    assert.ok(cmd.cropW === 608 && cmd.cropH === 1080)
  })

  it('selects dual_split layout automatically in smart mode for wide two-speaker podcast', () => {
    const frames = []
    for (let i = 0; i < 40; i++) {
      const t = i * 0.2
      const activeId = i % 16 < 8 ? 1 : 2
      frames.push({
        timeSec: t,
        sceneCut: false,
        activeSpeakerId: activeId,
        faces: [
          {
            trackId: 1,
            x: 0.12,
            y: 0.25,
            w: 0.1,
            h: 0.18,
            cx: 0.17,
            cy: 0.34,
            confidence: 0.92,
            mouthActivity: activeId === 1 ? 0.7 : 0.05,
            speakerScore: activeId === 1 ? 0.85 : 0.2,
            isActiveSpeaker: activeId === 1
          },
          {
            trackId: 2,
            x: 0.78,
            y: 0.25,
            w: 0.1,
            h: 0.18,
            cx: 0.83,
            cy: 0.34,
            confidence: 0.91,
            mouthActivity: activeId === 2 ? 0.7 : 0.05,
            speakerScore: activeId === 2 ? 0.85 : 0.2,
            isActiveSpeaker: activeId === 2
          }
        ]
      })
    }
    const raw: RawTrackingPayload = {
      sourceWidth: 1920,
      sourceHeight: 1080,
      analysisWidth: 640,
      analysisHeight: 360,
      sampleFps: 5,
      durationSec: 8,
      frames
    }
    const traj = buildSmoothTrajectory({
      clipId: 'clip_dual',
      raw,
      sourceFps: 30,
      compositionMode: 'smart'
    })
    assert.equal(traj.compositionModeResolved, 'dual_split')
    assert.ok(traj.frames[0]!.cropSecondary !== null)
    assert.ok(traj.frames[0]!.cropPrimary.x < 0.15)
    assert.ok(traj.frames[0]!.cropSecondary!.x > 0.4)
  })

  it('switches dynamically between dual_split (2 people) and single 9:16 (1 person) across scene cuts', () => {
    const frames: RawTrackingPayload['frames'] = []
    // 0.0s .. 3.8s: 2 speakers wide apart (10fps)
    for (let i = 0; i < 40; i++) {
      frames.push({
        timeSec: i * 0.1,
        sceneCut: false,
        activeSpeakerId: 1,
        faces: [
          {
            trackId: 1,
            x: 0.14,
            y: 0.25,
            w: 0.08,
            h: 0.18,
            cx: 0.18,
            cy: 0.34,
            confidence: 0.92,
            mouthActivity: 0.5,
            speakerScore: 0.8,
            isActiveSpeaker: true
          },
          {
            trackId: 2,
            x: 0.72,
            y: 0.25,
            w: 0.08,
            h: 0.18,
            cx: 0.76,
            cy: 0.34,
            confidence: 0.91,
            mouthActivity: 0.1,
            speakerScore: 0.3,
            isActiveSpeaker: false
          }
        ]
      })
    }
    // 4.0s .. 7.9s: Camera cuts to single close-up speaker (no dual panels allowed!)
    for (let i = 40; i < 80; i++) {
      frames.push({
        timeSec: i * 0.1,
        sceneCut: i === 40,
        activeSpeakerId: 3,
        faces: [
          {
            trackId: 3,
            x: 0.42,
            y: 0.22,
            w: 0.16,
            h: 0.38,
            cx: 0.5,
            cy: 0.41,
            confidence: 0.94,
            mouthActivity: 0.7,
            speakerScore: 0.9,
            isActiveSpeaker: true
          }
        ]
      })
    }
    // 8.0s .. 11.9s: Cuts back to 2 speakers wide shot
    for (let i = 80; i < 120; i++) {
      frames.push({
        timeSec: i * 0.1,
        sceneCut: i === 80,
        activeSpeakerId: 5,
        faces: [
          {
            trackId: 4,
            x: 0.18,
            y: 0.26,
            w: 0.07,
            h: 0.16,
            cx: 0.215,
            cy: 0.34,
            confidence: 0.91,
            mouthActivity: 0.1,
            speakerScore: 0.3,
            isActiveSpeaker: false
          },
          {
            trackId: 5,
            x: 0.74,
            y: 0.24,
            w: 0.08,
            h: 0.17,
            cx: 0.78,
            cy: 0.325,
            confidence: 0.92,
            mouthActivity: 0.8,
            speakerScore: 0.85,
            isActiveSpeaker: true
          }
        ]
      })
    }

    const raw: RawTrackingPayload = {
      sourceWidth: 1920,
      sourceHeight: 1080,
      analysisWidth: 640,
      analysisHeight: 360,
      sampleFps: 10,
      durationSec: 12,
      frames
    }

    for (const mode of ['smart', 'dual'] as const) {
      const traj = buildSmoothTrajectory({
        clipId: `clip_dyn_${mode}`,
        raw,
        sourceFps: 30,
        compositionMode: mode
      })
      assert.equal(traj.compositionModeResolved, 'dynamic')
      assert.equal(traj.frames[10]!.layoutMode, 'dual_split')
      assert.ok(traj.frames[10]!.cropSecondary !== null)
      assert.equal(traj.frames[55]!.layoutMode, 'single')
      assert.equal(traj.frames[55]!.cropSecondary, null)
      assert.ok(Math.abs(traj.frames[55]!.cropPrimary.w - 608 / 1920) < 0.01)
      assert.equal(traj.frames[95]!.layoutMode, 'dual_split')
      assert.ok(traj.frames[95]!.cropSecondary !== null)

      const intervals = extractDualSplitIntervals(traj.frames, 12)
      assert.equal(intervals.length, 2)
      assert.ok(intervals[0]!.startSec === 0 && intervals[0]!.endSec > 3.9 && intervals[0]!.endSec < 4.05)
      assert.ok(intervals[1]!.startSec > 7.9 && intervals[1]!.startSec < 8.05 && intervals[1]!.endSec >= 12)

      // Independent sendcmd crop scripts must keep single 9:16 dimensions even when t=0 is dual_split
      const singleCmd = buildSendcmdCropScript({
        tracking: traj,
        targetName: 'crop@main',
        durationSec: 12,
        fps: 24,
        modeFilter: 'single'
      })
      assert.equal(singleCmd.cropW, 608)
      assert.equal(singleCmd.cropH, 1080)

      const botCmd = buildSendcmdCropScript({
        tracking: traj,
        targetName: 'crop@bot',
        durationSec: 12,
        fps: 24,
        useSecondary: true,
        modeFilter: 'dual_split'
      })
      assert.ok(botCmd.cropW < 1080 && botCmd.cropH < 1080)
    }
  })

  it('suppresses brief 2-frame dropouts inside dual_split and ignores low-confidence false faces in single shots', () => {
    const frames: RawTrackingPayload['frames'] = []
    // Shot 1 (0..3.0s): Dual with 2-frame dropout at 1.5..1.6s -> must stay dual_split without flickering
    for (let i = 0; i < 30; i++) {
      const faces =
        i === 15 || i === 16
          ? [
              {
                trackId: 1,
                x: 0.14,
                y: 0.25,
                w: 0.08,
                h: 0.18,
                cx: 0.18,
                cy: 0.34,
                confidence: 0.92,
                mouthActivity: 0.5,
                speakerScore: 0.8,
                isActiveSpeaker: true
              }
            ]
          : [
              {
                trackId: 1,
                x: 0.14,
                y: 0.25,
                w: 0.08,
                h: 0.18,
                cx: 0.18,
                cy: 0.34,
                confidence: 0.92,
                mouthActivity: 0.5,
                speakerScore: 0.8,
                isActiveSpeaker: true
              },
              {
                trackId: 2,
                x: 0.72,
                y: 0.25,
                w: 0.08,
                h: 0.18,
                cx: 0.76,
                cy: 0.34,
                confidence: 0.91,
                mouthActivity: 0.1,
                speakerScore: 0.3,
                isActiveSpeaker: false
              }
            ]
      frames.push({
        timeSec: i * 0.1,
        sceneCut: false,
        activeSpeakerId: 1,
        faces
      })
    }
    // Shot 2 (3.0..6.0s): Single speaker + low-conf shelf false positive (0.59) -> must resolve cleanly to single
    for (let i = 30; i < 60; i++) {
      frames.push({
        timeSec: i * 0.1,
        sceneCut: i === 30,
        activeSpeakerId: 3,
        faces: [
          {
            trackId: 3,
            x: 0.42,
            y: 0.22,
            w: 0.15,
            h: 0.36,
            cx: 0.495,
            cy: 0.4,
            confidence: 0.94,
            mouthActivity: 0.6,
            speakerScore: 0.9,
            isActiveSpeaker: true
          },
          {
            trackId: 9,
            x: 0.78,
            y: 0.3,
            w: 0.07,
            h: 0.16,
            cx: 0.815,
            cy: 0.38,
            confidence: 0.59,
            mouthActivity: 0.0,
            speakerScore: 0.1,
            isActiveSpeaker: false
          }
        ]
      })
    }

    const traj = buildSmoothTrajectory({
      clipId: 'clip_hysteresis',
      raw: {
        sourceWidth: 1920,
        sourceHeight: 1080,
        analysisWidth: 640,
        analysisHeight: 360,
        sampleFps: 10,
        durationSec: 6,
        frames
      },
      sourceFps: 30,
      compositionMode: 'smart'
    })

    assert.equal(traj.frames[15]!.layoutMode, 'dual_split')
    assert.equal(traj.frames[16]!.layoutMode, 'dual_split')
    for (let i = 30; i < 60; i++) {
      assert.equal(traj.frames[i]!.layoutMode, 'single')
      assert.equal(traj.frames[i]!.cropSecondary, null)
    }
  })
})

describe('Subtitle Timing & ASS Generation', () => {
  it('formats ASS timestamps and builds word-highlighted ASS with face avoidance', () => {
    assert.equal(formatAssTime(65.43), '0:01:05.43')
    const phrases = buildSubtitlePhrases({
      words: [
        { word: 'Never', start: 10.1, end: 10.4, probability: 0.9 },
        { word: 'miss', start: 10.45, end: 10.8, probability: 0.9 },
        { word: 'this', start: 10.85, end: 11.1, probability: 0.9 },
        { word: 'trick.', start: 11.15, end: 11.6, probability: 0.9 }
      ],
      clipStartSec: 10.0,
      clipEndSec: 15.0,
      maxWordsPerLine: 4
    })
    assert.equal(phrases.length, 1)
    assert.equal(phrases[0]!.words.length, 4)

    const ass = generateAssSubtitleContent({
      phrases,
      config: SUBTITLE_PRESETS.modern
    })
    assert.ok(ass.includes('PlayResX: 1080'))
    assert.ok(ass.includes('PlayResY: 1920'))
    assert.ok(ass.includes('Dialogue:'))
    assert.ok(ass.includes('Never'))
  })

  it('places captions at split seam during dual_split segments and at bottom safe margin during single segments', () => {
    const dynTracking = buildSmoothTrajectory({
      clipId: 'clip_sub_dyn',
      sourceFps: 30,
      compositionMode: 'smart',
      raw: {
        sourceWidth: 1920,
        sourceHeight: 1080,
        analysisWidth: 640,
        analysisHeight: 360,
        sampleFps: 5,
        durationSec: 6,
        frames: [
          ...Array.from({ length: 15 }, (_, i) => ({
            timeSec: i * 0.2,
            sceneCut: false,
            activeSpeakerId: 1,
            faces: [
              {
                trackId: 1,
                x: 0.14,
                y: 0.25,
                w: 0.08,
                h: 0.18,
                cx: 0.18,
                cy: 0.34,
                confidence: 0.92,
                mouthActivity: 0.6,
                speakerScore: 0.85,
                isActiveSpeaker: true
              },
              {
                trackId: 2,
                x: 0.72,
                y: 0.25,
                w: 0.08,
                h: 0.18,
                cx: 0.76,
                cy: 0.34,
                confidence: 0.92,
                mouthActivity: 0.1,
                speakerScore: 0.2,
                isActiveSpeaker: false
              }
            ]
          })),
          ...Array.from({ length: 15 }, (_, j) => ({
            timeSec: 3.0 + j * 0.2,
            sceneCut: j === 0,
            activeSpeakerId: 3,
            faces: [
              {
                trackId: 3,
                x: 0.42,
                y: 0.18,
                w: 0.15,
                h: 0.32,
                cx: 0.495,
                cy: 0.34,
                confidence: 0.95,
                mouthActivity: 0.7,
                speakerScore: 0.9,
                isActiveSpeaker: true
              }
            ]
          }))
        ]
      }
    })

    const phrases = buildSubtitlePhrases({
      words: [
        { word: 'Two', start: 0.5, end: 1.0, probability: 0.9 },
        { word: 'people.', start: 1.05, end: 1.6, probability: 0.9 },
        { word: 'One', start: 3.5, end: 4.0, probability: 0.9 },
        { word: 'speaker.', start: 4.05, end: 4.8, probability: 0.9 }
      ],
      clipStartSec: 0,
      clipEndSec: 6,
      maxWordsPerLine: 4
    })

    const ass = generateAssSubtitleContent({
      phrases,
      config: SUBTITLE_PRESETS.modern,
      tracking: dynTracking
    })
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    const dualLines = lines.filter((l) => l.includes('Two') || l.includes('people'))
    const singleLines = lines.filter((l) => l.includes('One') || l.includes('speaker'))
    assert.ok(dualLines.length > 0 && dualLines.every((l) => l.includes('{\\an5}')))
    assert.ok(singleLines.length > 0 && singleLines.every((l) => !l.includes('{\\an5}')))
  })
})

describe('LLM JSON Extraction & Normalization', () => {
  it('recovers complete clip objects from unclosed fence & length-truncated JSON', () => {
    const truncated = [
      '<think>Analyzing moments...</think>',
      '```json',
      '{',
      '  "clips": [',
      '    {',
      '      "startSec": 36.4,',
      '      "endSec": 73.6,',
      '      "title": "First Complete Clip",',
      '      "scores": { "hookStrength": 9.2, "storyCompleteness": 8.8, "emotionalImpact": 8.1, "informationValue": 8.5, "audienceInterest": 9.0, "endingPayoff": 8.4, "visualQuality": 8.0 }',
      '    },',
      '    {',
      '      "startSec": 134.6,',
      '      "endSec": 180.6,',
      '      "title": "Cut Mid Clip",',
      '      "scores": { "hookStrength": 8'
    ].join('\n')

    const parsed = parseJsonFromLlm(truncated) as { clips: unknown[] }
    assert.equal(Array.isArray(parsed.clips), true)
    assert.equal(parsed.clips.length, 1)

    const norm = normalizeAiClipCandidate(parsed.clips[0])!
    assert.equal(norm.title, 'First Complete Clip')
    assert.equal(norm.scores.hookStrength, 92)
    assert.equal(norm.scores.storyCompleteness, 88)
  })

  it('handles trailing commas, leading prose braces, and partial score fields', () => {
    const messy =
      'Here is {note} the output:\n{\n  "clips": [\n    { "startSec": "10", "endSec": 40, "title": "Clean", "scores": { "hookStrength": 88 }, },\n  ],\n}'
    const parsed = parseJsonFromLlm(messy) as { clips: unknown[] }
    assert.equal(parsed.clips.length, 1)
    const norm = normalizeAiClipCandidate(parsed.clips[0])!
    assert.equal(norm.startSec, 10)
    assert.equal(norm.scores.hookStrength, 88)
    assert.equal(norm.scores.storyCompleteness, 70)
  })
})

describe('Multi-Speaker AI Dubbing & Voice Assignment', () => {
  it('enforces complete gender-segregated Gemini voice catalog (37 Male + 33 Female) & English-only gate', () => {
    assert.equal(MALE_VOICES.length, 37)
    assert.equal(FEMALE_VOICES.length, 33)
    assert.equal(ALL_VOICES.length, 70)
    const maleNames = new Set(MALE_VOICES.map((v) => v.name))
    const femaleNames = new Set(FEMALE_VOICES.map((v) => v.name))
    assert.equal(maleNames.size, 37)
    assert.equal(femaleNames.size, 33)
    for (const m of maleNames) {
      assert.equal(femaleNames.has(m), false)
    }

    assert.equal(isEnglishSourceLanguage('en'), true)
    assert.equal(isEnglishSourceLanguage('en-US'), true)
    assert.equal(isEnglishSourceLanguage('English'), true)
    assert.equal(isEnglishSourceLanguage('hi'), false)
    assert.equal(isEnglishSourceLanguage('es'), false)
    assert.equal(isEnglishSourceLanguage(null), false)

    const used = new Set<string>()
    const m1 = pickVoiceForSpeaker({
      gender: 'male',
      pitchHintHz: 108,
      contentType: 'podcast',
      alreadyUsedVoices: used,
      speakerIndex: 0
    })
    used.add(m1.name)
    const m2 = pickVoiceForSpeaker({
      gender: 'male',
      pitchHintHz: 132,
      contentType: 'podcast',
      alreadyUsedVoices: used,
      speakerIndex: 1
    })
    const f1 = pickVoiceForSpeaker({
      gender: 'female',
      pitchHintHz: 214,
      contentType: 'podcast',
      alreadyUsedVoices: used,
      speakerIndex: 2
    })
    assert.equal(m1.gender, 'male')
    assert.equal(m2.gender, 'male')
    assert.notEqual(m1.name, m2.name)
    assert.equal(f1.gender, 'female')
  })

  it('builds valid WAV headers from streamed L16 PCM and RIFF chunks using exact decoded byte lengths', () => {
    const chunkA = Buffer.alloc(60, 0x05)
    const chunkB = Buffer.alloc(40, 0x09)
    const combinedPcmLen = chunkA.length + chunkB.length
    assert.notEqual(chunkA.toString('base64').length, chunkA.length)

    const cleanOut = buildAudioBufferFromChunks([
      { dataBase64: chunkA.toString('base64'), mimeType: 'audio/l16; rate=24000; channels=1' },
      { dataBase64: chunkB.toString('base64'), mimeType: 'audio/L16;rate=24000' }
    ])
    assert.equal(cleanOut.extension, 'wav')
    assert.equal(cleanOut.buffer.subarray(0, 4).toString('ascii'), 'RIFF')
    assert.equal(cleanOut.buffer.readUInt32LE(4), 36 + combinedPcmLen)
    assert.equal(cleanOut.buffer.readUInt32LE(24), 24000)
    assert.equal(cleanOut.buffer.readUInt16LE(34), 16)
    assert.equal(cleanOut.buffer.readUInt32LE(40), combinedPcmLen)
    assert.equal(cleanOut.buffer.length, 44 + combinedPcmLen)
    assert.deepEqual(parseAudioMimeType('audio/l24; rate=48000; channels=2'), {
      numChannels: 2,
      sampleRate: 48000,
      bitsPerSample: 24
    })

    // Unwraps multi-chunk RIFF/WAV without double headers
    const hdr = createWavHeader(40, { numChannels: 1, sampleRate: 24000, bitsPerSample: 16 })
    const wavChunk = Buffer.concat([hdr, chunkB])
    const combinedWav = buildAudioBufferFromChunks([
      { dataBase64: wavChunk.toString('base64'), mimeType: 'audio/wav' },
      { dataBase64: wavChunk.toString('base64'), mimeType: 'audio/wav' }
    ])
    assert.equal(combinedWav.buffer.readUInt32LE(40), 80)
    assert.equal(combinedWav.buffer.length, 44 + 80)
  })

  it('groups dialogue turns into <=2-speaker synthesis blocks and distributes CJK/Latin dubbed subtitles cleanly', () => {
    const blocks = groupTurnsIntoSynthesisBlocks([
      { startSec: 0.0, endSec: 2.0, speakerId: 'Speaker 1', originalText: 'Hi', translatedText: 'Hola' },
      { startSec: 2.1, endSec: 4.0, speakerId: 'Speaker 2', originalText: 'Hey', translatedText: 'Qué tal' },
      { startSec: 4.1, endSec: 6.0, speakerId: 'Speaker 3', originalText: 'Welcome', translatedText: 'Bienvenidos' },
      { startSec: 8.5, endSec: 10.5, speakerId: 'Speaker 1', originalText: 'Now', translatedText: 'Ahora' }
    ])
    assert.equal(blocks.length, 3)
    assert.equal(blocks[0]!.speakerIds.length, 2)
    assert.deepEqual(blocks[0]!.speakerIds, ['Speaker 1', 'Speaker 2'])
    assert.deepEqual(blocks[1]!.speakerIds, ['Speaker 3'])
    assert.deepEqual(blocks[2]!.speakerIds, ['Speaker 1'])

    const jaWords = distributeTranslatedWords({
      turns: [
        {
          startSec: 0,
          endSec: 3,
          placedStartSec: 0.2,
          placedEndSec: 2.8,
          speakerId: 'Speaker 1',
          originalText: 'OpenClipX runs very fast.',
          translatedText: 'これはとても速く動きます。'
        }
      ],
      clipStartSec: 10,
      targetLanguageCode: 'ja'
    })
    assert.ok(jaWords.words.length >= 3, 'Should chunk space-less Japanese text into multiple tokens')
    assert.ok(jaWords.words[0]!.start >= 10.2)
    assert.ok(jaWords.words[jaWords.words.length - 1]!.end <= 12.81)

    const phrases = buildSubtitlePhrases({
      words: jaWords.words,
      clipStartSec: 10,
      clipEndSec: 14,
      maxWordsPerLine: 4
    })
    const ass = generateAssSubtitleContent({
      phrases,
      config: SUBTITLE_PRESETS.bold,
      dubbedLanguage: 'ja'
    })
    assert.ok(ass.includes('Style: Default,Noto Sans CJK JP,'))
    assert.ok(getDubTargetLanguage('hi')?.assFont === 'Noto Sans Devanagari')
  })

  it('fuses acoustic pitch + visual gender + LLM diarizer + user overrides accurately', () => {
    const resolved = resolveSpeakerProfilesAndTurns({
      microTurns: [
        {
          idx: 0,
          startSec: 0,
          endSec: 3,
          text: 'How did you build this engine?',
          f0Hz: 112,
          acousticGender: 'male',
          linkedTrackId: 1,
          visualGender: 'male'
        },
        {
          idx: 1,
          startSec: 3.1,
          endSec: 6,
          text: 'We streamed every frame with FFmpeg!',
          f0Hz: 214,
          acousticGender: 'female',
          linkedTrackId: 2,
          visualGender: 'female'
        }
      ],
      aiResult: {
        speakers: [
          { speakerId: 'Speaker 1', label: 'Host', gender: 'male', confidence: 0.9, linkedTrackId: 1 },
          { speakerId: 'Speaker 2', label: 'Guest', gender: 'female', confidence: 0.92, linkedTrackId: 2 }
        ],
        turns: [
          { idx: 0, speakerId: 'Speaker 1', translatedText: '¿Cómo construiste este motor?', style: 'curious' },
          { idx: 1, speakerId: 'Speaker 2', translatedText: '¡Transmitimos cada fotograma con FFmpeg!', style: 'enthusiastic' }
        ]
      },
      dubbingConfig: {
        enabled: true,
        targetLanguage: 'es',
        speakerOverrides: [{ speakerId: 'Speaker 2', gender: 'female', voiceName: 'Veda' }]
      },
      contentType: 'podcast'
    })

    assert.equal(resolved.speakers.length, 2)
    assert.equal(resolved.speakers[0]!.gender, 'male')
    assert.ok(MALE_VOICES.some((v) => v.name === resolved.speakers[0]!.voiceName))
    assert.equal(resolved.speakers[1]!.gender, 'female')
    assert.equal(resolved.speakers[1]!.voiceName, 'Veda')
    assert.equal(resolved.turns[1]!.translatedText, '¡Transmitimos cada fotograma con FFmpeg!')
  })

  it('estimates male (~112 Hz) and female (~215 Hz) pitch via cv/analyze_voice_pitch.py', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'openclipx-pitch-'))
    try {
      const wavPath = path.join(tmpDir, 'voices.wav')
      const segPath = path.join(tmpDir, 'segs.json')
      const sr = 16000
      const samplesCount = sr * 3
      const pcm = Buffer.alloc(samplesCount * 2)

      for (let i = 0; i < samplesCount; i++) {
        const t = i / sr
        const f0 = t < 1.5 ? 112 : 215
        const val =
          0.45 * Math.sin(2 * Math.PI * f0 * t) +
          0.25 * Math.sin(2 * Math.PI * f0 * 2 * t) +
          0.15 * Math.sin(2 * Math.PI * f0 * 3 * t)
        pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, val)) * 28000), i * 2)
      }
      const header = createWavHeader(pcm.length, { numChannels: 1, sampleRate: sr, bitsPerSample: 16 })
      await writeFile(wavPath, Buffer.concat([header, pcm]))
      await writeFile(
        segPath,
        JSON.stringify([
          { idx: 0, startSec: 0, endSec: 1.5 },
          { idx: 1, startSec: 1.5, endSec: 3.0 }
        ])
      )

      const { stdout } = await execFileAsync(env.pythonBin, [
        path.join(env.cvDir, 'analyze_voice_pitch.py'),
        '--wav',
        wavPath,
        '--segments-json',
        segPath
      ])
      const parsed = JSON.parse(stdout) as {
        segments: Array<{ idx: number; medianF0Hz: number; acousticGender: string }>
      }
      assert.equal(parsed.segments.length, 2)
      assert.ok(Math.abs(parsed.segments[0]!.medianF0Hz - 112) < 4)
      assert.equal(parsed.segments[0]!.acousticGender, 'male')
      assert.ok(Math.abs(parsed.segments[1]!.medianF0Hz - 215) < 4)
      assert.equal(parsed.segments[1]!.acousticGender, 'female')
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('assembles dubbed WAV blocks, dubbed ASS subtitles, and renders 9:16 MP4 with dubbed audio + BGM mix', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'openclipx-dub-render-'))
    try {
      const sourceVideoPath = path.join(tmpDir, 'source.mp4')
      const bgmPath = path.join(tmpDir, 'bgm.wav')
      const clipDir = path.join(tmpDir, 'clip_out')
      const outputMp4Path = path.join(clipDir, 'output.mp4')
      const assPath = path.join(clipDir, 'subtitles.ass')

      // Generate tiny 4s 640x360 source video + soft BGM sine
      await execFileAsync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x101828:s=640x360:d=4:r=24',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=220:duration=4',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        '-shortest',
        sourceVideoPath
      ])

      const bgmPcm = Buffer.alloc(16000 * 4 * 2)
      for (let i = 0; i < 16000 * 4; i++) {
        const val = 0.08 * Math.sin((2 * Math.PI * 330 * i) / 16000)
        bgmPcm.writeInt16LE(Math.round(val * 32000), i * 2)
      }
      await writeFile(
        bgmPath,
        Buffer.concat([createWavHeader(bgmPcm.length, { numChannels: 1, sampleRate: 16000, bitsPerSample: 16 }), bgmPcm])
      )

      let synthesizedBlocks = 0
      const { dubbedAudioPath, plan } = await synthesizeDubbedClipAudio({
        clipDir,
        clipDurationSec: 4,
        plan: {
          sourceLanguage: 'en',
          targetLanguage: 'es',
          clipStartSec: 0,
          clipEndSec: 4,
          speakers: [
            {
              speakerId: 'Speaker 1',
              label: 'Host',
              gender: 'male',
              voiceName: 'Knox',
              confidence: 0.9
            },
            {
              speakerId: 'Speaker 2',
              label: 'Guest',
              gender: 'female',
              voiceName: 'Cleo',
              confidence: 0.9
            }
          ],
          turns: [
            {
              startSec: 0.2,
              endSec: 1.8,
              speakerId: 'Speaker 1',
              originalText: 'Welcome back everyone.',
              translatedText: 'Bienvenidos de nuevo todos.'
            },
            {
              startSec: 2.0,
              endSec: 3.6,
              speakerId: 'Speaker 2',
              originalText: 'Glad to be here!',
              translatedText: 'Encantada de estar aquí!'
            }
          ],
          dubbedWords: [],
          dubbedTranscriptText: '',
          generatedAt: new Date().toISOString()
        },
        synthesizeBlockOverride: async ({ block, outPathBase }) => {
          synthesizedBlocks++
          assert.equal(block.speakerIds.length, 2)
          const sr = 24000
          const durSec = 2.6
          const pcm = Buffer.alloc(sr * durSec * 2)
          for (let i = 0; i < sr * durSec; i++) {
            const val = 0.35 * Math.sin((2 * Math.PI * 520 * i) / sr)
            pcm.writeInt16LE(Math.round(val * 32000), i * 2)
          }
          const wavPath = `${outPathBase}.wav`
          await writeFile(
            wavPath,
            Buffer.concat([
              createWavHeader(pcm.length, { numChannels: 1, sampleRate: sr, bitsPerSample: 16 }),
              pcm
            ])
          )
          return wavPath
        }
      })

      assert.equal(synthesizedBlocks, 1)
      assert.equal(existsSync(dubbedAudioPath), true)
      assert.ok((plan.dubbedWords?.length || 0) >= 6)
      assert.ok(plan.turns.every((t) => typeof t.placedStartSec === 'number' && typeof t.placedEndSec === 'number'))

      await writeClipAssFile({
        outAssPath: assPath,
        words: plan.dubbedWords,
        clipStartSec: 0,
        clipEndSec: 4,
        config: SUBTITLE_PRESETS.modern,
        dubbedLanguage: 'es'
      })
      assert.equal(existsSync(assPath), true)

      const rendered = await renderVerticalShort({
        sourceVideoPath,
        metadata: {
          title: 'Synthetic Dub Test',
          durationSec: 4,
          width: 640,
          height: 360,
          fps: 24,
          rotationDeg: 0,
          codec: 'h264',
          audioCodec: 'aac',
          sizeBytes: 100000
        },
        startTimeSec: 0,
        endTimeSec: 4,
        tracking: {
          clipId: 'test_clip',
          sourceWidth: 640,
          sourceHeight: 360,
          sourceFps: 24,
          durationSec: 4,
          compositionModeRequested: 'single',
          compositionModeResolved: 'single',
          speakersDetected: 0,
          averageTrackingConfidence: 1,
          frames: [
            {
              timeSec: 0,
              sceneCut: false,
              activeSpeakerId: null,
              layoutMode: 'single',
              faces: [],
              cropPrimary: { x: 0.34, y: 0, w: 0.316, h: 1 }
            },
            {
              timeSec: 4,
              sceneCut: false,
              activeSpeakerId: null,
              layoutMode: 'single',
              faces: [],
              cropPrimary: { x: 0.34, y: 0, w: 0.316, h: 1 }
            }
          ]
        },
        assSubtitlePath: assPath,
        outputMp4Path,
        quality: 'medium',
        backgroundAudioPath: bgmPath,
        backgroundAudioVolume: 0.15,
        dubbedAudioPath
      })

      assert.equal(existsSync(rendered.outputPath), true)
      const st = await stat(rendered.outputPath)
      assert.ok(st.size > 10000)

      const { stdout: probeOut } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-show_streams',
        '-of',
        'json',
        rendered.outputPath
      ])
      const probeJson = JSON.parse(probeOut) as { streams: Array<{ codec_type: string; width?: number; height?: number }> }
      const vStream = probeJson.streams.find((s) => s.codec_type === 'video')
      const aStream = probeJson.streams.find((s) => s.codec_type === 'audio')
      assert.equal(vStream?.width, 1080)
      assert.equal(vStream?.height, 1920)
      assert.ok(aStream, 'Rendered dubbed MP4 must contain synthesized + BGM AAC audio stream')
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
