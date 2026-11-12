import { expect, test } from "vitest";
import { createTranscriber } from "./transcribe.ts";

/** A transcriber that runs this Node script in place of the Whisper script; the model is its argument. */
function scripted(script: string) {
  return createTranscriber("small.en", [process.execPath, "-e", script]);
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
  const transcribe = createTranscriber("small.en", ["no-such-command-on-path"]);

  await expect(transcribe(audio)).rejects.toThrow(
    /^speech-to-text did not start: /,
  );
});
