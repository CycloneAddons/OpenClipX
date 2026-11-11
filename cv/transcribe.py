#!/usr/bin/env python3
"""
Memory-bounded whisper.cpp transcription + 20 Hz audio RMS energy extractor.
Processes 16kHz mono PCM WAV in silence-aligned chunks so even multi-hour videos
stay well below 250 MB RSS.
"""
import argparse
import json
import os
import re
import sys
import wave
from pathlib import Path

import numpy as np
import _pywhispercpp as pw
from pywhispercpp.model import Model
from pywhispercpp.utils import download_model

SAMPLE_RATE = 16000
HOP_MS = 50  # 20 Hz envelope
HOP_SAMPLES = int(SAMPLE_RATE * HOP_MS / 1000)
TARGET_CHUNK_SEC = 240.0
SPLIT_SEARCH_WINDOW_SEC = 15.0


def compute_audio_energy(wav_path: Path) -> tuple[list[float], float]:
    """Stream WAV in 10-second chunks to compute 50ms RMS energy envelope in O(1) RAM."""
    rms_values: list[float] = []
    with wave.open(str(wav_path), "rb") as wf:
        if wf.getnchannels() != 1 or wf.getsampwidth() != 2 or wf.getframerate() != SAMPLE_RATE:
            raise ValueError(
                f"Expected 16kHz mono 16-bit PCM WAV, got "
                f"ch={wf.getnchannels()} sw={wf.getsampwidth()} sr={wf.getframerate()}"
            )
        total_frames = wf.getnframes()
        duration_sec = total_frames / SAMPLE_RATE

        # Read 10 seconds at a time (320 KB)
        chunk_frames = SAMPLE_RATE * 10
        remainder = np.empty(0, dtype=np.float32)

        while True:
            raw = wf.readframes(chunk_frames)
            if not raw:
                break
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            if remainder.size > 0:
                samples = np.concatenate([remainder, samples])

            usable = (samples.size // HOP_SAMPLES) * HOP_SAMPLES
            if usable > 0:
                frames = samples[:usable].reshape(-1, HOP_SAMPLES)
                rms = np.sqrt(np.mean(frames * frames, axis=1))
                rms_values.extend([round(float(v), 5) for v in rms])
            remainder = samples[usable:]

        if remainder.size > 0:
            rms = float(np.sqrt(np.mean(remainder * remainder)))
            rms_values.append(round(rms, 5))

    return rms_values, duration_sec


def choose_silence_split_points(rms_values: list[float], duration_sec: float) -> list[tuple[float, float]]:
    if duration_sec <= TARGET_CHUNK_SEC + 30.0:
        return [(0.0, duration_sec)]

    splits = [0.0]
    cursor = TARGET_CHUNK_SEC
    step_sec = HOP_MS / 1000.0

    while cursor < duration_sec - 25.0:
        idx_start = max(0, int((cursor - SPLIT_SEARCH_WINDOW_SEC) / step_sec))
        idx_end = min(len(rms_values) - 1, int((cursor + SPLIT_SEARCH_WINDOW_SEC) / step_sec))
        if idx_end > idx_start:
            window = rms_values[idx_start : idx_end + 1]
            min_offset = int(np.argmin(window))
            split_sec = (idx_start + min_offset) * step_sec
        else:
            split_sec = cursor
        if split_sec > splits[-1] + 20.0:
            splits.append(split_sec)
            cursor = split_sec + TARGET_CHUNK_SEC
        else:
            cursor += TARGET_CHUNK_SEC

    splits.append(duration_sec)
    return [(splits[i], splits[i + 1]) for i in range(len(splits) - 1)]


def read_wav_slice(wav_path: Path, start_sec: float, end_sec: float) -> np.ndarray:
    with wave.open(str(wav_path), "rb") as wf:
        total = wf.getnframes()
        start_frame = max(0, min(total, int(start_sec * SAMPLE_RATE)))
        end_frame = max(start_frame, min(total, int(end_sec * SAMPLE_RATE)))
        wf.setpos(start_frame)
        raw = wf.readframes(end_frame - start_frame)
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def decode_text(val) -> str:
    if val is None:
        return ""
    if isinstance(val, (bytes, bytearray)):
        return val.decode("utf-8", errors="replace")
    return str(val)


def extract_words_from_ctx(ctx, seg_idx: int, chunk_offset_sec: float, seg_start: float, seg_end: float) -> list[dict]:
    n_tokens = pw.whisper_full_n_tokens(ctx, seg_idx)
    words: list[dict] = []
    current_word = ""
    word_start = None
    word_end = None
    probs: list[float] = []

    def flush_word():
        nonlocal current_word, word_start, word_end, probs
        cleaned = current_word.strip()
        # Ignore pure whisper special tokens like [_BEG_], [MUSIC], etc.
        if cleaned and not (cleaned.startswith("[_") and cleaned.endswith("]")):
            s = word_start if word_start is not None else seg_start
            e = word_end if word_end is not None else max(s + 0.08, s)
            if e <= s:
                e = min(seg_end, s + 0.08)
            avg_p = float(np.mean(probs)) if probs else 0.75
            words.append({
                "word": cleaned,
                "start": round(max(seg_start, s), 3),
                "end": round(min(max(seg_end, s + 0.05), e), 3),
                "probability": round(avg_p, 3),
            })
        current_word = ""
        word_start = None
        word_end = None
        probs = []

    for tok_idx in range(n_tokens):
        tok_text = decode_text(pw.whisper_full_get_token_text(ctx, seg_idx, tok_idx))
        if not tok_text:
            continue
        # Skip special control tokens
        if re.match(r"^\[_.*\]$", tok_text.strip()):
            continue
        tdata = pw.whisper_full_get_token_data(ctx, seg_idx, tok_idx)
        t0 = chunk_offset_sec + (tdata.t0 * 0.01 if tdata.t0 >= 0 else 0.0)
        t1 = chunk_offset_sec + (tdata.t1 * 0.01 if tdata.t1 >= 0 else 0.0)
        prob = float(getattr(tdata, "p", 0.75))

        # New word starts on leading space or punctuation boundary
        starts_new = tok_text.startswith((" ", "\n", "\t")) or current_word == ""
        if starts_new and current_word:
            flush_word()

        current_word += tok_text
        if word_start is None:
            word_start = t0 if tdata.t0 >= 0 else seg_start
        if tdata.t1 >= 0:
            word_end = max(word_end or t1, t1)
        probs.append(prob)

    if current_word:
        flush_word()

    # Fallback: if token timestamps collapsed, distribute linearly across segment
    if words:
        all_zero = all(abs(w["end"] - w["start"]) < 0.02 for w in words)
        if all_zero and seg_end > seg_start:
            step = (seg_end - seg_start) / len(words)
            for idx, w in enumerate(words):
                w["start"] = round(seg_start + idx * step, 3)
                w["end"] = round(seg_start + (idx + 1) * step, 3)

    return words


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav", required=True)
    parser.add_argument("--out-transcript", required=True)
    parser.add_argument("--out-energy", required=True)
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--model", default="base-q5_1")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--no-translate", action="store_true")
    args = parser.parse_args()

    wav_path = Path(args.wav)
    models_dir = Path(args.models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)

    print(json.dumps({"event": "progress", "percent": 5, "detail": "Computing audio energy envelope"}), flush=True)
    rms_values, duration_sec = compute_audio_energy(wav_path)

    # Adaptive speech energy threshold
    nonzero = [v for v in rms_values if v > 1e-5]
    if nonzero:
        noise_floor = float(np.percentile(nonzero, 20))
        peak_ref = float(np.percentile(nonzero, 90))
        speech_thresh = max(0.008, noise_floor + 0.18 * max(0.01, peak_ref - noise_floor))
    else:
        speech_thresh = 0.01

    energy_payload = {
        "sampleRate": SAMPLE_RATE,
        "hopMs": HOP_MS,
        "durationSec": round(duration_sec, 3),
        "speechThreshold": round(speech_thresh, 5),
        "rms": rms_values,
    }
    Path(args.out_energy).write_text(json.dumps(energy_payload), encoding="utf-8")

    print(json.dumps({"event": "progress", "percent": 15, "detail": f"Loading whisper.cpp ({args.model})"}), flush=True)
    model_path = download_model(args.model, str(models_dir))

    is_english_only = args.model.endswith(".en") or ".en-" in args.model
    lang_param = "en" if is_english_only else ("" if args.language == "auto" else args.language)

    model_kwargs = {
        "models_dir": str(models_dir),
        "n_threads": max(1, args.threads),
        "token_timestamps": True,
        "print_progress": False,
        "print_realtime": False,
        "print_timestamps": False,
        "redirect_whispercpp_logs_to": False,
        "language": lang_param,
        "translate": False,
    }

    model = Model(model_path, **model_kwargs)

    detected_lang = "en" if is_english_only else ("" if args.language == "auto" else args.language)
    use_translate = False
    lang_locked = is_english_only or (args.language != "auto")

    if not is_english_only and args.language == "auto" and len(rms_values) > 0:
        # Detect spoken language once from the highest-energy 25s speech window
        step_sec = HOP_MS / 1000.0
        win_bins = max(1, int(25.0 / step_sec))
        arr_rms = np.array(rms_values, dtype=np.float32)
        if arr_rms.size <= win_bins:
            probe_start = 0.0
        else:
            csum = np.concatenate([[0.0], np.cumsum(arr_rms)])
            sums = csum[win_bins:] - csum[:-win_bins]
            probe_start = float(int(np.argmax(sums)) * step_sec)
        probe_end = min(duration_sec, probe_start + 25.0)
        probe_audio = read_wav_slice(wav_path, probe_start, probe_end)
        if probe_audio.size >= SAMPLE_RATE:
            try:
                (lang_code, lang_prob), _ = model.auto_detect_language(probe_audio)
                if lang_code and float(lang_prob) >= 0.35:
                    detected_lang = str(lang_code)
                    lang_locked = True
                    if detected_lang != "en" and not args.no_translate:
                        use_translate = True
            except Exception:
                pass
        if lang_locked:
            model._set_params({"language": detected_lang, "translate": use_translate})
    elif not is_english_only and detected_lang and detected_lang != "en" and not args.no_translate:
        use_translate = True
        model._set_params({"language": detected_lang, "translate": True})

    chunks = choose_silence_split_points(rms_values, duration_sec)
    all_segments: list[dict] = []
    seg_counter = 0

    for idx, (c_start, c_end) in enumerate(chunks):
        pct = 20 + int((idx / max(1, len(chunks))) * 75)
        print(
            json.dumps({
                "event": "progress",
                "percent": pct,
                "detail": f"Transcribing chunk {idx + 1}/{len(chunks)} ({c_start:.1f}s - {c_end:.1f}s, lang={detected_lang or 'auto'})",
            }),
            flush=True,
        )
        audio_chunk = read_wav_slice(wav_path, c_start, c_end)
        if audio_chunk.size < 800:
            continue

        model.transcribe(audio_chunk, extract_probability=True)
        if not lang_locked:
            try:
                lid = pw.whisper_full_lang_id(model._ctx)
                lstr = decode_text(pw.whisper_lang_str(lid)).strip()
                if lstr:
                    detected_lang = lstr
                    lang_locked = True
            except Exception:
                pass
        n_segs = pw.whisper_full_n_segments(model._ctx)
        for s_idx in range(n_segs):
            raw_text = decode_text(pw.whisper_full_get_segment_text(model._ctx, s_idx)).strip()
            if not raw_text:
                continue
            t0_cs = pw.whisper_full_get_segment_t0(model._ctx, s_idx)
            t1_cs = pw.whisper_full_get_segment_t1(model._ctx, s_idx)
            seg_start = round(c_start + max(0.0, t0_cs * 0.01), 3)
            seg_end = round(min(duration_sec, c_start + max(t0_cs * 0.01 + 0.05, t1_cs * 0.01)), 3)
            speaker_turn = bool(pw.whisper_full_get_segment_speaker_turn_next(model._ctx, s_idx))

            words = extract_words_from_ctx(model._ctx, s_idx, c_start, seg_start, seg_end)
            if not words:
                # Token fallback split on whitespace
                tokens = raw_text.split()
                if tokens:
                    step = max(0.05, (seg_end - seg_start) / len(tokens))
                    words = [
                        {
                            "word": tok,
                            "start": round(seg_start + w_i * step, 3),
                            "end": round(seg_start + (w_i + 1) * step, 3),
                            "probability": 0.7,
                        }
                        for w_i, tok in enumerate(tokens)
                    ]

            mean_prob = float(np.mean([w["probability"] for w in words])) if words else 0.7
            all_segments.append({
                "id": seg_counter,
                "start": seg_start,
                "end": seg_end,
                "text": raw_text,
                "speakerTurn": speaker_turn,
                "probability": round(mean_prob, 3),
                "words": words,
            })
            seg_counter += 1

    transcript_payload = {
        "language": detected_lang or "en",
        "durationSec": round(duration_sec, 3),
        "model": args.model,
        "segments": all_segments,
    }
    Path(args.out_transcript).write_text(json.dumps(transcript_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"event": "progress", "percent": 100, "detail": f"Transcribed {len(all_segments)} segments"}), flush=True)


if __name__ == "__main__":
    main()
