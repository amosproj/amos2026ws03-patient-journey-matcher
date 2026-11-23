import { createHash } from "node:crypto";
import type { JourneyEvent, JourneyState } from "@matcher/core";

export const models = {
  qwen: {
    repository: "Qwen/Qwen3-Embedding-0.6B",
    revision: "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
    pooling: "last-token",
  },
  bge: {
    repository: "BAAI/bge-m3",
    revision: "5617a9f61b028005a4858fdac845db406aefb181",
    pooling: "cls",
  },
} as const;
export type Model = keyof typeof models;
export const settings = {
  template: 1,
  maxTokens: 512,
  dimensions: 1024,
  attention: "sdpa",
};
export const instruction =
  "Given a patient's current medical situation and history, retrieve resources relevant to the current situation.";
/** The start of a text that is sent: several times what the encoder reads of it (`maxTokens`). */
const MAX_CHARACTERS = 20_000;

export function parseModel(value: string): Model {
  if (value === "qwen" || value === "bge") return value;
  throw new Error("SEMANTIC_MODEL must be qwen or bge");
}

export function configuration(model: Model) {
  const device = process.env.SEMANTIC_DEVICE || "cpu";
  if (!["cpu", "mps"].includes(device))
    throw new Error("SEMANTIC_DEVICE must be cpu or mps");
  return { model, ...models[model], ...settings, instruction, device };
}

export function indexTable(model: Model): string {
  // One index for every device: the device changes a vector only by rounding. Hashed as "cpu",
  // so the tables keep the names they got on the default device.
  const hash = createHash("sha256")
    .update(JSON.stringify({ ...configuration(model), device: "cpu" }))
    .digest("hex")
    .slice(0, 16);
  return `ai_summary.${model}_${hash}`;
}

function eventText(event: JourneyEvent): string {
  const parameters = Object.entries(event.parameters ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}: ${JSON.stringify(value)}`);
  return [event.date, event.type, event.label, ...parameters].join("\n");
}

export function queryText(state: JourneyState): string {
  return [
    "Current situation",
    eventText(state.focus),
    "Medical history (newest first)",
    ...state.context
      .toSorted((a, b) => b.date.localeCompare(a.date))
      .map(eventText),
  ].join("\n");
}

export interface Encoder {
  encode(
    model: Model,
    mode: "query" | "document",
    texts: string[],
  ): Promise<number[][]>;
}

export function createEncoder(
  url = process.env.SEMANTIC_URL || "http://127.0.0.1:8766",
): Encoder {
  const endpoint = new URL("/encode", url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("SEMANTIC_URL must use a loopback host");
  }
  return {
    async encode(model, mode, texts) {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...configuration(model),
          mode,
          // The worker refuses a longer text, and one with half a character pair after the cut.
          texts: texts.map((text) =>
            text.slice(0, MAX_CHARACTERS).toWellFormed(),
          ),
        }),
        signal: AbortSignal.timeout(mode === "document" ? 180_000 : 45_000),
      });
      if (!response.ok) throw new Error("Semantic encoder unavailable");
      const data = (await response.json()) as { vectors?: unknown };
      if (
        !Array.isArray(data.vectors) ||
        data.vectors.length !== texts.length
      ) {
        throw new Error("Invalid embedding count");
      }
      return data.vectors.map((vector: unknown) => {
        if (
          !Array.isArray(vector) ||
          vector.length !== settings.dimensions ||
          !vector.every(
            (value) => typeof value === "number" && Number.isFinite(value),
          ) ||
          Math.abs(Math.hypot(...vector) - 1) > 0.01
        ) {
          throw new Error("Invalid embedding vector");
        }
        return vector as number[];
      });
    },
  };
}
