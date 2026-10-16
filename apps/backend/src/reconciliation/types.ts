import type { JobClaim, MindSnapshot, UUID } from "../contracts";

export type CompletedUserPart = Readonly<{
  partId: UUID;
  itemId: UUID;
  ordinal: number;
  contentIndex: number;
  text: string;
  timeAnchorAt: string | null;
}>;

export type ClaimedExtraction = Readonly<{
  claim: JobClaim;
  attempt: number;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  sessionTimezone: string;
  sessionStartedAt: string;
  newParts: readonly CompletedUserPart[];
  earlierParts: readonly CompletedUserPart[];
  mind: MindSnapshot;
  validationFeedback: string | null;
}>;

export type ProposedSource = Readonly<{ part_id: UUID; evidence_text: string }>;
export type ProposedMemory = Readonly<{
  kind: "semantic" | "episodic";
  subject: string;
  predicate: string;
  content: string;
  occurred_at: string | null;
  time_text: string | null;
}>;
export type ProposedCommitment = Readonly<{
  title: string;
  subject: string | null;
  status: "open" | "completed" | "dismissed";
  priority: 1 | 2 | 3;
  due_text: string | null;
  due_precision: "instant" | "date" | "unresolved" | "none";
  temporal_kind: "none" | "unresolved" | "offset" | "local_datetime" | "local_date" | "relative";
  offset_datetime: string | null;
  local_date: string | null;
  local_time: string | null;
  timezone: string | null;
  relative_seconds: number | null;
}>;
export type ProposedChange = Readonly<{
  entity: "memory" | "commitment";
  action: "create" | "update" | "delete" | "complete" | "dismiss" | "reopen";
  target_id: UUID | null;
  expected_version: string | null;
  memory: ProposedMemory | null;
  commitment: ProposedCommitment | null;
  sources: readonly ProposedSource[];
}>;

export type ExtractionOutcome =
  | { kind: "success"; proposals: readonly ProposedChange[] }
  | { kind: "refusal" }
  | { kind: "incomplete" }
  | { kind: "invalid_output"; code: string };

export interface TextExtractor {
  extract(input: ClaimedExtraction, signal: AbortSignal): Promise<ExtractionOutcome>;
}

export type JobFailure = Readonly<{
  code: string;
  policy: "retry" | "invalid" | "conflict" | "block";
  retryAfterSeconds?: number;
}>;

export class ExtractionError extends Error {
  constructor(readonly failure: JobFailure) { super(failure.code); }
}
