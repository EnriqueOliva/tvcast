import json
import sys

from faster_whisper import WhisperModel

TRANSCRIBE_OPTIONS = {
    "language": "en",
    "vad_filter": True,
    "vad_parameters": {"min_silence_duration_ms": 300},
    "condition_on_previous_text": False,
}


def collect(model, audio_path, offset_seconds):
    segments, _ = model.transcribe(audio_path, **TRANSCRIBE_OPTIONS)
    return [
        {
            "start": round(segment.start + offset_seconds, 3),
            "end": round(segment.end + offset_seconds, 3),
            "text": segment.text.strip(),
        }
        for segment in segments
    ]


def main():
    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base.en"
    offset_seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0

    try:
        model = WhisperModel(model_size, device="cuda", compute_type="float16")
        output = collect(model, audio_path, offset_seconds)
        device_used = "cuda"
    except Exception:
        model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=8)
        output = collect(model, audio_path, offset_seconds)
        device_used = "cpu"

    sys.stderr.write("transcribed on " + device_used + "\n")
    json.dump(output, sys.stdout)


if __name__ == "__main__":
    main()
