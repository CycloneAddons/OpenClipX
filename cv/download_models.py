#!/usr/bin/env python3
"""Ensure required lightweight local models exist in MODELS_DIR."""
import argparse
import os
import sys
import urllib.request
from pathlib import Path

from pywhispercpp.utils import download_model

YUNET_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/models/"
    "face_detection_yunet/face_detection_yunet_2023mar.onnx"
)
FACE_LANDMARKER_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)


def download_file_if_missing(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 1024:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"Downloading {dest.name}...", file=sys.stderr, flush=True)
    urllib.request.urlretrieve(url, tmp)
    tmp.replace(dest)


def ensure_models(models_dir: Path, whisper_model: str) -> dict:
    models_dir.mkdir(parents=True, exist_ok=True)
    yunet_path = models_dir / "face_detection_yunet_2023mar.onnx"
    landmarker_path = models_dir / "face_landmarker.task"

    download_file_if_missing(YUNET_URL, yunet_path)
    download_file_if_missing(FACE_LANDMARKER_URL, landmarker_path)

    whisper_path = download_model(whisper_model, str(models_dir))
    return {
        "yunet": str(yunet_path),
        "face_landmarker": str(landmarker_path),
        "whisper": str(whisper_path),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--whisper-model", default="base-q5_1")
    args = parser.parse_args()
    res = ensure_models(Path(args.models_dir), args.whisper_model)
    print(res)

