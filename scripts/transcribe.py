# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "miniaudio>=1.61",
#     "numpy>=2.0",
#     "pywhispercpp>=1.5",
# ]
# ///
"""Transcribe speech offline with Whisper: the audio file on stdin, the text on stdout.

    uv run --script scripts/transcribe.py small.en < episode.mp3

The indexer calls it for podcast episodes without a transcript when WHISPER_MODEL is set
(Documentation/sources/podcasts.md). The audio and the text stay in memory. The model is a
name from whisper.cpp such as `base.en` or `small.en`, or a model file; the first run
downloads a named model to the user's data directory. Reads MP3, FLAC, WAV and Ogg Vorbis;
exit code 2 for anything else.
"""

import os
import sys

import miniaudio
import numpy as np
from pywhispercpp.constants import AVAILABLE_MODELS
from pywhispercpp.model import Model

SAMPLE_RATE = 16_000
"""What Whisper reads: mono, 16 kHz."""


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: transcribe.py <model> < audio", file=sys.stderr)
        return 1
    name = sys.argv[1]
    if name not in AVAILABLE_MODELS and not os.path.isfile(name):
        # whisper.cpp crashes on an unknown name.
        print(f"no Whisper model `{name}`: try small.en or base.en", file=sys.stderr)
        return 1
    try:
        decoded = miniaudio.decode(
            sys.stdin.buffer.read(),
            output_format=miniaudio.SampleFormat.FLOAT32,
            nchannels=1,
            sample_rate=SAMPLE_RATE,
        )
    except miniaudio.DecodeError as error:
        print(f"not MP3, FLAC, WAV or Ogg Vorbis: {error}", file=sys.stderr)
        return 2
    samples = np.frombuffer(decoded.samples, dtype=np.float32)
    model = Model(
        name,
        # The `.en` models know English only; the others find the language spoken, so that
        # the indexer can tell a text that is not English.
        language="en" if ".en" in name else "auto",
        print_progress=False,
        print_realtime=False,
        redirect_whispercpp_logs_to=None,
    )
    for segment in model.transcribe(samples):
        print(segment.text.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
