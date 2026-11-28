import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** What ends a transcription early. */
interface TranscribeLimits {
  /** Milliseconds a run may take; an hour if left out. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Speech-to-text: the words spoken in an audio file, empty if the file is not readable audio. */
export type Transcribe = (
  audio: Uint8Array,
  limits?: TranscribeLimits,
) => Promise<string>;

export interface TranscriberOptions {
  /** Threads of one run; left out, Whisper takes 4, or every core of a smaller machine. */
  threads?: number;
  /** The command that gets the model and the threads as arguments, the audio on its stdin. */
  command?: readonly string[];
}

const SCRIPT = fileURLToPath(
  new URL("../../../scripts/transcribe.py", import.meta.url),
);
// An hour of audio takes about a minute with a small model on a laptop; this stops a hung run.
const TIMEOUT_MS = 3_600_000;
/** The script's exit code for a file it cannot decode. */
const UNREADABLE = 2;

/**
 * Speech-to-text with a local Whisper model, e.g. `small.en`: the audio goes to the stdin of
 * scripts/transcribe.py, the text comes back on its stdout, and nothing is stored. uv installs
 * the script's dependencies on the first call.
 */
export function createTranscriber(
  model: string,
  {
    threads,
    command = ["uv", "run", "--quiet", "--locked", "--script", SCRIPT],
  }: TranscriberOptions = {},
): Transcribe {
  const [program = "", ...args] = command;
  const settings = threads === undefined ? [model] : [model, String(threads)];
  return (audio, { timeoutMs = TIMEOUT_MS, signal } = {}) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(program, [...args, ...settings], {
        timeout: timeoutMs,
        signal,
      });
      const text: Buffer[] = [];
      let errors = "";
      child.stdout.on("data", (chunk: Buffer) => text.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-2_000);
      });
      child.on("error", (error) =>
        reject(
          new Error(
            error.name === "AbortError"
              ? "speech-to-text was stopped"
              : `speech-to-text did not start: ${error.message}`,
          ),
        ),
      );
      child.on("close", (code, killedBy) => {
        if (code === 0) return resolve(Buffer.concat(text).toString());
        if (code === UNREADABLE) return resolve("");
        const reason = !killedBy
          ? errors.trim().split("\n").at(-1) || `exit code ${code}`
          : Date.now() - started >= timeoutMs
            ? `took longer than ${Math.round(timeoutMs / 60_000)} min`
            : `stopped by ${killedBy}`;
        reject(new Error(`speech-to-text failed: ${reason.slice(0, 300)}`));
      });
      // A script that ends early closes its stdin; `close` reports why.
      child.stdin.on("error", () => {});
      child.stdin.end(audio);
    });
}

/**
 * A second of silence as a WAV file. Transcribing it once shows that speech-to-text runs, and
 * makes the first call install the script's packages and download the model.
 */
export function silence(): Uint8Array {
  const rate = 16_000;
  const bytes = rate * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + bytes, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write("data", 36);
  wav.writeUInt32LE(bytes, 40);
  return new Uint8Array(wav);
}
