import type pg from "pg";
import { z } from "zod";
import { commitmentQuerySchema, commitmentSchema, counterSchema, databaseTimestampSchema, memoryQuerySchema, memorySchema, pageRequestSchema, userScopeSchema, uuidSchema, type CommitmentPage, type CommitmentQuery, type MemoryPage, type MemoryQuery, type PageRequest, type TranscriptPage, type UUID, type UserScope, type MindSnapshot, type EntityRef, type ChangeWithSources, type MindReaderContract } from "../contracts";
import { DomainError } from "../contracts";
import { withTransaction } from "../db/transaction";
import { commitmentFromRow, COMMITMENT_COLUMNS, itemFromRow, ITEM_COLUMNS, memoryFromRow, MEMORY_COLUMNS, partFromRow, PART_COLUMNS } from "./rows";
import { decodeCursor, encodeCursor, filterFingerprint } from "./pagination";

const escapeLike = (text: string) => text.replace(/[\\%_]/g, value => `\\${value}`);

export class MindReader implements MindReaderContract {
  constructor(private readonly pool: pg.Pool) {}

  async getSnapshot(scope: UserScope): Promise<MindSnapshot> {
    userScopeSchema.parse(scope);
    return withTransaction(this.pool, { isolation: "repeatable read" }, async client => {
      const state = await client.query<{revision:string}>("SELECT revision FROM mind_state WHERE user_id=$1", [scope.userId]);
      if (!state.rows[0]) throw new DomainError("not_found", "User not found");
      const memories = await client.query(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE user_id=$1 ORDER BY id`, [scope.userId]);
      const commitments = await client.query(`SELECT ${COMMITMENT_COLUMNS} FROM commitments WHERE user_id=$1 ORDER BY id`, [scope.userId]);
      return { revision: counterSchema.parse(state.rows[0].revision), memories: memories.rows.map(memoryFromRow), commitments: commitments.rows.map(commitmentFromRow) };
    });
  }

  async listMemories(scope: UserScope, query: MemoryQuery & PageRequest): Promise<MemoryPage> {
    userScopeSchema.parse(scope); const page = pageRequestSchema.parse({limit:query.limit,cursor:query.cursor}); const filters = memoryQuerySchema.parse({state:query.state,kind:query.kind,subject:query.subject,text:query.text});
    const normalized = { state: filters.state ?? "active", kind: filters.kind ?? null, subject: filters.subject ?? null, text: filters.text ?? null };
    const fingerprint = filterFingerprint(normalized); const cursor = decodeCursor(page.cursor, "memories", fingerprint);
    if (cursor && cursor.kind !== "memories") throw new DomainError("invalid_input", "Invalid pagination cursor");
    const result = await this.pool.query(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE user_id=$1 AND state=$2
      AND ($3::text IS NULL OR kind=$3) AND ($4::text IS NULL OR lower(subject)=lower($4))
      AND ($5::text IS NULL OR subject ILIKE $5 ESCAPE '\\' OR predicate ILIKE $5 ESCAPE '\\' OR content ILIKE $5 ESCAPE '\\')
      AND ($6::timestamptz IS NULL OR (updated_at,id) < ($6::timestamptz,$7::uuid))
      ORDER BY updated_at DESC,id DESC LIMIT $8`, [scope.userId,normalized.state,normalized.kind,normalized.subject,normalized.text === null ? null : `%${escapeLike(normalized.text)}%`,cursor?.kind === "memories" ? cursor.updatedAt : null,cursor?.kind === "memories" ? cursor.id : null,page.limit+1]);
    const records = result.rows.map(memoryFromRow); const items = records.slice(0,page.limit); const last = items.at(-1);
    return { items, nextCursor: records.length > page.limit && last ? encodeCursor({v:1,kind:"memories",filter:fingerprint,updatedAt:last.updatedAt,id:last.id}) : null };
  }

  async listCommitments(scope: UserScope, query: CommitmentQuery & PageRequest): Promise<CommitmentPage> {
    userScopeSchema.parse(scope); const page = pageRequestSchema.parse({limit:query.limit,cursor:query.cursor}); const filters = commitmentQuerySchema.parse({status:query.status,priority:query.priority,dueBefore:query.dueBefore});
    const normalized = { status: filters.status ?? null, priority: filters.priority ?? null, dueBefore: filters.dueBefore ?? null };
    const fingerprint = filterFingerprint(normalized); const cursor = decodeCursor(page.cursor,"commitments",fingerprint);
    if (cursor && cursor.kind !== "commitments") throw new DomainError("invalid_input","Invalid pagination cursor");
    const result = await this.pool.query(`SELECT ${COMMITMENT_COLUMNS} FROM commitments WHERE user_id=$1
      AND ($2::text IS NULL OR status=$2) AND ($3::smallint IS NULL OR priority=$3)
      AND ($4::timestamptz IS NULL OR (due_at IS NOT NULL AND due_at <= $4))
      AND ($5::smallint IS NULL OR priority > $5 OR (priority=$5 AND
        (($6::timestamptz IS NOT NULL AND (due_at > $6 OR (due_at=$6 AND id > $7::uuid)))
          OR ($6::timestamptz IS NULL AND due_at IS NULL AND id > $7::uuid)
          OR ($6::timestamptz IS NOT NULL AND due_at IS NULL))))
      ORDER BY priority ASC,due_at ASC NULLS LAST,id ASC LIMIT $8`,
      [scope.userId,normalized.status,normalized.priority,normalized.dueBefore,cursor?.kind === "commitments" ? cursor.priority : null,cursor?.kind === "commitments" ? cursor.dueAt : null,cursor?.kind === "commitments" ? cursor.id : null,page.limit+1]);
    const records = result.rows.map(commitmentFromRow); const items = records.slice(0,page.limit); const last = items.at(-1);
    return { items, nextCursor: records.length > page.limit && last ? encodeCursor({v:1,kind:"commitments",filter:fingerprint,priority:last.priority,dueAt:last.dueAt,id:last.id}) : null };
  }

  async getTranscript(scope: UserScope, sessionId: UUID, page: PageRequest): Promise<TranscriptPage> {
    userScopeSchema.parse(scope); uuidSchema.parse(sessionId); pageRequestSchema.parse(page);
    const fingerprint = filterFingerprint({sessionId}); const cursor = decodeCursor(page.cursor,"transcript",fingerprint);
    if (cursor && cursor.kind !== "transcript") throw new DomainError("invalid_input","Invalid pagination cursor");
    return withTransaction(this.pool,{isolation:"repeatable read"},async client => {
      const session = await client.query("SELECT id FROM voice_sessions WHERE user_id=$1 AND id=$2",[scope.userId,sessionId]);
      if (!session.rows[0]) throw new DomainError("not_found","Session not found");
      const placed = await client.query(`SELECT ${ITEM_COLUMNS} FROM transcript_items WHERE user_id=$1 AND session_id=$2 AND ordinal IS NOT NULL AND ($3::integer IS NULL OR ordinal > $3) ORDER BY ordinal ASC LIMIT $4`,[scope.userId,sessionId,cursor?.kind === "transcript" ? cursor.ordinal : null,page.limit+1]);
      const rawItems = placed.rows.map(itemFromRow); const items = rawItems.slice(0,page.limit);
      const parts = items.length ? await client.query(`SELECT ${PART_COLUMNS} FROM transcript_parts WHERE user_id=$1 AND item_id=ANY($2::uuid[]) ORDER BY item_id,content_index`,[scope.userId,items.map(item=>item.id)]) : {rows:[]};
      const partMap = new Map<string,ReturnType<typeof partFromRow>[]>();
      for (const row of parts.rows) { const part = partFromRow(row); const current = partMap.get(part.itemId) ?? []; current.push(part); partMap.set(part.itemId,current); }
      const unplaced = await client.query(`SELECT ${ITEM_COLUMNS} FROM transcript_items WHERE user_id=$1 AND session_id=$2 AND ordinal IS NULL ORDER BY first_seen_at,id`,[scope.userId,sessionId]);
      const last = items.at(-1);
      return { items:items.map(item=>({item,parts:partMap.get(item.id)??[]})), gaps:unplaced.rows.map(row=>{const item=itemFromRow(row);return {item,reason:item.state === "failed" ? "failed" as const : item.state === "excluded" ? "excluded" as const : "unplaced" as const};}),
        nextCursor:rawItems.length>page.limit && last ? encodeCursor({v:1,kind:"transcript",filter:fingerprint,ordinal:last.ordinal ?? 0,id:last.id}) : null };
    });
  }

  async getProvenance(scope: UserScope, entity: EntityRef): Promise<readonly ChangeWithSources[]> {
    userScopeSchema.parse(scope); uuidSchema.parse(entity.id); if (entity.type !== "memory" && entity.type !== "commitment") throw new DomainError("invalid_input","Invalid entity type");
    const table = entity.type === "memory" ? "memories" : "commitments";
    const field = entity.type === "memory" ? "memory_id" : "commitment_id";
    return withTransaction(this.pool,{isolation:"repeatable read"},async client=>{
      const target = await client.query(`SELECT id FROM ${table} WHERE user_id=$1 AND id=$2`,[scope.userId,entity.id]);
      if (!target.rows[0]) throw new DomainError("not_found","Entity not found");
      const changes = await client.query(`SELECT id,entity_version,operation,actor,job_id,after_state,created_at FROM mind_changes WHERE user_id=$1 AND ${field}=$2 ORDER BY entity_version`,[scope.userId,entity.id]);
      const output:ChangeWithSources[]=[];
      for (const row of changes.rows) {
        const sources = await client.query(`SELECT s.transcript_part_id,s.evidence_text,p.item_id,p.content_index,i.session_id,i.ordinal FROM change_sources s JOIN transcript_parts p ON p.user_id=s.user_id AND p.id=s.transcript_part_id JOIN transcript_items i ON i.user_id=p.user_id AND i.id=p.item_id WHERE s.user_id=$1 AND s.change_id=$2 ORDER BY i.ordinal NULLS LAST,p.content_index`,[scope.userId,row.id]);
        const afterState = entity.type === "memory" ? memorySchema.parse(row.after_state) : commitmentSchema.parse(row.after_state);
        if(afterState.id!==entity.id || afterState.userId!==scope.userId || afterState.version!==row.entity_version) throw new Error("Invalid stored provenance revision");
        output.push({id:uuidSchema.parse(row.id),entityVersion:counterSchema.parse(row.entity_version),operation:z.enum(["create","update","delete","complete","dismiss","reopen","release_override"]).parse(row.operation),actor:z.enum(["reconciler","user"]).parse(row.actor),jobId:row.job_id===null?null:uuidSchema.parse(row.job_id),afterState,createdAt:databaseTimestampSchema.parse(row.created_at),sources:sources.rows.map(s=>({transcriptPartId:uuidSchema.parse(s.transcript_part_id),sessionId:uuidSchema.parse(s.session_id),itemId:uuidSchema.parse(s.item_id),itemOrdinal:z.number().int().parse(s.ordinal),contentIndex:z.number().int().parse(s.content_index),evidenceText:z.string().parse(s.evidence_text)}))});
      }
      return output;
    });
  }
}
