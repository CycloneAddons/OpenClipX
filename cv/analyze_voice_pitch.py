#!/usr/bin/env python3
"""Lightweight acoustic fundamental-frequency (f0) analyzer for speaker gender hints.

Reads a 16 kHz (or arbitrary PCM16 mono) WAV file plus a JSON array of segments
[{ "idx": 0, "startSec": 0.0, "endSec": 2.4 }, ...] and estimates median f0 Hz
using McLeod's Normalized Square Difference Function (NSDF) in pure numpy.
Peak memory stays ~25 MB.
"""

from __future__ import annotations

import argparse
import json
import sys
import wave
from typing import Any

import numpy as np


def estimate_frame_f0_nsdf(frame: np.ndarray, sr: int) -> tuple[float | None, float]:
    """Return (f0_hz, clarity) for one windowed frame using NSDF."""
    n = frame.shape[0]
    if n < 128:
        return None, 0.0

    x = frame.astype(np.float64, copy=False)
    x = x - np.mean(x)

    energy = float(np.dot(x, x))
    rms = np.sqrt(energy / n)
    if rms < 0.005:
        return None, 0.0

    min_lag = max(8, int(sr / 310.0))  # ~310 Hz upper bound
    max_lag = min(n - 3, int(sr / 70.0))  # ~70 Hz lower bound
    if max_lag <= min_lag + 2:
        return None, 0.0

    # Fast FFT/correlate autocorrelation
    full_acf = np.correlate(x, x, mode="full")
    acf = full_acf[n - 1 :]

    # Cumulative prefix squares for exact NSDF denominator m[lag] = sum(x[:n-lag]^2) + sum(x[lag:]^2)
    sq = x * x
    csum = np.concatenate(([0.0], np.cumsum(sq)))
    total_sq = csum[-1]

    lags = np.arange(min_lag, max_lag + 1)
    head_sq = csum[n - lags]
    tail_sq = total_sq - csum[lags]
    denom = head_sq + tail_sq
    denom = np.maximum(denom, 1e-12)
    nsdf = (2.0 * acf[lags]) / denom

    # Find local maxima above zero
    interior = nsdf[1:-1]
    is_peak = (interior > nsdf[:-2]) & (interior >= nsdf[2:]) & (interior > 0.0)
    peak_indices = np.where(is_peak)[0] + 1  # index within nsdf slice
    if peak_indices.size == 0:
        return None, 0.0

    peak_vals = nsdf[peak_indices]
    max_clarity = float(np.max(peak_vals))
    if max_clarity < 0.45:
        return None, max_clarity

    # First-key-maximum rule avoids octave/subharmonic drops (e.g., picking f0/2 instead of f0)
    threshold = 0.85 * max_clarity
    chosen_local_idx = None
    for idx in peak_indices:
        if nsdf[idx] >= threshold:
            chosen_local_idx = int(idx)
            break

    if chosen_local_idx is None:
        return None, max_clarity

    lag = float(lags[chosen_local_idx])
    # Parabolic refinement around chosen peak
    if 0 < chosen_local_idx < len(nsdf) - 1:
        y_prev = float(nsdf[chosen_local_idx - 1])
        y_curr = float(nsdf[chosen_local_idx])
        y_next = float(nsdf[chosen_local_idx + 1])
        denom_parab = 2.0 * (y_prev - 2.0 * y_curr + y_next)
        if abs(denom_parab) > 1e-9:
            delta = (y_prev - y_next) / denom_parab
            if -0.5 <= delta <= 0.5:
                lag += delta

    if lag <= 0.0:
        return None, max_clarity

    f0 = float(sr) / lag
    if 75.0 <= f0 <= 300.0:
        return f0, max_clarity
    return None, max_clarity


def classify_pitch(median_f0: float | None, voiced_count: int) -> tuple[str, float]:
    if median_f0 is None or voiced_count < 3:
        return "unknown", 0.0
    if median_f0 < 148.0:
        # Deeper below 148 Hz -> higher confidence
        conf = min(0.95, max(0.55, 0.55 + (148.0 - median_f0) / 45.0))
        return "male", round(conf, 3)
    if median_f0 > 174.0:
        conf = min(0.95, max(0.55, 0.55 + (median_f0 - 174.0) / 50.0))
        return "female", round(conf, 3)
    # 148..174 Hz overlap band
    return "unknown", 0.35


def analyze_segments(wav_path: str, segments: list[dict[str, Any]]) -> dict[str, Any]:
    with wave.open(wav_path, "rb") as wf:
        sr = wf.getframerate()
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        total_frames = wf.getnframes()

        if sampwidth != 2:
            raise ValueError(f"Expected 16-bit PCM WAV, got {sampwidth * 8}-bit")

        win_samples = max(256, int(sr * 0.040))  # 40ms
        hop_samples = max(128, int(sr * 0.015))  # 15ms

        results: list[dict[str, Any]] = []
        for seg in segments:
            idx = seg.get("idx", 0)
            start_sec = max(0.0, float(seg.get("startSec", 0.0)))
            end_sec = max(start_sec, float(seg.get("endSec", start_sec)))

            start_frame = min(total_frames, int(start_sec * sr))
            end_frame = min(total_frames, int(end_sec * sr))
            count_frames = max(0, end_frame - start_frame)

            if count_frames < win_samples:
                results.append(
                    {
                        "idx": idx,
                        "startSec": start_sec,
                        "endSec": end_sec,
                        "medianF0Hz": None,
                        "p25F0Hz": None,
                        "p75F0Hz": None,
                        "voicedFrames": 0,
                        "totalFrames": 0,
                        "voicedRatio": 0.0,
                        "acousticGender": "unknown",
                        "confidence": 0.0,
                    }
                )
                continue

            wf.setpos(start_frame)
            raw_bytes = wf.readframes(count_frames)
            pcm = np.frombuffer(raw_bytes, dtype=np.int16)
            if n_channels > 1:
                pcm = pcm.reshape(-1, n_channels).mean(axis=1)
            samples = pcm.astype(np.float32) / 32768.0

            f0_values: list[float] = []
            frame_count = 0
            for offset in range(0, len(samples) - win_samples + 1, hop_samples):
                frame_count += 1
                window = samples[offset : offset + win_samples]
                f0, clarity = estimate_frame_f0_nsdf(window, sr)
                if f0 is not None and clarity >= 0.48:
                    f0_values.append(f0)

            voiced_count = len(f0_values)
            voiced_ratio = round(voiced_count / max(1, frame_count), 3)
            if voiced_count >= 3:
                arr = np.array(f0_values, dtype=np.float64)
                median_f0 = round(float(np.median(arr)), 1)
                p25_f0 = round(float(np.percentile(arr, 25)), 1)
                p75_f0 = round(float(np.percentile(arr, 75)), 1)
            else:
                median_f0 = None
                p25_f0 = None
                p75_f0 = None

            gender, conf = classify_pitch(median_f0, voiced_count)
            results.append(
                {
                    "idx": idx,
                    "startSec": start_sec,
                    "endSec": end_sec,
                    "medianF0Hz": median_f0,
                    "p25F0Hz": p25_f0,
                    "p75F0Hz": p75_f0,
                    "voicedFrames": voiced_count,
                    "totalFrames": frame_count,
                    "voicedRatio": voiced_ratio,
                    "acousticGender": gender,
                    "confidence": conf,
                }
            )

    return {
        "sampleRate": sr,
        "segments": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze acoustic voice pitch per segment.")
    parser.add_argument("--wav", required=True, help="Path to 16-bit PCM WAV file")
    parser.add_argument("--segments-json", required=True, help="Path to JSON array of segments")
    args = parser.parse_args()

    with open(args.segments_json, "r", encoding="utf-8") as f:
        segments = json.load(f)
    if not isinstance(segments, list):
        raise ValueError("--segments-json must be a JSON list")

    payload = analyze_segments(args.wav, segments)
    sys.stdout.write(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

