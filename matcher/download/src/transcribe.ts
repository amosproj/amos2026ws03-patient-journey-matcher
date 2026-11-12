import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Speech-to-text: the words spoken in an audio file, empty if the file is not readable audio. */
export type Transcribe = (audio: Uint8Array) => Promise<string>;

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
  command: readonly string[] = [
    "uv",
    "run",
    "--quiet",
    "--locked",
    "--script",
    SCRIPT,
  ],
): Transcribe {
  const [program = "", ...args] = command;
  return (audio) =>
    new Promise((resolve, reject) => {
      const child = spawn(program, [...args, model], { timeout: TIMEOUT_MS });
      const text: Buffer[] = [];
      let errors = "";
      child.stdout.on("data", (chunk: Buffer) => text.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-2_000);
      });
      child.on("error", (error) =>
        reject(new Error(`speech-to-text did not start: ${error.message}`)),
      );
      child.on("close", (code, signal) => {
        if (code === 0) return resolve(Buffer.concat(text).toString());
        if (code === UNREADABLE) return resolve("");
        const reason = signal
          ? `stopped by ${signal}`
          : errors.trim().split("\n").at(-1) || `exit code ${code}`;
        reject(new Error(`speech-to-text failed: ${reason.slice(0, 300)}`));
      });
      // A script that ends early closes its stdin; `close` reports why.
      child.stdin.on("error", () => {});
      child.stdin.end(audio);
    });
}
