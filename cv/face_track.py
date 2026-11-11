#!/usr/bin/env python3
"""
Streamed, memory-bounded face detection, tracking, and active speaker analysis.
Decodes only the target clip slice via FFmpeg pipe at scaled analysis resolution
so peak memory stays O(1) (~180-280 MB RSS) even on 4K source videos.
"""
import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np


def compute_iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    union = aw * ah + bw * bh - inter
    return inter / max(1e-6, union)


class TrackedFace:
    def __init__(self, track_id: int, bbox: tuple[float, float, float, float], conf: float, t: float, landmarks: dict):
        self.track_id = track_id
        x, y, w, h = bbox
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.cx = x + w * 0.5
        self.cy = y + h * 0.5
        self.vx = 0.0
        self.vy = 0.0
        self.conf = conf
        self.last_seen = t
        self.age_frames = 1
        self.hits = 1
        self.missed = 0
        self.landmarks = landmarks
        self.prev_mouth_patch: np.ndarray | None = None
        self.prev_lip_gap: float | None = None
        self.mouth_activity = 0.0
        self.speaker_score = 0.15

    def predict(self, dt: float) -> tuple[float, float, float, float]:
        if dt <= 0:
            return (self.x, self.y, self.w, self.h)
        # Damp velocity over missed frames
        damp = math.exp(-3.0 * dt)
        px = max(0.0, min(1.0 - self.w, self.x + self.vx * dt * damp))
        py = max(0.0, min(1.0 - self.h, self.y + self.vy * dt * damp))
        return (px, py, self.w, self.h)

    def update(
        self,
        bbox: tuple[float, float, float, float],
        conf: float,
        t: float,
        landmarks: dict,
    ) -> None:
        dt = max(1e-3, t - self.last_seen)
        x, y, w, h = bbox
        ncx = x + w * 0.5
        ncy = y + h * 0.5
        inst_vx = (ncx - self.cx) / dt
        inst_vy = (ncy - self.cy) / dt
        # Clamp unrealistic spike velocities
        inst_vx = max(-1.5, min(1.5, inst_vx))
        inst_vy = max(-1.5, min(1.5, inst_vy))
        self.vx = 0.6 * self.vx + 0.4 * inst_vx
        self.vy = 0.6 * self.vy + 0.4 * inst_vy
        # Smooth box geometry slightly to suppress detector box jitter
        alpha = 0.72
        self.x = alpha * x + (1 - alpha) * self.x
        self.y = alpha * y + (1 - alpha) * self.y
        self.w = alpha * w + (1 - alpha) * self.w
        self.h = alpha * h + (1 - alpha) * self.h
        self.cx = self.x + self.w * 0.5
        self.cy = self.y + self.h * 0.5
        self.conf = 0.5 * self.conf + 0.5 * conf
        self.last_seen = t
        self.age_frames += 1
        self.hits += 1
        self.missed = 0
        self.landmarks = landmarks


def load_speech_mask(energy_path: str | None, transcript_path: str | None, start_sec: float, duration_sec: float):
    """Returns a fast lookup function is_speech(clip_rel_t) -> float in [0, 1]."""
    energy_rms = []
    hop_sec = 0.05
    thresh = 0.01
    if energy_path and Path(energy_path).exists():
        data = json.loads(Path(energy_path).read_text(encoding="utf-8"))
        energy_rms = data.get("rms", [])
        hop_sec = float(data.get("hopMs", 50)) / 1000.0
        thresh = float(data.get("speechThreshold", 0.01))

    speech_intervals: list[tuple[float, float]] = []
    if transcript_path and Path(transcript_path).exists():
        tdata = json.loads(Path(transcript_path).read_text(encoding="utf-8"))
        for seg in tdata.get("segments", []):
            s0 = float(seg.get("start", 0.0))
            s1 = float(seg.get("end", 0.0))
            if s1 >= start_sec and s0 <= start_sec + duration_sec:
                speech_intervals.append((s0 - start_sec, s1 - start_sec))

    def get_speech_weight(rel_t: float) -> float:
        abs_t = start_sec + rel_t
        e_score = 0.5
        if energy_rms:
            idx = int(abs_t / hop_sec)
            if 0 <= idx < len(energy_rms):
                rms = float(energy_rms[idx])
                e_score = max(0.0, min(1.0, (rms - thresh * 0.5) / max(1e-4, thresh * 1.8)))
        t_score = 0.0
        for s0, s1 in speech_intervals:
            if s0 - 0.15 <= rel_t <= s1 + 0.15:
                t_score = 1.0
                break
        if speech_intervals and energy_rms:
            return 0.65 * e_score + 0.35 * t_score
        if energy_rms:
            return e_score
        if speech_intervals:
            return t_score
        return 0.6

    return get_speech_weight


def compute_mouth_roi_activity(
    frame_gray: np.ndarray,
    track: TrackedFace,
    frame_w: int,
    frame_h: int,
) -> float:
    """Lightweight optical/luminance delta inside the normalized mouth patch."""
    lm = track.landmarks
    if "mouth_rx" in lm and "mouth_lx" in lm:
        mx1 = min(lm["mouth_rx"], lm["mouth_lx"])
        mx2 = max(lm["mouth_rx"], lm["mouth_lx"])
        my = 0.5 * (lm["mouth_ry"] + lm["mouth_ly"])
        mw = max(mx2 - mx1, track.w * 0.32)
        cx = 0.5 * (mx1 + mx2)
        cy = my
    else:
        cx = track.cx
        cy = track.y + track.h * 0.76
        mw = track.w * 0.42

    mh = track.h * 0.24
    x1 = max(0, int((cx - mw * 0.65) * frame_w))
    x2 = min(frame_w, int((cx + mw * 0.65) * frame_w))
    y1 = max(0, int((cy - mh * 0.55) * frame_h))
    y2 = min(frame_h, int((cy + mh * 0.55) * frame_h))
    if x2 - x1 < 8 or y2 - y1 < 6:
        return 0.0

    patch = cv2.resize(frame_gray[y1:y2, x1:x2], (24, 16), interpolation=cv2.INTER_AREA).astype(np.float32)
    # Normalize illumination per patch to resist global lighting flicker
    mean_v = float(np.mean(patch))
    std_v = float(np.std(patch)) + 1e-4
    norm_patch = (patch - mean_v) / std_v

    activity = 0.0
    if track.prev_mouth_patch is not None:
        mad = float(np.mean(np.abs(norm_patch - track.prev_mouth_patch)))
        activity = max(0.0, min(1.0, (mad - 0.08) / 0.45))
    track.prev_mouth_patch = norm_patch
    return activity


def measure_mediapipe_lip_gap(
    landmarker,
    mp_mod,
    frame_rgb: np.ndarray,
    track: TrackedFace,
    frame_w: int,
    frame_h: int,
) -> float | None:
    """Measure normalized inner lip aperture using MediaPipe FaceLandmarker on cropped face ROI."""
    pad_x = track.w * 0.25
    pad_y = track.h * 0.25
    x1 = max(0, int((track.x - pad_x) * frame_w))
    y1 = max(0, int((track.y - pad_y) * frame_h))
    x2 = min(frame_w, int((track.x + track.w + pad_x) * frame_w))
    y2 = min(frame_h, int((track.y + track.h + pad_y) * frame_h))
    if x2 - x1 < 24 or y2 - y1 < 24:
        return None

    roi = np.ascontiguousarray(frame_rgb[y1:y2, x1:x2])
    mp_img = mp_mod.Image(image_format=mp_mod.ImageFormat.SRGB, data=roi)
    res = landmarker.detect(mp_img)
    if not res.face_landmarks:
        return None

    lms = res.face_landmarks[0]
    if len(lms) <= 14:
        return None
    # Inner upper lip (13) and lower lip (14), outer corners (61, 291)
    lip_dist = abs(lms[14].y - lms[13].y)
    face_span = max(1e-4, abs(lms[152].y - lms[10].y) if len(lms) > 152 else 0.7)
    gap = lip_dist / face_span
    delta = 0.0
    if track.prev_lip_gap is not None:
        delta = abs(gap - track.prev_lip_gap)
    track.prev_lip_gap = gap
    return min(1.0, delta * 18.0 + max(0.0, gap - 0.015) * 4.5)


def estimate_frontal_score(landmarks: dict, w: float) -> float:
    if "eye_rx" not in landmarks or "eye_lx" not in landmarks or "nose_x" not in landmarks:
        return 0.7
    ex_min = min(landmarks["eye_rx"], landmarks["eye_lx"])
    ex_max = max(landmarks["eye_rx"], landmarks["eye_lx"])
    eye_span = max(1e-4, ex_max - ex_min)
    mid_eye = 0.5 * (ex_min + ex_max)
    asym = abs(landmarks["nose_x"] - mid_eye) / eye_span
    return max(0.35, min(1.0, 1.0 - asym * 0.6))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--start-sec", type=float, required=True)
    parser.add_argument("--duration-sec", type=float, required=True)
    parser.add_argument("--source-width", type=int, required=True)
    parser.add_argument("--source-height", type=int, required=True)
    parser.add_argument("--source-fps", type=float, required=True)
    parser.add_argument("--analysis-width", type=int, default=640)
    parser.add_argument("--base-fps", type=float, default=5.0)
    parser.add_argument("--boost-fps", type=float, default=12.0)
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--out-json", required=True)
    parser.add_argument("--energy-json", default="")
    parser.add_argument("--transcript-json", default="")
    parser.add_argument("--ffmpeg-bin", default="ffmpeg")
    parser.add_argument("--ffmpeg-threads", type=int, default=2)
    parser.add_argument("--use-mediapipe", type=int, default=1)
    args = parser.parse_args()

    src_w = args.source_width
    src_h = args.source_height
    ana_w = min(src_w, max(160, args.analysis_width))
    # Even-aligned scaled height preserving aspect ratio
    ana_h = max(90, int(round(src_h * (ana_w / src_w) / 2.0)) * 2)

    yunet_path = str(Path(args.models_dir) / "face_detection_yunet_2023mar.onnx")
    detector = cv2.FaceDetectorYN.create(
        yunet_path,
        "",
        (ana_w, ana_h),
        0.52,  # score_threshold
        0.30,  # nms_threshold
        50,
    )

    landmarker = None
    mp_mod = None
    landmarker_path = Path(args.models_dir) / "face_landmarker.task"
    if args.use_mediapipe and landmarker_path.exists():
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision

            opts = vision.FaceLandmarkerOptions(
                base_options=mp_python.BaseOptions(model_asset_path=str(landmarker_path)),
                running_mode=vision.RunningMode.IMAGE,
                num_faces=1,
                min_face_detection_confidence=0.4,
                min_face_presence_confidence=0.4,
            )
            landmarker = vision.FaceLandmarker.create_from_options(opts)
            mp_mod = mp
        except Exception as exc:
            print(json.dumps({"event": "warn", "detail": f"MediaPipe disabled: {exc}"}), flush=True)
            landmarker = None

    speech_weight_fn = load_speech_mask(
        args.energy_json or None,
        args.transcript_json or None,
        args.start_sec,
        args.duration_sec,
    )

    # Stream raw BGR frames from FFmpeg at analysis resolution
    stream_fps = max(args.base_fps, args.boost_fps)
    ff_cmd = [
        args.ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        str(max(1, args.ffmpeg_threads)),
        "-ss",
        f"{args.start_sec:.3f}",
        "-t",
        f"{args.duration_sec:.3f}",
        "-i",
        args.video,
        "-vf",
        f"fps={stream_fps:.3f},scale={ana_w}:{ana_h}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "pipe:1",
    ]

    proc = subprocess.Popen(ff_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = ana_w * ana_h * 3

    tracks: list[TrackedFace] = []
    next_track_id = 1
    active_speaker_id: int | None = None
    active_speaker_switch_t = -10.0
    prev_hist = None
    prev_quad_hists = None
    prev_small = None
    last_detect_t = -10.0
    boost_until_t = 0.5
    frame_idx = 0
    output_frames: list[dict] = []
    last_reported_pct = -1

    try:
        assert proc.stdout is not None
        while True:
            buf = proc.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break

            rel_t = frame_idx / stream_fps
            frame_idx += 1

            frame = np.frombuffer(buf, dtype=np.uint8).reshape((ana_h, ana_w, 3))
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

            # Spatial + global scene-cut detection (catches same-lighting wide <-> closeup cuts)
            hist = cv2.calcHist([gray], [0], None, [24], [0, 256])
            cv2.normalize(hist, hist)
            hh, hw = max(1, ana_h // 2), max(1, ana_w // 2)
            quad_hists = []
            for ry in (0, hh):
                for rx in (0, hw):
                    qh = cv2.calcHist([gray[ry : ry + hh, rx : rx + hw]], [0], None, [16], [0, 256])
                    cv2.normalize(qh, qh)
                    quad_hists.append(qh)
            small = cv2.resize(gray, (48, 27), interpolation=cv2.INTER_AREA).astype(np.int16)

            scene_cut = False
            if prev_hist is not None and prev_quad_hists is not None and prev_small is not None:
                corr = float(cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL))
                mean_q_corr = sum(
                    float(cv2.compareHist(pq, q, cv2.HISTCMP_CORREL))
                    for pq, q in zip(prev_quad_hists, quad_hists)
                ) / 4.0
                diff = np.abs(small - prev_small)
                mad = float(np.mean(diff)) / 255.0
                frac_diff = float(np.mean(diff > 24))
                if (
                    corr < 0.62
                    or mean_q_corr < 0.68
                    or (mad > 0.16 and frac_diff > 0.60 and mean_q_corr < 0.80)
                ):
                    scene_cut = True
                    boost_until_t = rel_t + 0.8
            prev_hist = hist
            prev_quad_hists = quad_hists
            prev_small = small

            if scene_cut:
                tracks.clear()
                active_speaker_id = None

            # Adaptive detection scheduling (~5 FPS normal, up to boost_fps when fast motion or uncertain)
            fast_motion = any(math.hypot(tr.vx, tr.vy) > 0.14 for tr in tracks)
            low_conf = any(tr.conf < 0.68 or tr.missed > 0 for tr in tracks)
            in_boost = rel_t <= boost_until_t or fast_motion or low_conf or len(tracks) == 0
            min_detect_interval = 1.0 / (args.boost_fps if in_boost else args.base_fps)
            should_detect = scene_cut or (rel_t - last_detect_t >= min_detect_interval - 1e-4)

            if should_detect:
                last_detect_t = rel_t
                _, raw_faces = detector.detect(frame)

                detections: list[tuple[tuple[float, float, float, float], float, dict]] = []
                if raw_faces is not None:
                    for row in raw_faces:
                        fx, fy, fw, fh = float(row[0]), float(row[1]), float(row[2]), float(row[3])
                        conf = float(row[14])
                        if fw < 8 or fh < 8 or conf < 0.45:
                            continue
                        nx = max(0.0, min(1.0, fx / ana_w))
                        ny = max(0.0, min(1.0, fy / ana_h))
                        nw = max(0.01, min(1.0 - nx, fw / ana_w))
                        nh = max(0.01, min(1.0 - ny, fh / ana_h))
                        lm = {
                            "eye_rx": float(row[4]) / ana_w,
                            "eye_ry": float(row[5]) / ana_h,
                            "eye_lx": float(row[6]) / ana_w,
                            "eye_ly": float(row[7]) / ana_h,
                            "nose_x": float(row[8]) / ana_w,
                            "nose_y": float(row[9]) / ana_h,
                            "mouth_rx": float(row[10]) / ana_w,
                            "mouth_ry": float(row[11]) / ana_h,
                            "mouth_lx": float(row[12]) / ana_w,
                            "mouth_ly": float(row[13]) / ana_h,
                        }
                        detections.append(((nx, ny, nw, nh), conf, lm))

                # Two-stage ByteTrack-inspired association
                high_dets = [i for i, d in enumerate(detections) if d[1] >= 0.70]
                low_dets = [i for i, d in enumerate(detections) if d[1] < 0.70]
                matched_tracks = set()
                matched_dets = set()

                def match_pass(det_indices: list[int], track_indices: list[int], iou_min: float, dist_max: float):
                    pairs = []
                    for ti in track_indices:
                        tr = tracks[ti]
                        pred = tr.predict(rel_t - tr.last_seen)
                        pcx = pred[0] + pred[2] * 0.5
                        pcy = pred[1] + pred[3] * 0.5
                        for di in det_indices:
                            if di in matched_dets:
                                continue
                            db, _, _ = detections[di]
                            dcx = db[0] + db[2] * 0.5
                            dcy = db[1] + db[3] * 0.5
                            iou = compute_iou(pred, db)
                            dist = math.hypot(pcx - dcx, pcy - dcy)
                            if iou >= iou_min or dist <= dist_max:
                                cost = 0.65 * (1.0 - iou) + 0.35 * min(1.0, dist / max(1e-3, dist_max))
                                pairs.append((cost, ti, di))
                    pairs.sort(key=lambda item: item[0])
                    for _, ti, di in pairs:
                        if ti in matched_tracks or di in matched_dets:
                            continue
                        matched_tracks.add(ti)
                        matched_dets.add(di)
                        db, conf, lm = detections[di]
                        tracks[ti].update(db, conf, rel_t, lm)

                all_track_idxs = list(range(len(tracks)))
                match_pass(high_dets, all_track_idxs, iou_min=0.18, dist_max=0.18)
                rem_tracks = [ti for ti in all_track_idxs if ti not in matched_tracks]
                match_pass(low_dets, rem_tracks, iou_min=0.12, dist_max=0.14)

                # If zero existing tracks matched and distant high-confidence faces spawned, treat as unflagged cut
                unflagged_cut = False
                if len(tracks) > 0 and len(matched_tracks) == 0 and len(high_dets) > 0:
                    min_pair_dist = min(
                        math.hypot(tr.cx - (detections[di][0][0] + detections[di][0][2] * 0.5),
                                   tr.cy - (detections[di][0][1] + detections[di][0][3] * 0.5))
                        for tr in tracks
                        for di in high_dets
                    )
                    if min_pair_dist > 0.22:
                        unflagged_cut = True
                        scene_cut = True
                        tracks.clear()
                        active_speaker_id = None

                if not unflagged_cut:
                    # Mark unmatched tracks as occluded/missed and prune stale (> 0.45s)
                    surviving: list[TrackedFace] = []
                    for ti, tr in enumerate(tracks):
                        if ti not in matched_tracks:
                            tr.missed += 1
                        if rel_t - tr.last_seen <= 0.45:
                            surviving.append(tr)
                    tracks = surviving

                # Spawn new tracks for unmatched high-confidence detections
                for di in high_dets:
                    if unflagged_cut or di not in matched_dets:
                        db, conf, lm = detections[di]
                        tracks.append(TrackedFace(next_track_id, db, conf, rel_t, lm))
                        next_track_id += 1
            else:
                # Between detection ticks, advance tracks smoothly using Kalman/velocity prediction
                for tr in tracks:
                    dt = 1.0 / stream_fps
                    damp = math.exp(-2.0 * dt)
                    tr.x = max(0.0, min(1.0 - tr.w, tr.x + tr.vx * dt * damp))
                    tr.y = max(0.0, min(1.0 - tr.h, tr.y + tr.vy * dt * damp))
                    tr.cx = tr.x + tr.w * 0.5
                    tr.cy = tr.y + tr.h * 0.5

            # Active speaker scoring across visible tracks
            speech_w = speech_weight_fn(rel_t)
            need_mp = landmarker is not None and len(tracks) >= 2 and speech_w > 0.25
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB) if need_mp else None

            for tr in tracks:
                # Only update mouth activity on actively observed/recent tracks
                if tr.missed == 0:
                    roi_act = compute_mouth_roi_activity(gray, tr, ana_w, ana_h)
                    mp_act = None
                    if need_mp and frame_rgb is not None:
                        mp_act = measure_mediapipe_lip_gap(landmarker, mp_mod, frame_rgb, tr, ana_w, ana_h)
                    combined_mouth = (0.55 * mp_act + 0.45 * roi_act) if mp_act is not None else roi_act
                    tr.mouth_activity = 0.65 * tr.mouth_activity + 0.35 * combined_mouth
                else:
                    tr.mouth_activity *= 0.85

                frontal = estimate_frontal_score(tr.landmarks, tr.w)
                area_prior = min(1.0, math.sqrt(max(1e-4, tr.w * tr.h)) * 2.5) * 0.12
                occlusion_pen = 0.45 if tr.missed > 0 else 1.0

                instant_speaker = (
                    (speech_w * (0.72 * tr.mouth_activity + 0.28 * frontal) + (1.0 - speech_w) * 0.2 * frontal + area_prior)
                    * occlusion_pen
                )
                tr.speaker_score = 0.80 * tr.speaker_score + 0.20 * instant_speaker

            visible_tracks = [
                t for t in tracks
                if t.missed <= 2 and (rel_t - t.last_seen) <= 0.25
            ]

            # Hysteresis-based active speaker selection (never switch nervously!)
            if visible_tracks:
                best_tr = max(visible_tracks, key=lambda t: t.speaker_score)
                current_tr = next((t for t in visible_tracks if t.track_id == active_speaker_id), None)

                if current_tr is None:
                    active_speaker_id = best_tr.track_id
                    active_speaker_switch_t = rel_t
                elif best_tr.track_id != current_tr.track_id:
                    dwell = rel_t - active_speaker_switch_t
                    current_lost = current_tr.missed >= 2
                    strong_takeover = (
                        speech_w > 0.3
                        and dwell >= 0.9
                        and best_tr.speaker_score > current_tr.speaker_score * 1.25 + 0.06
                    )
                    if current_lost or strong_takeover:
                        active_speaker_id = best_tr.track_id
                        active_speaker_switch_t = rel_t
            else:
                active_speaker_id = None

            faces_payload = []
            for tr in visible_tracks:
                faces_payload.append({
                    "trackId": tr.track_id,
                    "x": round(tr.x, 4),
                    "y": round(tr.y, 4),
                    "w": round(tr.w, 4),
                    "h": round(tr.h, 4),
                    "cx": round(tr.cx, 4),
                    "cy": round(tr.cy, 4),
                    "confidence": round(tr.conf, 3),
                    "mouthActivity": round(tr.mouth_activity, 3),
                    "speakerScore": round(tr.speaker_score, 3),
                    "isActiveSpeaker": tr.track_id == active_speaker_id,
                })

            output_frames.append({
                "timeSec": round(rel_t, 3),
                "sceneCut": scene_cut,
                "activeSpeakerId": active_speaker_id,
                "faces": faces_payload,
            })

            pct = min(98, int((rel_t / max(0.1, args.duration_sec)) * 100))
            if pct >= last_reported_pct + 10:
                last_reported_pct = pct
                print(json.dumps({"event": "progress", "percent": pct, "detail": f"Tracking faces ({rel_t:.1f}s/{args.duration_sec:.1f}s)"}), flush=True)
    finally:
        if proc.stdout:
            proc.stdout.close()
        stderr_out = proc.stderr.read().decode("utf-8", errors="ignore") if proc.stderr else ""
        ret = proc.wait()
        if landmarker is not None:
            landmarker.close()
        if ret != 0 and not output_frames:
            raise RuntimeError(f"ffmpeg stream decode failed (code {ret}): {stderr_out}")

    payload = {
        "sourceWidth": src_w,
        "sourceHeight": src_h,
        "analysisWidth": ana_w,
        "analysisHeight": ana_h,
        "sampleFps": stream_fps,
        "durationSec": args.duration_sec,
        "frames": output_frames,
    }
    Path(args.out_json).write_text(json.dumps(payload), encoding="utf-8")
    print(json.dumps({"event": "progress", "percent": 100, "detail": f"Tracked {len(output_frames)} frame samples"}), flush=True)


if __name__ == "__main__":
    main()

