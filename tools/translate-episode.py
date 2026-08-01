import os
import sys

from faster_whisper import WhisperModel

TRANSLATE_OPTIONS = {
    "task": "translate",
    "vad_filter": False,
    "condition_on_previous_text": False,
    "beam_size": 5,
    "no_speech_threshold": 0.6,
    "word_timestamps": True,
}

MAXIMUM_CUE_SECONDS = 7.0
MINIMUM_CUE_SECONDS = 0.5
MILLISECONDS_PER_SECOND = 1000
SECONDS_PER_MINUTE = 60
SECONDS_PER_HOUR = 3600


def format_timestamp(total_seconds):
    milliseconds = int(round(total_seconds * MILLISECONDS_PER_SECOND))
    hours = milliseconds // (SECONDS_PER_HOUR * MILLISECONDS_PER_SECOND)
    milliseconds -= hours * SECONDS_PER_HOUR * MILLISECONDS_PER_SECOND
    minutes = milliseconds // (SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND)
    milliseconds -= minutes * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND
    seconds = milliseconds // MILLISECONDS_PER_SECOND
    milliseconds -= seconds * MILLISECONDS_PER_SECOND
    return "%02d:%02d:%02d,%03d" % (hours, minutes, seconds, milliseconds)


def main():
    audio_path = sys.argv[1]
    output_path = sys.argv[2]
    source_language = sys.argv[3] if len(sys.argv) > 3 else "tr"
    model_size = sys.argv[4] if len(sys.argv) > 4 else "large-v3"

    try:
        model = WhisperModel(model_size, device="cuda", compute_type="float16")
        device_used = "cuda"
    except Exception:
        model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=8)
        device_used = "cpu"

    segments, _ = model.transcribe(audio_path, language=source_language, **TRANSLATE_OPTIONS)

    written = 0
    with open(output_path, "w", encoding="utf-8") as handle:
        for segment in segments:
            text = segment.text.strip()
            if text == "":
                continue
            start = segment.words[0].start if segment.words else segment.start
            spoken_end = segment.words[-1].end if segment.words else segment.end
            end = min(spoken_end, start + MAXIMUM_CUE_SECONDS)
            if end - start < MINIMUM_CUE_SECONDS:
                end = start + MINIMUM_CUE_SECONDS
            written += 1
            handle.write("%d\n" % written)
            handle.write("%s --> %s\n" % (format_timestamp(start), format_timestamp(end)))
            handle.write("%s\n\n" % text)
            handle.flush()

    sys.stderr.write("translated %d cues on %s\n" % (written, device_used))
    sys.stderr.flush()
    sys.stdout.flush()
    os._exit(0 if written > 0 else 1)


if __name__ == "__main__":
    main()
