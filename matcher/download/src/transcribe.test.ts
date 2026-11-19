import { expect, test } from "vitest";
import { createTranscriber, silence } from "./transcribe.ts";

/** A transcriber that runs this Node script in place of the Whisper script; the model is its argument. */
function scripted(script: string, threads?: number) {
  const command = [process.execPath, "-e", script];
  return createTranscriber("small.en", { command, threads });
}

const audio = new TextEncoder().encode("mp3 bytes");

test("sends the audio to the script and returns what it prints", async () => {
  const transcribe = scripted(
    `process.stdin.on("data", (chunk) =>
       process.stdout.write(process.argv[1] + " heard " + chunk))`,
  );

  await expect(transcribe(audio)).resolves.toBe("small.en heard mp3 bytes");
});

test("reads no text from a file the script cannot decode", async () => {
  await expect(scripted("process.exit(2)")(audio)).resolves.toBe("");
});

test("fails with the last line the script wrote when it fails", async () => {
  const transcribe = scripted(
    `console.error("Downloading the model"); console.error("no such model");
     process.exit(1)`,
  );

  await expect(transcribe(audio)).rejects.toThrow(
    "speech-to-text failed: no such model",
  );
});

test("fails when the command is not installed", async () => {
  const transcribe = createTranscriber("small.en", {
    command: ["no-such-command-on-path"],
  });

  await expect(transcribe(audio)).rejects.toThrow(
    /^speech-to-text did not start: /,
  );
});

test("passes the number of threads after the model", async () => {
  const transcribe = scripted(
    "process.stdout.write(process.argv.slice(1).join(' '))",
    4,
  );

  await expect(transcribe(audio)).resolves.toBe("small.en 4");
});

test("ends a run that takes longer than its time limit", async () => {
  const transcribe = scripted("setTimeout(() => {}, 60_000)");

  await expect(transcribe(audio, { timeoutMs: 50 })).rejects.toThrow(
    "speech-to-text failed: took longer than 0 min",
  );
});

test("ends a run when it is stopped", async () => {
  const transcribe = scripted("setTimeout(() => {}, 60_000)");
  const stop = new AbortController();
  const run = transcribe(audio, { signal: stop.signal });

  stop.abort();

  await expect(run).rejects.toThrow("speech-to-text was stopped");
});

test("builds a second of silence as a WAV file", () => {
  const wav = Buffer.from(silence());

  expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
  expect(wav.readUInt32LE(24)).toBe(16_000);
  expect(wav).toHaveLength(44 + 32_000);
});
