import { describe, expect, test } from "bun:test";
import { counterSchema, jobClaimSchema, timestampSchema, uuidSchema } from "../../src/contracts";
import { OpenAITextExtractor, parseExtractionOutput, retryAfterSeconds, type ResponseRequest } from "../../src/reconciliation/extractor";
import { resolveDue } from "../../src/reconciliation/time";
import { validateProposals } from "../../src/reconciliation/validate";
import type { ClaimedExtraction, ProposedChange } from "../../src/reconciliation/types";

const userId = uuidSchema.parse("00000000-0000-4000-8000-000000000001");
const sessionId = uuidSchema.parse("00000000-0000-4000-8000-000000000011");
const itemId = uuidSchema.parse("00000000-0000-4000-8000-000000000021");
const partId = uuidSchema.parse("00000000-0000-4000-8000-000000000031");
const jobId = uuidSchema.parse("00000000-0000-4000-8000-000000000041");

function fixture(text: string, anchor: string | null = "2026-10-15T05:00:00.000Z"): ClaimedExtraction {
  return {
    claim: jobClaimSchema.parse({ userId, sessionId, jobId, claimToken: uuidSchema.parse(crypto.randomUUID()), baseMindRevision: counterSchema.parse("0"), fromOrdinal: 1, throughOrdinal: 1, inputHash: "a".repeat(64) }),
    attempt: 1, model: "test-model", promptVersion: "v1", schemaVersion: "1", sessionTimezone: "Asia/Kolkata", sessionStartedAt: "2026-10-15T04:00:00.000Z",
    earlierParts: [], newParts: [{ partId, itemId, ordinal: 1, contentIndex: 0, text, timeAnchorAt: anchor }],
    mind: { revision: counterSchema.parse("0"), memories: [], commitments: [] }, validationFeedback: null,
  };
}

function proposal(text: string): ProposedChange {
  return { entity: "commitment", action: "create", target_id: null, expected_version: null, memory: null,
    commitment: { title: "Send presentation", subject: "Ananya", status: "open", priority: 2, due_text: text,
      due_precision: "date", temporal_kind: "local_date", offset_datetime: null, local_date: "2026-10-15", local_time: null, timezone: null, relative_seconds: null },
    sources: [{ part_id: partId, evidence_text: `I promised to send Ananya the presentation ${text}` }] };
}

describe("Responses adapter", () => {
  test("sends strict stateless request and parses REST output items", async () => {
    let body: Record<string, unknown> | null = null;
    const request: ResponseRequest = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"schema_version":"1","changes":[]}' }] }] });
    };
    const result = await new OpenAITextExtractor("fake", request).extract(fixture("Hello"), new AbortController().signal);
    expect(result).toEqual({ kind: "success", proposals: [] });
    expect(body).toMatchObject({ store: false, max_output_tokens: 4000, tools: [], tool_choice: "none", text: { format: { type: "json_schema", strict: true } } });
  });
  test("distinguishes refusal, incomplete, malformed output, and quota", async () => {
    const input = fixture("Hello");
    const refuse: ResponseRequest = async () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] });
    expect(await new OpenAITextExtractor("fake", refuse).extract(input, new AbortController().signal)).toEqual({ kind: "refusal" });
    const incomplete: ResponseRequest = async () => Response.json({ status: "incomplete", output: [] });
    expect(await new OpenAITextExtractor("fake", incomplete).extract(input, new AbortController().signal)).toEqual({ kind: "incomplete" });
    expect(parseExtractionOutput("not json")).toEqual({ kind: "invalid_output", code: "invalid_json" });
    const quota: ResponseRequest = async () => Response.json({ error: { code: "insufficient_quota" } }, { status: 429 });
    await expect(new OpenAITextExtractor("fake", quota).extract(input, new AbortController().signal)).rejects.toMatchObject({ failure: { code: "model_quota", policy: "block" } });
  });
  test("parses bounded Retry-After values", () => {
    expect(retryAfterSeconds("15")).toBe(15);
    expect(retryAfterSeconds("9999")).toBe(300);
    expect(retryAfterSeconds("nonsense")).toBeUndefined();
  });
  test("classifies retryable provider status and permanent configuration status", async () => {
    const input = fixture("Hello");
    const rate: ResponseRequest = async () => Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429, headers: { "retry-after": "120" } });
    await expect(new OpenAITextExtractor("fake", rate).extract(input, new AbortController().signal)).rejects.toMatchObject({ failure: { policy: "retry", retryAfterSeconds: 120 } });
    const overloaded: ResponseRequest = async () => Response.json({ error: { code: "server_error" } }, { status: 503 });
    await expect(new OpenAITextExtractor("fake", overloaded).extract(input, new AbortController().signal)).rejects.toMatchObject({ failure: { code: "model_http_503", policy: "retry" } });
    const unauthorized: ResponseRequest = async () => Response.json({ error: { code: "invalid_api_key" } }, { status: 401 });
    await expect(new OpenAITextExtractor("fake", unauthorized).extract(input, new AbortController().signal)).rejects.toMatchObject({ failure: { code: "model_http_401", policy: "block" } });
  });
});

describe("validation and due-time resolution", () => {
  test("resolves before Friday to the preceding local 09:00 with evidence", () => {
    const text = "I promised to send Ananya the presentation before Friday";
    const changes = validateProposals(fixture(text), [proposal("before Friday")]);
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]?.value).toMatchObject({ dueAt: "2026-10-15T03:30:00.000Z", duePrecision: "date", priority: 2 });
  });
  test("rejects unsupported high priority and invented evidence", () => {
    const text = "I promised to send Ananya the presentation before Friday";
    const high = proposal("before Friday");
    const commitment = high.commitment;
    if (commitment === null) throw new Error("Fixture error");
    expect(() => validateProposals(fixture(text), [{ ...high, commitment: { ...commitment, priority: 1 } }])).toThrow();
    expect(() => validateProposals(fixture(text), [{ ...high, sources: [{ part_id: partId, evidence_text: "invented words" }] }])).toThrow();
  });
  test("does not schedule unsupported, ambiguous, or DST-gap times", () => {
    const base = proposal("before Friday");
    if (!base.commitment) throw new Error("Fixture error");
    const unsupported = resolveDue({ ...base.commitment, temporal_kind: "local_date", local_date: "2026-10-16" }, "Asia/Kolkata", fixture("before Friday").newParts[0]!);
    expect(unsupported.duePrecision).toBe("unresolved");
    const ambiguous = resolveDue({ ...base.commitment, temporal_kind: "local_datetime", due_text: "tomorrow at 9", local_date: "2026-10-16", local_time: "09:00" }, "Asia/Kolkata", fixture("tomorrow at 9").newParts[0]!);
    expect(ambiguous.dueAt).toBeNull();
    const dst = resolveDue({ ...base.commitment, temporal_kind: "local_datetime", due_text: "2026-03-08 02:30", local_date: "2026-03-08", local_time: "02:30", timezone: "America/New_York" }, "America/New_York", fixture("2026-03-08 02:30").newParts[0]!);
    expect(dst.duePrecision).toBe("unresolved");
  });
  test("uses frozen anchor for relative time and rejects a changed duration", () => {
    const input = fixture("I will call in 10 minutes", "2026-10-15T05:00:00.000Z");
    const base = proposal("before Friday").commitment;
    if (!base) throw new Error("Fixture error");
    const relative = { ...base, due_text: "in 10 minutes", due_precision: "instant" as const, temporal_kind: "relative" as const,
      local_date: null, relative_seconds: 600 };
    expect(resolveDue(relative, input.sessionTimezone, input.newParts[0]!).dueAt).toBe(timestampSchema.parse("2026-10-15T05:10:00.000Z"));
    expect(resolveDue({ ...relative, relative_seconds: 900 }, input.sessionTimezone, input.newParts[0]!).duePrecision).toBe("unresolved");
  });
  test("keeps two distinct episodic events about the same subject", () => {
    const text = "I met Ananya on Monday and discussed the project with Ananya on Tuesday";
    const event = (content: string, timeText: string): ProposedChange => ({
      entity: "memory", action: "create", target_id: null, expected_version: null, commitment: null,
      memory: { kind: "episodic", subject: "Ananya", predicate: "interaction", content, occurred_at: null, time_text: timeText },
      sources: [{ part_id: partId, evidence_text: text }],
    });
    const changes = validateProposals(fixture(text), [event("Met Ananya", "Monday"), event("Discussed the project with Ananya", "Tuesday")]);
    expect(changes.changes).toHaveLength(2);
  });
});
