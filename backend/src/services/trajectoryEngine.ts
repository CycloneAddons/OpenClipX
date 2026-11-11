import type {
  ClipTrackingResult,
  CompositionMode,
  FaceDetectionBox,
  TrackingFrameSample
} from '../types/index.ts'

export interface RawTrackingPayload {
  sourceWidth: number
  sourceHeight: number
  analysisWidth: number
  analysisHeight: number
  sampleFps: number
  durationSec: number
  frames: Array<{
    timeSec: number
    sceneCut: boolean
    activeSpeakerId: number | null
    faces: FaceDetectionBox[]
  }>
}

function makeEven(n: number): number {
  const r = Math.round(n)
  return r % 2 === 0 ? r : Math.max(2, r - 1)
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/**
 * Computes exact 9:16 crop window pixel dimensions inside source (W x H).
 */
export function calculate916CropDimensions(
  srcW: number,
  srcH: number
): { cropW: number; cropH: number } {
  const targetRatio = 9 / 16
  const srcRatio = srcW / Math.max(1, srcH)

  if (srcRatio >= targetRatio) {
    // Landscape, square, or 4:3 -> full height, narrower width
    const cropH = makeEven(srcH)
    const cropW = Math.min(makeEven(srcW), makeEven(cropH * targetRatio))
    return { cropW, cropH }
  }
  // Already taller than 9:16
  const cropW = makeEven(srcW)
  const cropH = Math.min(makeEven(srcH), makeEven(cropW / targetRatio))
  return { cropW, cropH }
}

/**
 * Computes dual-split crop box (each panel scales to 1080x960 = 9:8 aspect) inside source (W x H).
 */
export function calculateDualSplitCropDimensions(
  srcW: number,
  srcH: number
): { cropW: number; cropH: number } {
  // Each panel is 1080x960 (aspect 1.125 = 9:8). Cap at 52% source width on landscape sources
  // so left/right panels stay centered on their own speaker without heavy center overlap.
  const panelRatio = 1080 / 960
  const srcRatio = srcW / Math.max(1, srcH)
  const maxHalfW = srcRatio >= 1.25 ? makeEven(srcW * 0.52) : makeEven(srcW)
  let cropH = makeEven(srcH)
  let cropW = makeEven(cropH * panelRatio)

  if (cropW > maxHalfW) {
    cropW = maxHalfW
    cropH = makeEven(Math.min(srcH, cropW / panelRatio))
  }
  return {
    cropW: Math.max(64, Math.min(makeEven(srcW), cropW)),
    cropH: Math.max(64, Math.min(makeEven(srcH), cropH))
  }
}

/**
 * Computes ideal crop top-left (normX, normY) preserving face headroom and chin clearance.
 */
export function computeTargetCropForFace(params: {
  faceCx: number
  faceCy: number
  faceW: number
  faceH: number
  cropNormW: number
  cropNormH: number
}): { x: number; y: number } {
  const { faceCx, faceCy, faceH, cropNormW, cropNormH } = params

  // Horizontally center on face center, strictly clamped inside [0, 1 - cropNormW]
  const rawX = faceCx - cropNormW * 0.5
  const x = clamp(rawX, 0, Math.max(0, 1 - cropNormW))

  // Vertically position face center at ~36% from top of crop (good Shorts headroom & subtitle margin)
  let rawY = faceCy - cropNormH * 0.36

  // Guarantee forehead & chin remain inside crop whenever face fits vertically
  const faceTop = faceCy - faceH * 0.55
  const faceBottom = faceCy + faceH * 0.55
  const headroomPad = cropNormH * 0.05
  const chinPad = cropNormH * 0.08

  if (faceBottom + chinPad - (faceTop - headroomPad) <= cropNormH) {
    if (rawY > faceTop - headroomPad) {
      rawY = faceTop - headroomPad
    }
    if (rawY + cropNormH < faceBottom + chinPad) {
      rawY = faceBottom + chinPad - cropNormH
    }
  }

  const y = clamp(rawY, 0, Math.max(0, 1 - cropNormH))
  return { x, y }
}

function faceIou(a: FaceDetectionBox, b: FaceDetectionBox): number {
  const ax2 = a.x + a.w
  const ay2 = a.y + a.h
  const bx2 = b.x + b.w
  const by2 = b.y + b.h
  const ix1 = Math.max(a.x, b.x)
  const iy1 = Math.max(a.y, b.y)
  const ix2 = Math.min(ax2, bx2)
  const iy2 = Math.min(ay2, by2)
  const iw = Math.max(0, ix2 - ix1)
  const ih = Math.max(0, iy2 - iy1)
  const inter = iw * ih
  if (inter <= 0) return 0
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/**
 * Selects the best distinct pair of faces on a single frame for a 2-person top/bottom split.
 * Returns null if 0 or 1 reliable person is in frame (or both faces overlap/merge into one single crop).
 */
function findDualPairInFrame(
  faces: FaceDetectionBox[],
  requested: CompositionMode,
  singleNormW: number
): [FaceDetectionBox, FaceDetectionBox] | null {
  const reliable = faces.filter(
    (f) => f.confidence >= 0.68 && f.w >= 0.025 && f.h >= 0.045
  )
  if (reliable.length < 2) return null

  const minSep = singleNormW * (requested === 'dual' ? 0.36 : 0.42)
  let bestScore = -1
  let bestPair: [FaceDetectionBox, FaceDetectionBox] | null = null

  for (let i = 0; i < reliable.length; i++) {
    const a = reliable[i]!
    for (let j = i + 1; j < reliable.length; j++) {
      const b = reliable[j]!
      if (a.trackId === b.trackId) continue
      if (faceIou(a, b) >= 0.15) continue
      const hRatio = Math.min(a.h, b.h) / Math.max(1e-4, Math.max(a.h, b.h))
      if (hRatio < 0.4) continue

      const sep = Math.abs(a.cx - b.cx)
      if (sep <= minSep) continue

      const scoreA = a.confidence * Math.sqrt(a.w * a.h) + a.speakerScore * 0.3
      const scoreB = b.confidence * Math.sqrt(b.w * b.h) + b.speakerScore * 0.3
      const pairScore = scoreA + scoreB + sep * 0.15
      if (pairScore > bestScore) {
        bestScore = pairScore
        bestPair = a.cx <= b.cx ? [a, b] : [b, a]
      }
    }
  }

  return bestPair
}

/**
 * Classifies every frame dynamically into 'single' (full 9:16) or 'dual_split' (top+bottom split)
 * using scene-cut awareness and temporal hysteresis so shots switch crisply without detection flicker.
 */
function classifyFrameLayouts(
  raw: RawTrackingPayload,
  requested: CompositionMode,
  singleNormW: number
): Array<'single' | 'dual_split'> {
  const frames = raw.frames
  const n = frames.length
  if (n === 0 || requested === 'single') {
    return frames.map(() => 'single')
  }

  const rawDual: boolean[] = frames.map(
    (fr) => findDualPairInFrame(fr.faces, requested, singleNormW) !== null
  )

  // Partition into scene shots bounded by sceneCut
  const shots: Array<{ start: number; end: number }> = []
  let shotStart = 0
  for (let i = 1; i < n; i++) {
    if (frames[i]!.sceneCut) {
      shots.push({ start: shotStart, end: i })
      shotStart = i
    }
  }
  shots.push({ start: shotStart, end: n })

  for (const shot of shots) {
    const { start, end } = shot
    const shotLen = end - start
    if (shotLen <= 0) continue

    const estStep =
      shotLen > 1
        ? Math.max(0.04, frames[end - 1]!.timeSec - frames[start]!.timeSec) / (shotLen - 1)
        : 0.2
    const shotDur = frames[end - 1]!.timeSec - frames[start]!.timeSec + estStep

    // A) Close short 'single' dropouts (< 0.60s) inside a dual shot (e.g., temporary occlusion/head turn)
    let idx = start
    while (idx < end) {
      if (!rawDual[idx]) {
        let rEnd = idx + 1
        while (rEnd < end && !rawDual[rEnd]) rEnd++
        const boundedBothSides = idx > start && rEnd < end
        if (boundedBothSides) {
          const gapDur = frames[rEnd]!.timeSec - frames[idx - 1]!.timeSec
          if (gapDur < 0.6) {
            for (let k = idx; k < rEnd; k++) rawDual[k] = true
          }
        }
        idx = rEnd
      } else {
        idx++
      }
    }

    // B) Extend across tiny (< 0.45s) leading/trailing gaps at shot boundaries into sustained dual runs
    let leadEnd = start
    while (leadEnd < end && !rawDual[leadEnd]) leadEnd++
    if (leadEnd > start && leadEnd < end) {
      const leadDur = frames[leadEnd]!.timeSec - frames[start]!.timeSec
      let dualRunEnd = leadEnd + 1
      while (dualRunEnd < end && rawDual[dualRunEnd]) dualRunEnd++
      const nextDur =
        dualRunEnd < end
          ? frames[dualRunEnd]!.timeSec - frames[leadEnd]!.timeSec
          : frames[end - 1]!.timeSec - frames[leadEnd]!.timeSec + estStep
      if (leadDur < 0.45 && (nextDur >= 0.7 || dualRunEnd === end)) {
        for (let k = start; k < leadEnd; k++) rawDual[k] = true
      }
    }

    let trailStart = end
    while (trailStart > start && !rawDual[trailStart - 1]) trailStart--
    if (trailStart < end && trailStart > start) {
      const trailDur = frames[end - 1]!.timeSec - frames[trailStart]!.timeSec + estStep
      let prevDualStart = trailStart - 1
      while (prevDualStart > start && rawDual[prevDualStart - 1]) prevDualStart--
      const prevDur = frames[trailStart]!.timeSec - frames[prevDualStart]!.timeSec
      if (trailDur < 0.45 && (prevDur >= 0.7 || prevDualStart === start)) {
        for (let k = trailStart; k < end; k++) rawDual[k] = true
      }
    }

    // C) Prune brief false dual spikes (< 0.65s) unless majority of a genuine short reaction cut
    idx = start
    while (idx < end) {
      if (rawDual[idx]) {
        let rEnd = idx + 1
        while (rEnd < end && rawDual[rEnd]) rEnd++
        const runCount = rEnd - idx
        const runDur =
          rEnd < end
            ? frames[rEnd]!.timeSec - frames[idx]!.timeSec
            : frames[end - 1]!.timeSec - frames[idx]!.timeSec + estStep
        const isShortReactionCut =
          shotDur >= 0.45 && shotDur < 1.2 && runCount >= 3 && runCount >= shotLen * 0.58
        if (!isShortReactionCut && runDur < 0.65) {
          for (let k = idx; k < rEnd; k++) rawDual[k] = false
        }
        idx = rEnd
      } else {
        idx++
      }
    }
  }

  return rawDual.map((isDual) => (isDual ? 'dual_split' : 'single'))
}

/**
 * Critically-damped velocity-aware camera smoother with dead-zone and scene-cut snap.
 */
class SmoothCameraFilter {
  private x = 0.5
  private y = 0.5
  private vx = 0
  private vy = 0
  private initialized = false

  constructor(
    private readonly maxX: number,
    private readonly maxY: number,
    private readonly cropNormW: number,
    private readonly cropNormH: number
  ) {}

  public step(
    targetX: number,
    targetY: number,
    dt: number,
    sceneCut: boolean
  ): { x: number; y: number } {
    const clampedTargetX = clamp(targetX, 0, this.maxX)
    const clampedTargetY = clamp(targetY, 0, this.maxY)

    if (!this.initialized || sceneCut) {
      this.x = clampedTargetX
      this.y = clampedTargetY
      this.vx = 0
      this.vy = 0
      this.initialized = true
      return { x: this.x, y: this.y }
    }

    const safeDt = Math.max(0.01, Math.min(0.25, dt))

    // Dead-zone suppresses micro-tremors when person is mostly still
    const deadZoneX = this.cropNormW * 0.022
    const deadZoneY = this.cropNormH * 0.025

    const dx = clampedTargetX - this.x
    const dy = clampedTargetY - this.y

    const effDx = Math.abs(dx) <= deadZoneX ? 0 : dx - Math.sign(dx) * deadZoneX
    const effDy = Math.abs(dy) <= deadZoneY ? 0 : dy - Math.sign(dy) * deadZoneY

    // Critically damped spring (omega = 6.5 rad/s -> natural ~0.35s follow without overshoot)
    const omega = 6.5
    const ax = omega * omega * effDx - 2 * omega * this.vx
    const ay = omega * omega * effDy - 2 * omega * this.vy

    this.vx += ax * safeDt
    this.vy += ay * safeDt

    // Max pan speed cap prevents jarring sudden horizontal jumps
    const maxSpeedX = Math.max(0.25, this.cropNormW * 1.1)
    const maxSpeedY = Math.max(0.2, this.cropNormH * 0.8)
    this.vx = clamp(this.vx, -maxSpeedX, maxSpeedX)
    this.vy = clamp(this.vy, -maxSpeedY, maxSpeedY)

    this.x = clamp(this.x + this.vx * safeDt, 0, this.maxX)
    this.y = clamp(this.y + this.vy * safeDt, 0, this.maxY)

    return { x: this.x, y: this.y }
  }
}

export function buildSmoothTrajectory(params: {
  clipId: string
  raw: RawTrackingPayload
  sourceFps: number
  compositionMode: CompositionMode
}): ClipTrackingResult {
  const { clipId, raw, sourceFps, compositionMode } = params
  const srcW = raw.sourceWidth
  const srcH = raw.sourceHeight

  const { cropW: singleW, cropH: singleH } = calculate916CropDimensions(srcW, srcH)
  const singleNormW = singleW / srcW
  const singleNormH = singleH / srcH

  const { cropW: dualW, cropH: dualH } = calculateDualSplitCropDimensions(srcW, srcH)
  const dualNormW = dualW / srcW
  const dualNormH = dualH / srcH

  const frameLayouts = classifyFrameLayouts(raw, compositionMode, singleNormW)

  const camSingle = new SmoothCameraFilter(
    Math.max(0, 1 - singleNormW),
    Math.max(0, 1 - singleNormH),
    singleNormW,
    singleNormH
  )
  const camDualPrimary = new SmoothCameraFilter(
    Math.max(0, 1 - dualNormW),
    Math.max(0, 1 - dualNormH),
    dualNormW,
    dualNormH
  )
  const camDualSecondary = new SmoothCameraFilter(
    Math.max(0, 1 - dualNormW),
    Math.max(0, 1 - dualNormH),
    dualNormW,
    dualNormH
  )

  const defaultSingleTarget = () => ({
    x: Math.max(0, (1 - singleNormW) * 0.5),
    y: Math.max(0, (1 - singleNormH) * 0.35)
  })
  const defaultDualLeftTarget = () => ({
    x: 0,
    y: Math.max(0, (1 - dualNormH) * 0.35)
  })
  const defaultDualRightTarget = () => ({
    x: Math.max(0, 1 - dualNormW),
    y: Math.max(0, (1 - dualNormH) * 0.35)
  })

  // Partition frames into contiguous layout + scene-cut segments
  const segments: Array<{ start: number; end: number; layout: 'single' | 'dual_split' }> = []
  if (raw.frames.length > 0) {
    let segStart = 0
    for (let i = 1; i < raw.frames.length; i++) {
      const fr = raw.frames[i]!
      if (fr.sceneCut || frameLayouts[i] !== frameLayouts[i - 1]) {
        segments.push({ start: segStart, end: i, layout: frameLayouts[segStart]! })
        segStart = i
      }
    }
    segments.push({ start: segStart, end: raw.frames.length, layout: frameLayouts[segStart]! })
  }

  const outFrames: TrackingFrameSample[] = []
  let prevTime = 0
  let confSum = 0
  let confCount = 0
  const distinctTracks = new Set<number>()

  for (const seg of segments) {
    if (seg.layout === 'dual_split') {
      // Determine dominant left & right speakers inside this dual_split segment
      const segStats = new Map<
        number,
        { count: number; cxSum: number; scoreSum: number; firstFace: FaceDetectionBox }
      >()
      for (let i = seg.start; i < seg.end; i++) {
        const pair = findDualPairInFrame(raw.frames[i]!.faces, compositionMode, singleNormW)
        const candidates =
          pair ?? raw.frames[i]!.faces.filter((f) => f.confidence >= 0.65)
        for (const f of candidates) {
          const st = segStats.get(f.trackId)
          if (st) {
            st.count += 1
            st.cxSum += f.cx
            st.scoreSum += f.isActiveSpeaker ? f.speakerScore * 1.5 : f.speakerScore * 0.5
          } else {
            segStats.set(f.trackId, {
              count: 1,
              cxSum: f.cx,
              scoreSum: f.isActiveSpeaker ? f.speakerScore * 1.5 : f.speakerScore * 0.5,
              firstFace: f
            })
          }
        }
      }

      const rankedSeg = Array.from(segStats.entries())
        .map(([id, st]) => ({
          id,
          count: st.count,
          avgCx: st.cxSum / Math.max(1, st.count),
          score: st.scoreSum + st.count * 0.25,
          firstFace: st.firstFace
        }))
        .sort((a, b) => b.score - a.score)

      let segLeftId: number | null = rankedSeg[0]?.id ?? null
      let segRightId: number | null = rankedSeg[1]?.id ?? null
      if (segLeftId !== null && segRightId !== null) {
        const leftStat = rankedSeg[0]!
        const rightStat = rankedSeg[1]!
        if (leftStat.avgCx > rightStat.avgCx) {
          ;[segLeftId, segRightId] = [segRightId, segLeftId]
        }
      }

      const initLeftFace = rankedSeg.find((s) => s.id === segLeftId)?.firstFace
      const initRightFace = rankedSeg.find((s) => s.id === segRightId)?.firstFace

      let lastPrimaryTarget = initLeftFace
        ? computeTargetCropForFace({
            faceCx: initLeftFace.cx,
            faceCy: initLeftFace.cy,
            faceW: initLeftFace.w,
            faceH: initLeftFace.h,
            cropNormW: dualNormW,
            cropNormH: dualNormH
          })
        : defaultDualLeftTarget()
      let lastSecondaryTarget = initRightFace
        ? computeTargetCropForFace({
            faceCx: initRightFace.cx,
            faceCy: initRightFace.cy,
            faceW: initRightFace.w,
            faceH: initRightFace.h,
            cropNormW: dualNormW,
            cropNormH: dualNormH
          })
        : defaultDualRightTarget()

      let lastLeftCx = initLeftFace?.cx ?? 0.25
      let lastRightCx = initRightFace?.cx ?? 0.75

      for (let i = seg.start; i < seg.end; i++) {
        const fr = raw.frames[i]!
        const dt = i === 0 ? 0.1 : Math.max(0.01, fr.timeSec - prevTime)
        prevTime = fr.timeSec

        for (const f of fr.faces) {
          distinctTracks.add(f.trackId)
          confSum += f.confidence
          confCount += 1
        }

        const reliable = fr.faces.filter((f) => f.confidence >= 0.65)
        const pool = reliable.length > 0 ? reliable : fr.faces

        let leftFace =
          segLeftId !== null ? pool.find((f) => f.trackId === segLeftId) : undefined
        let rightFace =
          segRightId !== null ? pool.find((f) => f.trackId === segRightId) : undefined

        if (!leftFace) {
          leftFace = pool
            .filter(
              (f) =>
                f.trackId !== rightFace?.trackId &&
                f.trackId !== segRightId &&
                Math.abs(f.cx - lastLeftCx) <= Math.abs(f.cx - lastRightCx)
            )
            .sort((a, b) => Math.abs(a.cx - lastLeftCx) - Math.abs(b.cx - lastLeftCx))[0]
        }
        if (!rightFace) {
          rightFace = pool
            .filter(
              (f) =>
                f.trackId !== leftFace?.trackId &&
                f.trackId !== segLeftId &&
                Math.abs(f.cx - lastRightCx) <= Math.abs(f.cx - lastLeftCx)
            )
            .sort((a, b) => Math.abs(a.cx - lastRightCx) - Math.abs(b.cx - lastRightCx))[0]
        }

        if (leftFace) {
          lastLeftCx = leftFace.cx
          lastPrimaryTarget = computeTargetCropForFace({
            faceCx: leftFace.cx,
            faceCy: leftFace.cy,
            faceW: leftFace.w,
            faceH: leftFace.h,
            cropNormW: dualNormW,
            cropNormH: dualNormH
          })
        }
        if (rightFace && rightFace.trackId !== leftFace?.trackId) {
          lastRightCx = rightFace.cx
          lastSecondaryTarget = computeTargetCropForFace({
            faceCx: rightFace.cx,
            faceCy: rightFace.cy,
            faceW: rightFace.w,
            faceH: rightFace.h,
            cropNormW: dualNormW,
            cropNormH: dualNormH
          })
        }

        const snap = i === seg.start || fr.sceneCut
        const smoothP = camDualPrimary.step(lastPrimaryTarget.x, lastPrimaryTarget.y, dt, snap)
        const smoothS = camDualSecondary.step(
          lastSecondaryTarget.x,
          lastSecondaryTarget.y,
          dt,
          snap
        )

        outFrames.push({
          timeSec: fr.timeSec,
          sceneCut: fr.sceneCut,
          activeSpeakerId: fr.activeSpeakerId,
          layoutMode: 'dual_split',
          faces: fr.faces,
          cropPrimary: {
            x: Math.round(smoothP.x * 10000) / 10000,
            y: Math.round(smoothP.y * 10000) / 10000,
            w: Math.round(dualNormW * 10000) / 10000,
            h: Math.round(dualNormH * 10000) / 10000
          },
          cropSecondary: {
            x: Math.round(smoothS.x * 10000) / 10000,
            y: Math.round(smoothS.y * 10000) / 10000,
            w: Math.round(dualNormW * 10000) / 10000,
            h: Math.round(dualNormH * 10000) / 10000
          }
        })
      }
    } else {
      // Single 9:16 crop segment
      let seedFace: FaceDetectionBox | undefined
      for (let k = seg.start; k < seg.end; k++) {
        const fList = raw.frames[k]!.faces
        if (fList.length > 0) {
          seedFace =
            fList.find((f) => f.trackId === raw.frames[k]!.activeSpeakerId) ??
            fList.slice().sort((a, b) => b.confidence - a.confidence)[0]
          break
        }
      }
      let lastSingleTarget = seedFace
        ? computeTargetCropForFace({
            faceCx: seedFace.cx,
            faceCy: seedFace.cy,
            faceW: seedFace.w,
            faceH: seedFace.h,
            cropNormW: singleNormW,
            cropNormH: singleNormH
          })
        : defaultSingleTarget()

      for (let i = seg.start; i < seg.end; i++) {
        const fr = raw.frames[i]!
        const dt = i === 0 ? 0.1 : Math.max(0.01, fr.timeSec - prevTime)
        prevTime = fr.timeSec

        for (const f of fr.faces) {
          distinctTracks.add(f.trackId)
          confSum += f.confidence
          confCount += 1
        }

        const reliable = fr.faces.filter((f) => f.confidence >= 0.6)
        const pool = reliable.length > 0 ? reliable : fr.faces

        let targetFace =
          pool.find((f) => f.trackId === fr.activeSpeakerId) ??
          pool
            .slice()
            .sort(
              (a, b) =>
                b.speakerScore * Math.sqrt(b.w * b.h) - a.speakerScore * Math.sqrt(a.w * a.h)
            )[0]

        // If two people stand close enough to fit comfortably inside a single 9:16 crop, frame midpoint
        if (compositionMode !== 'single' && pool.length >= 2) {
          const sorted = pool.slice().sort((a, b) => b.speakerScore - a.speakerScore)
          const f1 = sorted[0]!
          const f2 = sorted[1]!
          if (f1.trackId !== f2.trackId && faceIou(f1, f2) < 0.15) {
            const leftEdge = Math.min(f1.x, f2.x)
            const rightEdge = Math.max(f1.x + f1.w, f2.x + f2.w)
            const outerSpan = rightEdge - leftEdge
            if (outerSpan <= singleNormW * 0.8) {
              targetFace = {
                ...f1,
                cx: 0.5 * (f1.cx + f2.cx),
                cy: 0.5 * (f1.cy + f2.cy),
                w: outerSpan,
                h: Math.max(f1.h, f2.h)
              }
            }
          }
        }

        if (targetFace) {
          lastSingleTarget = computeTargetCropForFace({
            faceCx: targetFace.cx,
            faceCy: targetFace.cy,
            faceW: targetFace.w,
            faceH: targetFace.h,
            cropNormW: singleNormW,
            cropNormH: singleNormH
          })
        }

        const snap = i === seg.start || fr.sceneCut
        const smoothP = camSingle.step(lastSingleTarget.x, lastSingleTarget.y, dt, snap)

        outFrames.push({
          timeSec: fr.timeSec,
          sceneCut: fr.sceneCut,
          activeSpeakerId: fr.activeSpeakerId,
          layoutMode: 'single',
          faces: fr.faces,
          cropPrimary: {
            x: Math.round(smoothP.x * 10000) / 10000,
            y: Math.round(smoothP.y * 10000) / 10000,
            w: Math.round(singleNormW * 10000) / 10000,
            h: Math.round(singleNormH * 10000) / 10000
          },
          cropSecondary: null
        })
      }
    }
  }

  // Fallback frame if clip produced zero samples
  if (outFrames.length === 0) {
    outFrames.push({
      timeSec: 0,
      sceneCut: false,
      activeSpeakerId: null,
      layoutMode: 'single',
      faces: [],
      cropPrimary: {
        x: Math.round(Math.max(0, (1 - singleNormW) * 0.5) * 10000) / 10000,
        y: Math.round(Math.max(0, (1 - singleNormH) * 0.5) * 10000) / 10000,
        w: Math.round(singleNormW * 10000) / 10000,
        h: Math.round(singleNormH * 10000) / 10000
      },
      cropSecondary: null
    })
  }

  const hasSingle = outFrames.some((f) => f.layoutMode === 'single')
  const hasDual = outFrames.some((f) => f.layoutMode === 'dual_split')
  const compositionModeResolved: ClipTrackingResult['compositionModeResolved'] =
    hasSingle && hasDual ? 'dynamic' : hasDual ? 'dual_split' : 'single'

  return {
    clipId,
    sourceWidth: srcW,
    sourceHeight: srcH,
    sourceFps,
    durationSec: raw.durationSec,
    compositionModeRequested: compositionMode,
    compositionModeResolved,
    speakersDetected: distinctTracks.size,
    averageTrackingConfidence:
      confCount > 0 ? Math.round((confSum / confCount) * 1000) / 1000 : 0,
    frames: outFrames
  }
}

