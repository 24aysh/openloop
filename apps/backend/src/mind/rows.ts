import { commitmentSchema, memorySchema, transcriptItemSchema, transcriptPartSchema, databaseTimestampSchema, counterSchema, uuidSchema, type Commitment, type Memory, type TranscriptItem, type TranscriptPart } from "../contracts";

export const MEMORY_COLUMNS = `id,user_id,kind,subject,predicate,content,occurred_at,time_text,state,version,manual_override,created_at,updated_at`;
export const COMMITMENT_COLUMNS = `id,user_id,title,subject,status,priority,due_at,due_timezone,due_text,due_precision,version,schedule_version,manual_override,created_at,updated_at,completed_at,dismissed_at`;
export const ITEM_COLUMNS = `id,user_id,session_id,provider_item_id,predecessor_known,previous_item_id,ordinal,role,item_type,state,expected_parts,provider_response_id,first_seen_at,updated_at,committed_at,time_anchor_at,speech_started_at,speech_stopped_at,audio_start_ms,audio_end_ms,terminal_at,error_code`;
export const PART_COLUMNS = `id,user_id,item_id,content_index,kind,final_text,state,final_event_id,text_hash,completed_at,error_code`;

type Row = Record<string, unknown>;
const nullableTime = (value: unknown) => value === null || value === undefined ? null : databaseTimestampSchema.parse(value);

export function memoryFromRow(row: Row): Memory {
  return memorySchema.parse({
    id: row.id, userId: row.user_id, kind: row.kind, subject: row.subject, predicate: row.predicate, content: row.content,
    occurredAt: nullableTime(row.occurred_at), timeText: row.time_text, state: row.state, version: row.version,
    manualOverride: row.manual_override, createdAt: databaseTimestampSchema.parse(row.created_at), updatedAt: databaseTimestampSchema.parse(row.updated_at),
  });
}
export function commitmentFromRow(row: Row): Commitment {
  return commitmentSchema.parse({
    id: row.id, userId: row.user_id, title: row.title, subject: row.subject, status: row.status, priority: row.priority,
    dueAt: nullableTime(row.due_at), dueTimezone: row.due_timezone, dueText: row.due_text, duePrecision: row.due_precision,
    version: row.version, scheduleVersion: row.schedule_version, manualOverride: row.manual_override,
    createdAt: databaseTimestampSchema.parse(row.created_at), updatedAt: databaseTimestampSchema.parse(row.updated_at),
    completedAt: nullableTime(row.completed_at), dismissedAt: nullableTime(row.dismissed_at),
  });
}
export function itemFromRow(row: Row): TranscriptItem {
  return transcriptItemSchema.parse({
    id: row.id, userId: row.user_id, sessionId: row.session_id, providerItemId: row.provider_item_id,
    predecessorKnown: row.predecessor_known, previousItemId: row.previous_item_id, ordinal: row.ordinal, role: row.role,
    itemType: row.item_type, state: row.state, expectedParts: row.expected_parts, providerResponseId: row.provider_response_id,
    firstSeenAt: databaseTimestampSchema.parse(row.first_seen_at), updatedAt: databaseTimestampSchema.parse(row.updated_at),
    committedAt: nullableTime(row.committed_at), timeAnchorAt: nullableTime(row.time_anchor_at), speechStartedAt: nullableTime(row.speech_started_at),
    speechStoppedAt: nullableTime(row.speech_stopped_at), audioStartMs: row.audio_start_ms, audioEndMs: row.audio_end_ms,
    terminalAt: nullableTime(row.terminal_at), errorCode: row.error_code,
  });
}
export function partFromRow(row: Row): TranscriptPart {
  return transcriptPartSchema.parse({
    id: row.id, userId: row.user_id, itemId: row.item_id, contentIndex: row.content_index, kind: row.kind,
    finalText: row.final_text, state: row.state, finalEventId: row.final_event_id, textHash: row.text_hash,
    completedAt: nullableTime(row.completed_at), errorCode: row.error_code,
  });
}
export function rowId(row: Row) { return uuidSchema.parse(row.id); }
export function rowCounter(row: Row, column: string) { return counterSchema.parse(row[column]); }
