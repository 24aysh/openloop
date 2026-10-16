import { commitmentValueSchema, memoryValueSchema, timestampSchema, validatedChangeSetSchema, type Commitment, type Memory, type MemoryValue, type ValidatedChangeSet } from "../contracts";
import { resolveDue } from "./time";
import { ExtractionError, type ClaimedExtraction, type ProposedChange } from "./types";

function fail(code: string): never { throw new ExtractionError({ code, policy: "invalid" }); }
const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const meaningful = (value: string) => value.toLowerCase().match(/[a-z0-9]{4,}/g)?.filter(word => !["send", "have", "will", "that", "this", "with", "from", "about", "done"].includes(word)) ?? [];
const sameMemory = (old: Memory, value: MemoryValue) =>
  old.kind === value.kind && old.subject === value.subject && old.predicate === value.predicate && old.content === value.content && old.occurredAt === value.occurredAt && old.timeText === value.timeText;
const sameCommitment = (old: Commitment, value: { title: string; subject: string | null; status: string; priority: number; dueAt: string | null; dueTimezone: string | null; dueText: string | null; duePrecision: string }) =>
  old.title === value.title && old.subject === value.subject && old.status === value.status && old.priority === value.priority && old.dueAt === value.dueAt && old.dueTimezone === value.dueTimezone && old.dueText === value.dueText && old.duePrecision === value.duePrecision;

export function validateProposals(input: ClaimedExtraction, proposals: readonly ProposedChange[]): ValidatedChangeSet {
  if (proposals.length > 50) fail("too_many_changes");
  const parts = new Map([...input.earlierParts, ...input.newParts].map(part => [part.partId, part]));
  const memories = new Map(input.mind.memories.map(memory => [memory.id, memory]));
  const commitments = new Map(input.mind.commitments.map(commitment => [commitment.id, commitment]));
  const targets = new Set<string>();
  const creates = new Set<string>();
  const changes: ValidatedChangeSet["changes"] = [];
  for (const proposal of proposals) {
    const sourceIds = new Set<string>();
    const sourceParts = proposal.sources.map(source => {
      if (sourceIds.has(source.part_id)) fail("duplicate_source");
      sourceIds.add(source.part_id);
      const part = parts.get(source.part_id);
      if (!part || !part.text.includes(source.evidence_text)) fail("invalid_evidence");
      return part;
    });
    if (sourceParts.length === 0 || !sourceParts.some(part => part.ordinal >= input.claim.fromOrdinal && part.ordinal <= input.claim.throughOrdinal)) fail("missing_new_evidence");
    const evidence = proposal.sources.map(source => source.evidence_text).join(" ");
    const sources = proposal.sources.map(source => ({ transcriptPartId: source.part_id, evidenceText: source.evidence_text }));
    if (proposal.action === "create") {
      if (proposal.target_id !== null || proposal.expected_version !== null) fail("invalid_target");
    } else if (proposal.target_id === null || proposal.expected_version === null) fail("invalid_target");
    if (proposal.target_id) {
      const key = `${proposal.entity}:${proposal.target_id}`;
      if (targets.has(key)) fail("duplicate_target");
      targets.add(key);
    }
    if (proposal.entity === "memory") {
      if (proposal.commitment !== null || !["create", "update", "delete"].includes(proposal.action)) fail("invalid_memory_action");
      const old = proposal.target_id ? memories.get(proposal.target_id) : null;
      if (proposal.target_id && (!old || old.version !== proposal.expected_version)) fail("invalid_memory_target");
      if (old?.manualOverride || old?.state === "deleted") continue;
      if (proposal.action === "delete") {
        if (proposal.memory !== null || !old || !/\b(forget|delete|remove|no longer true)\b/i.test(evidence)) fail("unsupported_delete");
        changes.push({ entity: "memory", action: "delete", targetId: old.id, expectedVersion: old.version, value: null, sources });
        continue;
      }
      if (!proposal.memory) fail("missing_memory_value");
      const memory = proposal.memory;
      let occurredAt: string | null = null;
      if (memory.kind === "episodic" && memory.occurred_at !== null) {
        const parsed = timestampSchema.safeParse(memory.occurred_at);
        if (!parsed.success) fail("invalid_event_time");
        if (evidence.includes(memory.occurred_at.slice(0, 10))) occurredAt = parsed.data;
      }
      const value = memoryValueSchema.safeParse({ kind: memory.kind, subject: memory.subject, predicate: memory.predicate, content: memory.content, occurredAt, timeText: memory.time_text });
      if (!value.success) fail("invalid_memory_value");
      if (old) {
        if (old.kind !== value.data.kind) fail("memory_kind_change");
        if (!meaningful(`${old.subject} ${old.predicate} ${old.content}`).some(word => evidence.toLowerCase().includes(word))) continue;
        if (sameMemory(old, value.data)) continue;
      } else {
        const key = value.data.kind === "semantic"
          ? `memory:semantic:${norm(value.data.subject)}:${norm(value.data.predicate)}`
          : `memory:episodic:${norm(value.data.subject)}:${norm(value.data.predicate)}:${norm(value.data.content)}:${value.data.occurredAt ?? ""}:${norm(value.data.timeText ?? "")}`;
        if (creates.has(key)) fail("duplicate_create");
        creates.add(key);
        const existing = input.mind.memories.find(item => item.kind === value.data.kind && norm(item.subject) === norm(value.data.subject) && norm(item.predicate) === norm(value.data.predicate)
          && (value.data.kind === "semantic" || sameMemory(item, value.data)));
        if (existing) { if (existing.manualOverride || existing.state === "deleted" || sameMemory(existing, value.data)) continue; fail("existing_memory_requires_update"); }
      }
      changes.push({ entity: "memory", action: proposal.action as "create" | "update", targetId: old?.id ?? null, expectedVersion: old?.version ?? null, value: value.data, sources });
      continue;
    }
    if (proposal.memory !== null || proposal.commitment === null || !["create", "update", "complete", "dismiss", "reopen"].includes(proposal.action)) fail("invalid_commitment_action");
    const old = proposal.target_id ? commitments.get(proposal.target_id) : null;
    if (proposal.target_id && (!old || old.version !== proposal.expected_version)) fail("invalid_commitment_target");
    if (old?.manualOverride) continue;
    const proposed = proposal.commitment;
    if (proposed.priority === 1 && (!old || old.priority !== 1) && !/\b(urgent|important|asap|high priority|critical)\b/i.test(evidence)) fail("unsupported_high_priority");
    if (proposed.priority === 3 && (!old || old.priority !== 3) && !/\b(low priority|not urgent|whenever|no rush)\b/i.test(evidence)) fail("unsupported_low_priority");
    if (proposed.due_text && !sourceParts.some(part => part.text.includes(proposed.due_text ?? ""))) fail("invalid_due_evidence");
    const duePart = sourceParts.find(part => proposed.due_text && part.text.includes(proposed.due_text)) ?? sourceParts[0];
    if (!duePart) fail("invalid_evidence");
    const supportingEvidence = [...sourceParts]
      .sort((left, right) => left.ordinal - right.ordinal || left.contentIndex - right.contentIndex)
      .map(part => part.text).join(" ");
    const due = old && proposal.action !== "update" && proposed.due_text === null
      ? { dueAt: old.dueAt, dueTimezone: old.dueTimezone, dueText: old.dueText, duePrecision: old.duePrecision }
      : resolveDue(proposed, input.sessionTimezone, duePart, supportingEvidence);
    const value = commitmentValueSchema.safeParse({ title: proposed.title, subject: proposed.subject, status: proposed.status, priority: proposed.priority, ...due });
    if (!value.success) fail("invalid_commitment_value");
    if (old) {
      if (!meaningful(`${old.title} ${old.subject ?? ""}`).some(word => evidence.toLowerCase().includes(word))) continue;
      const valid = proposal.action === "update" ? proposed.status === old.status
        : proposal.action === "complete" ? old.status === "open" && proposed.status === "completed" && /\b(done|sent|finished|completed|did|delivered)\b/i.test(evidence)
          : proposal.action === "dismiss" ? old.status === "open" && proposed.status === "dismissed" && /\b(cancel|dismiss|drop|not doing)\b/i.test(evidence)
            : proposal.action === "reopen" && old.status !== "open" && proposed.status === "open" && /\b(reopen|again|still need|will do)\b/i.test(evidence);
      if (!valid) fail("invalid_commitment_transition");
      if (proposal.action === "update" && sameCommitment(old, value.data)) continue;
    } else {
      if (proposal.action !== "create") fail("missing_commitment_target");
      if (proposed.status === "completed" && !/\b(done|sent|finished|completed|did|delivered)\b/i.test(evidence)) fail("unsupported_completion");
      if (proposed.status === "dismissed" && !/\b(cancel|dismiss|drop|not doing)\b/i.test(evidence)) fail("unsupported_dismissal");
      const key = `commitment:${norm(value.data.title)}:${norm(value.data.subject ?? "")}`;
      if (creates.has(key)) fail("duplicate_create");
      creates.add(key);
      const existing = input.mind.commitments.find(item => norm(item.title) === norm(value.data.title) && norm(item.subject ?? "") === norm(value.data.subject ?? ""));
      if (existing) { if (existing.manualOverride || sameCommitment(existing, value.data)) continue; fail("existing_commitment_requires_update"); }
    }
    changes.push({ entity: "commitment", action: proposal.action as "create" | "update" | "complete" | "dismiss" | "reopen", targetId: old?.id ?? null, expectedVersion: old?.version ?? null, value: value.data, sources });
  }
  const parsed = validatedChangeSetSchema.safeParse({ changes });
  if (!parsed.success) fail("invalid_change_set");
  return parsed.data;
}
