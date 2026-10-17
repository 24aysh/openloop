import { z } from "zod";
import { uuidSchema } from "../contracts";
import { EXTRACTION_INSTRUCTIONS, LEGACY_EXTRACTION_INSTRUCTIONS, EXTRACTION_JSON_SCHEMA, extractionContext, PROMPT_VERSION, SCHEMA_VERSION } from "./prompt";
import { ExtractionError, type ClaimedExtraction, type ExtractionOutcome, type TextExtractor } from "./types";

const sourceSchema = z.strictObject({ part_id: uuidSchema, evidence_text: z.string().min(1).max(4000) });
const memorySchema = z.strictObject({
  kind: z.enum(["semantic", "episodic"]), subject: z.string().trim().min(1).max(200), predicate: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(4000), occurred_at: z.string().nullable(), time_text: z.string().nullable(),
});
const commitmentSchema = z.strictObject({
  title: z.string().trim().min(1).max(500), subject: z.string().trim().min(1).max(200).nullable(),
  status: z.enum(["open", "completed", "dismissed"]), priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  due_text: z.string().trim().min(1).max(500).nullable(), due_precision: z.enum(["instant", "date", "unresolved", "none"]),
  temporal_kind: z.enum(["none", "unresolved", "offset", "local_datetime", "local_date", "relative"]),
  offset_datetime: z.string().nullable(), local_date: z.string().nullable(), local_time: z.string().nullable(),
  timezone: z.string().nullable(), relative_seconds: z.number().int().positive().nullable(),
});
const targetFields = {
  target_id: uuidSchema.nullable(), expected_version: z.string().regex(/^[1-9][0-9]*$/).nullable(),
  sources: z.array(sourceSchema).min(1),
};
const responseSchema = z.strictObject({
  schema_version: z.literal("1"),
  changes: z.array(z.union([
    z.strictObject({ entity: z.literal("memory"), action: z.enum(["create", "update"]), ...targetFields,
      memory: memorySchema, commitment: z.null() }),
    z.strictObject({ entity: z.literal("memory"), action: z.literal("delete"), ...targetFields,
      memory: z.null(), commitment: z.null() }),
    z.strictObject({ entity: z.literal("commitment"), action: z.enum(["create", "update", "complete", "dismiss", "reopen"]),
      ...targetFields, memory: z.null(), commitment: commitmentSchema }),
  ])).max(50),
});

export function parseExtractionOutput(text: string): ExtractionOutcome {
  try {
    const parsed = responseSchema.safeParse(JSON.parse(text));
    return parsed.success ? { kind: "success", proposals: parsed.data.changes } : { kind: "invalid_output", code: "invalid_schema" };
  } catch {
    return { kind: "invalid_output", code: "invalid_json" };
  }
}

export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) : undefined;
}

function providerCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const error = body.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" && /^[a-z_]{1,60}$/.test(error.code) ? error.code : null;
}

export type ResponseRequest = (url: string, init: RequestInit) => Promise<Response>;

export class OpenAITextExtractor implements TextExtractor {
  constructor(private readonly apiKey: string, private readonly request: ResponseRequest = fetch) {}

  async extract(input: ClaimedExtraction, signal: AbortSignal): Promise<ExtractionOutcome> {
    if (![PROMPT_VERSION,"v1"].includes(input.promptVersion) || input.schemaVersion !== SCHEMA_VERSION) throw new ExtractionError({ code: "unsupported_version", policy: "block" });
    const timeout = AbortSignal.timeout(45_000);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.request("https://api.openai.com/v1/responses", {
        method: "POST", signal: combined,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: input.model, store: false, max_output_tokens: 4000, tools: [], tool_choice: "none",
          input: [
            { role: "developer", content: input.promptVersion === "v1" ? LEGACY_EXTRACTION_INSTRUCTIONS : EXTRACTION_INSTRUCTIONS },
            { role: "user", content: extractionContext(input) },
          ],
          text: { format: { type: "json_schema", name: "mind_changes_v1", strict: true, schema: EXTRACTION_JSON_SCHEMA } },
        }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ExtractionError({ code: timeout.aborted ? "model_timeout" : "model_network", policy: "retry" });
    }
    let raw: string;
    try { raw = await response.text(); }
    catch (error) {
      if (signal.aborted) throw error;
      throw new ExtractionError({ code: timeout.aborted ? "model_timeout" : "model_network", policy: "retry" });
    }
    if (Buffer.byteLength(raw, "utf8") > 1_048_576) return { kind: "invalid_output", code: "output_too_large" };
    let body: unknown;
    try { body = JSON.parse(raw); } catch { body = null; }
    if (!response.ok) {
      const code = providerCode(body);
      if (response.status === 429 && code === "insufficient_quota") throw new ExtractionError({ code: "model_quota", policy: "block" });
      if (response.status === 429 || response.status >= 500) throw new ExtractionError({ code: `model_http_${response.status}`, policy: "retry", retryAfterSeconds: retryAfterSeconds(response.headers.get("retry-after")) });
      throw new ExtractionError({ code: `model_http_${response.status}`, policy: "block" });
    }
    if (typeof body !== "object" || body === null || !("status" in body) || !("output" in body) || !Array.isArray(body.output)) return { kind: "invalid_output", code: "invalid_response" };
    if (body.status === "incomplete") return { kind: "incomplete" };
    if (body.status !== "completed") return { kind: "invalid_output", code: "invalid_response_status" };
    const texts: string[] = [];
    for (const item of body.output) {
      if (typeof item !== "object" || item === null || !("type" in item)) continue;
      if (item.type !== "message" || !("content" in item) || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (typeof content !== "object" || content === null || !("type" in content)) continue;
        if (content.type === "refusal") return { kind: "refusal" };
        if (content.type === "output_text" && "text" in content && typeof content.text === "string") texts.push(content.text);
      }
    }
    return texts.length === 1 ? parseExtractionOutput(texts[0] ?? "") : { kind: "invalid_output", code: "missing_output_text" };
  }
}
