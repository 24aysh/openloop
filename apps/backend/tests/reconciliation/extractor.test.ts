import { describe, expect, test } from "bun:test";
import { commitmentSchema, counterSchema, jobClaimSchema, timestampSchema, timezoneSchema, uuidSchema } from "../../src/contracts";
import { OpenAITextExtractor, parseExtractionOutput, retryAfterSeconds, type ResponseRequest } from "../../src/reconciliation/extractor";
import { resolveDue } from "../../src/reconciliation/time";
import { validateProposals } from "../../src/reconciliation/validate";
import type { ClaimedExtraction, ProposedChange } from "../../src/reconciliation/types";
import { EXTRACTION_INSTRUCTIONS } from "../../src/reconciliation/prompt";

const userId = uuidSchema.parse("00000000-0000-4000-8000-000000000001");
const sessionId = uuidSchema.parse("00000000-0000-4000-8000-000000000011");
const itemId = uuidSchema.parse("00000000-0000-4000-8000-000000000021");
const partId = uuidSchema.parse("00000000-0000-4000-8000-000000000031");
const secondItemId = uuidSchema.parse("00000000-0000-4000-8000-000000000022");
const secondPartId = uuidSchema.parse("00000000-0000-4000-8000-000000000032");
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
  test("v2 prompt explicitly recognizes reminders, future meetings, and existing-task references",async()=>{
    let instructions="";
    const request:ResponseRequest=async(_url,init)=>{
      const body=JSON.parse(String(init.body)) as {input:{content:string}[]};
      instructions=body.input[0]?.content??"";
      return Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:'{"schema_version":"1","changes":[]}'}]}]});
    };
    await new OpenAITextExtractor("fake",request).extract({...fixture("Remind me to call Ananya"),promptVersion:"v2"},new AbortController().signal);
    expect(instructions).toBe(EXTRACTION_INSTRUCTIONS);
    expect(instructions).toContain("Remind me to send the slides tomorrow");
    expect(instructions).toContain("I have a meeting tomorrow");
    expect(instructions).toContain("Episodic memories are past events only");
    expect(instructions).toContain("different future occurrence");
    expect(instructions).toContain("Transcript extraction never deletes a commitment");
    expect(instructions).toContain("manual");
  });
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
  test("rejects illegal entity, action, and value combinations at the response boundary", () => {
    const invalid = JSON.stringify({ schema_version: "1", changes: [{
      entity: "commitment", action: "delete", target_id: null, expected_version: null,
      memory: null, commitment: null, sources: [{ part_id: partId, evidence_text: "Delete the meeting" }],
    }] });
    expect(parseExtractionOutput(invalid)).toEqual({ kind: "invalid_output", code: "invalid_schema" });
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
  const existing=(manualOverride=false)=>commitmentSchema.parse({
    id:uuidSchema.parse("00000000-0000-4000-8000-000000000081"),userId,title:"Send Ananya the presentation",subject:"Ananya",
    status:"open",priority:2,dueAt:"2026-10-17T03:10:00.000Z",dueTimezone:"Asia/Kolkata",dueText:"tomorrow at 8:40 a.m.",duePrecision:"instant",
    version:"2",scheduleVersion:"1",manualOverride,createdAt:"2026-10-15T04:00:00.000Z",updatedAt:"2026-10-15T04:00:00.000Z",
    completedAt:null,dismissedAt:null,
  });
  test("extracts a direct reminder request as a source-backed commitment",()=>{
    const text="Remind me to call Ananya tomorrow at 9 a.m.";
    const input=fixture(text);
    const change:ProposedChange={entity:"commitment",action:"create",target_id:null,expected_version:null,memory:null,
      commitment:{title:"Call Ananya",subject:"Ananya",status:"open",priority:2,due_text:"tomorrow at 9 a.m.",due_precision:"instant",
        temporal_kind:"local_datetime",offset_datetime:null,local_date:"2026-10-16",local_time:"09:00",timezone:null,relative_seconds:null},
      sources:[{part_id:partId,evidence_text:text}]};
    expect(validateProposals(input,[change]).changes[0]?.value).toMatchObject({title:"Call Ananya",dueAt:"2026-10-16T03:30:00.000Z"});
  });
  test("resolves tomorrow at 9 a.m. across equivalent browser and model timezone names", () => {
    const text = "I need to send the presentation slides tomorrow at 9 a.m.";
    const base = fixture(text, "2026-10-17T16:58:17.953Z");
    const input: ClaimedExtraction = { ...base, sessionTimezone: "Asia/Calcutta" };
    const change: ProposedChange = { entity: "commitment", action: "create", target_id: null, expected_version: null, memory: null,
      commitment: { title: "Send presentation slides", subject: null, status: "open", priority: 2,
        due_text: "tomorrow at 9 a.m.", due_precision: "unresolved", temporal_kind: "unresolved",
        offset_datetime: null, local_date: null, local_time: null, timezone: "Asia/Kolkata", relative_seconds: null },
      sources: [{ part_id: partId, evidence_text: text }],
    };
    expect(timezoneSchema.parse("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(validateProposals(input, [change]).changes[0]?.value).toMatchObject({
      dueAt: "2026-10-18T03:30:00.000Z", dueTimezone: "Asia/Kolkata", duePrecision: "instant",
    });
  });
  test("derives a spoken local deadline when the model's calendar date and time hints disagree",()=>{
    const text="Remind me to call Ananya tomorrow at 9 a.m.";
    const input=fixture(text,"2026-10-16T21:30:00.000Z");
    const change:ProposedChange={entity:"commitment",action:"create",target_id:null,expected_version:null,memory:null,
      commitment:{title:"Call Ananya",subject:"Ananya",status:"open",priority:2,due_text:"tomorrow at 9 a.m.",due_precision:"date",
        temporal_kind:"local_datetime",offset_datetime:null,local_date:"2026-10-17",local_time:"09:00:00",timezone:"Asia/Kolkata",relative_seconds:null},
      sources:[{part_id:partId,evidence_text:text}]};
    expect(validateProposals(input,[change]).changes[0]?.value).toMatchObject({dueAt:"2026-10-18T03:30:00.000Z",duePrecision:"instant"});
    const uncertain={...change,commitment:{...change.commitment!,due_precision:"unresolved" as const,temporal_kind:"unresolved" as const,
      local_date:null,local_time:null}};
    expect(validateProposals(input,[uncertain]).changes[0]?.value).toMatchObject({dueAt:"2026-10-18T03:30:00.000Z",duePrecision:"instant"});
    const vague="Maybe remind me to call Ananya sometime tomorrow at 9 a.m.";
    const vagueInput=fixture(vague,"2026-10-16T21:30:00.000Z");
    const vagueProposal={...uncertain,sources:[{part_id:partId,evidence_text:vague}]};
    expect(validateProposals(vagueInput,[vagueProposal]).changes[0]?.value).toMatchObject({dueAt:null,duePrecision:"unresolved"});
  });
  test("a unique spoken task reference can complete a manually overridden commitment without changing its details",()=>{
    const text="I sent it.";const old=existing(true);const base=fixture(text);
    const input:ClaimedExtraction={...base,mind:{...base.mind,commitments:[old]}};
    const change:ProposedChange={entity:"commitment",action:"complete",target_id:old.id,expected_version:old.version,memory:null,
      commitment:{title:"Wrong title",subject:null,status:"completed",priority:1,due_text:null,due_precision:"none",temporal_kind:"none",
        offset_datetime:null,local_date:null,local_time:null,timezone:null,relative_seconds:null},
      sources:[{part_id:partId,evidence_text:text}]};
    expect(validateProposals(input,[change]).changes[0]?.value).toMatchObject({title:old.title,priority:old.priority,dueAt:old.dueAt,status:"completed"});
    const second=commitmentSchema.parse({...old,id:uuidSchema.parse("00000000-0000-4000-8000-000000000082"),title:"Email the invoice"});
    expect(validateProposals({...input,mind:{...input.mind,commitments:[old,second]}},[change]).changes).toEqual([]);
    expect(validateProposals(input,[{...change,action:"update",commitment:{...change.commitment!,status:"open"}}]).changes).toEqual([]);
  });
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
    const corrected = resolveDue({ ...base.commitment, temporal_kind: "local_date", local_date: "2026-10-16" }, "Asia/Kolkata", fixture("before Friday").newParts[0]!);
    expect(corrected.dueAt).toBe(timestampSchema.parse("2026-10-15T03:30:00.000Z"));
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
  test("resolves a punctuated time and calendar date split across consecutive turns", () => {
    const timeText = "Hello, remind me for my presentation at 3.10 a.m.";
    const dateText = "am 17. Oktober.";
    const base = fixture(dateText, "2026-10-16T21:39:30.000Z");
    const input: ClaimedExtraction = { ...base,
      claim: jobClaimSchema.parse({ ...base.claim, fromOrdinal: 2, throughOrdinal: 2 }),
      earlierParts: [{ partId, itemId, ordinal: 1, contentIndex: 0, text: timeText, timeAnchorAt: "2026-10-16T21:39:00.000Z" }],
      newParts: [{ partId: secondPartId, itemId: secondItemId, ordinal: 2, contentIndex: 0, text: dateText, timeAnchorAt: "2026-10-16T21:39:30.000Z" }],
    };
    const changes = validateProposals(input, [{
      entity: "commitment", action: "create", target_id: null, expected_version: null, memory: null,
      commitment: { title: "Remind about presentation", subject: "user", status: "open", priority: 2, due_text: dateText,
        due_precision: "instant", temporal_kind: "local_datetime", offset_datetime: null, local_date: "2026-10-17", local_time: "03:10", timezone: null, relative_seconds: null },
      sources: [{ part_id: partId, evidence_text: timeText }, { part_id: secondPartId, evidence_text: dateText }],
    }]);
    expect(changes.changes[0]?.value).toMatchObject({ dueAt: "2026-10-16T21:40:00.000Z", dueTimezone: "Asia/Kolkata", duePrecision: "instant" });
  });
  test("resolves an English ordinal calendar date", () => {
    const text = "Remind me at 3:10 a.m. on 17th October";
    const base = proposal("before Friday");
    if (!base.commitment) throw new Error("Fixture error");
    const due = resolveDue({ ...base.commitment, due_text: text, due_precision: "instant", temporal_kind: "local_datetime",
      local_date: "2026-10-17", local_time: "03:10" }, "Asia/Kolkata", fixture(text, "2026-10-16T21:30:00.000Z").newParts[0]!);
    expect(due.dueAt).toBe(timestampSchema.parse("2026-10-16T21:40:00.000Z"));
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
  test("rejects a scheduled future meeting represented as an episodic memory", () => {
    const text = "I have a meeting with Harry on 17th October at 9:20 p.m.";
    const event: ProposedChange = { entity: "memory", action: "create", target_id: null, expected_version: null, commitment: null,
      memory: { kind: "episodic", subject: "user", predicate: "has meeting", content: text, occurred_at: null,
        time_text: "October 17 at 9:20 PM" },
      sources: [{ part_id: partId, evidence_text: text }] };
    expect(() => validateProposals(fixture(text, "2026-10-17T15:47:00.000Z"), [event])).toThrowError(expect.objectContaining({
      failure: { code: "future_event_requires_commitment", policy: "invalid" },
    }));
    expect(validateProposals(fixture(text, "2026-10-17T16:00:00.000Z"), [event]).changes).toHaveLength(1);
  });
  test("creates a distinct future occurrence after an older matching commitment was deleted", () => {
    const deleted = commitmentSchema.parse({ ...existing(true), title: "Meeting with Anna", subject: "Anna", status: "deleted",
      dueAt: "2026-10-17T15:55:00.000Z", dueTimezone: "Asia/Kolkata", dueText: "17th October at 9:25 PM",
      duePrecision: "instant", completedAt: null, dismissedAt: null });
    const proposedMeeting = (text: string, dueText: string, localTime: string): ProposedChange => ({
      entity: "commitment", action: "create", target_id: null, expected_version: null, memory: null,
      commitment: { title: "Meeting with Anna", subject: "Anna", status: "open", priority: 2, due_text: dueText,
        due_precision: "instant", temporal_kind: "local_datetime", offset_datetime: null, local_date: "2026-10-17",
        local_time: localTime, timezone: null, relative_seconds: null },
      sources: [{ part_id: partId, evidence_text: text }],
    });
    const newText = "I have a meeting with Anna on 17th October at 9:35 PM.";
    const base = fixture(newText, "2026-10-17T15:58:02.000Z");
    const newOccurrence = validateProposals({ ...base, mind: { ...base.mind, commitments: [deleted] } },
      [proposedMeeting(newText, "17th October at 9:35 PM", "21:35")]);
    expect(newOccurrence.changes[0]?.value).toMatchObject({ title: "Meeting with Anna", dueAt: "2026-10-17T16:05:00.000Z" });

    const repeatedText = "I have a meeting with Anna on 17th October at 9:25 PM.";
    const repeated = fixture(repeatedText, "2026-10-17T15:50:00.000Z");
    expect(validateProposals({ ...repeated, mind: { ...repeated.mind, commitments: [deleted] } },
      [proposedMeeting(repeatedText, "17th October at 9:25 PM", "21:25")]).changes).toEqual([]);
  });
});
