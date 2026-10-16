import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { commitmentFromRow, COMMITMENT_COLUMNS, memoryFromRow, MEMORY_COLUMNS } from "./rows";
import { commitmentSchema, commitmentValueSchema, jobClaimSchema, memorySchema, nextCounter, uuidSchema, validatedChangeSetSchema, type ApplyResult, type Commitment, type JobClaim, type Memory, type ValidatedChangeSet, type ValidatedCommitmentChange, type UUID } from "../contracts";
import { DomainError } from "../contracts";
import { withTransaction } from "../db/transaction";
import { addChange, advanceMindState, databaseNow, lockMindState } from "./writer";

export type HashInputPart = Readonly<{ ordinal:number; itemId:UUID; partId:UUID; contentIndex:number; textHash:string; timeAnchorAt:string|null }>;
export function hashTranscriptInput(timezone:string,parts:readonly HashInputPart[]):string {
  return createHash("sha256").update(JSON.stringify({timezone,parts})).digest("hex");
}
function invalid(message:string):never { throw new DomainError("invalid_input",message); }
function parseInput<T>(schema:z.ZodType<T>,value:unknown):T { const parsed=schema.safeParse(value);if(!parsed.success) invalid("Invalid extraction input");return parsed.data; }

type SourceRow = { partId:UUID; ordinal:number; text:string };
type PreparedChange = { change:ValidatedChangeSet["changes"][number]; sources:SourceRow[]; target:Memory|Commitment|null; newId:UUID };

export async function applyExtraction(pool:pg.Pool,rawClaim:JobClaim,rawChanges:ValidatedChangeSet):Promise<ApplyResult> {
  const claim=parseInput(jobClaimSchema,rawClaim);
  const changes=parseInput(validatedChangeSetSchema,rawChanges).changes;
  const targetKeys=new Set<string>();
  for(const change of changes){
    if(change.targetId){ const key=`${change.entity}:${change.targetId}`; if(targetKeys.has(key)) invalid("Duplicate extraction target");targetKeys.add(key); }
    const sourceIds=new Set(change.sources.map(source=>source.transcriptPartId));
    if(sourceIds.size!==change.sources.length) invalid("Duplicate evidence part");
  }
  return withTransaction(pool,{isolation:"read committed"},async client=>{
    const revision=await lockMindState(client,claim.userId);
    const sessionResult=await client.query<{id:string;timezone:string;applied_through:number;sealed_through:number}>("SELECT id,timezone,applied_through,sealed_through FROM voice_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE",[claim.userId,claim.sessionId]);
    const session=sessionResult.rows[0];if(!session) throw new DomainError("not_found","Session not found");
    const jobResult=await client.query<{id:string;user_id:string;session_id:string;from_ordinal:number;through_ordinal:number;input_hash:string;state:string;claim_token:string|null;lease_until:Date|null;base_mind_revision:string|null}>("SELECT id,user_id,session_id,from_ordinal,through_ordinal,input_hash,state,claim_token,lease_until,base_mind_revision FROM reconciliation_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE",[claim.userId,claim.jobId]);
    const job=jobResult.rows[0];if(!job) throw new DomainError("not_found","Job not found");
    if(job.session_id!==claim.sessionId || job.from_ordinal!==claim.fromOrdinal || job.through_ordinal!==claim.throughOrdinal || job.input_hash!==claim.inputHash) invalid("Claim does not match job");
    const clock=await databaseNow(client);
    if(job.state!=="running" || job.claim_token!==claim.claimToken || !job.lease_until || job.lease_until<=clock) throw new DomainError("stale_claim","Extraction claim expired");
    if(revision!==claim.baseMindRevision || job.base_mind_revision!==claim.baseMindRevision) throw new DomainError("stale_snapshot","Mind changed during extraction");
    if(session.applied_through!==claim.fromOrdinal-1 || session.sealed_through<claim.throughOrdinal) throw new DomainError("dependency_blocked","Earlier extraction is incomplete");
    const earlier=await client.query<{id:string}>(`SELECT j.id FROM reconciliation_jobs j JOIN voice_sessions s ON s.user_id=j.user_id AND s.id=j.session_id
      WHERE j.user_id=$1 AND j.state NOT IN ('succeeded','skipped') AND (s.session_seq,j.from_ordinal)<(SELECT vs.session_seq,$2::integer FROM voice_sessions vs WHERE vs.user_id=$1 AND vs.id=$3)
      ORDER BY s.session_seq,j.from_ordinal LIMIT 1`,[claim.userId,claim.fromOrdinal,claim.sessionId]);
    if(earlier.rows[0]) throw new DomainError("dependency_blocked","Earlier extraction job is unfinished");
    const itemRows=await client.query<{id:string;ordinal:number;role:string;state:string;expected_parts:number|null;time_anchor_at:Date|null}>(`SELECT id,ordinal,role,state,expected_parts,time_anchor_at FROM transcript_items
      WHERE user_id=$1 AND session_id=$2 AND ordinal BETWEEN 1 AND $3 ORDER BY ordinal`,[claim.userId,claim.sessionId,claim.throughOrdinal]);
    if(itemRows.rows.length!==claim.throughOrdinal || itemRows.rows.some((item,index)=>item.ordinal!==index+1)) throw new DomainError("ordering_gap","Transcript prefix has a gap");
    const userItems=itemRows.rows.filter(item=>item.role==="user");
    if(userItems.some(item=>item.state!=="complete" || item.expected_parts===null || item.expected_parts<1)) throw new DomainError("ordering_gap","Transcript prefix is incomplete");
    const prefix=await client.query<{part_id:string;item_id:string;ordinal:number;content_index:number;text_hash:string|null;final_text:string|null;state:string;time_anchor_at:Date|null}>(`SELECT p.id AS part_id,p.item_id,i.ordinal,p.content_index,p.text_hash,p.final_text,p.state,i.time_anchor_at
      FROM transcript_parts p JOIN transcript_items i ON i.user_id=p.user_id AND i.id=p.item_id
      WHERE p.user_id=$1 AND i.session_id=$2 AND i.ordinal BETWEEN 1 AND $3 AND i.role='user'
      ORDER BY i.ordinal,p.content_index`,[claim.userId,claim.sessionId,claim.throughOrdinal]);
    for(const item of userItems){
      const parts=prefix.rows.filter(part=>part.item_id===item.id);
      if(parts.length!==item.expected_parts || parts.some((part,index)=>part.content_index!==index || part.state!=="complete" || part.text_hash===null || part.final_text===null)) throw new DomainError("ordering_gap","User transcript is incomplete");
    }
    if(prefix.rows.some(part=>createHash("sha256").update(part.final_text??"").digest("hex")!==part.text_hash)) throw new DomainError("stale_snapshot","Transcript text hash changed");
    const hashParts:HashInputPart[]=prefix.rows.map(part=>({ordinal:part.ordinal,itemId:uuidSchema.parse(part.item_id),partId:uuidSchema.parse(part.part_id),contentIndex:part.content_index,textHash:z.string().parse(part.text_hash),timeAnchorAt:part.time_anchor_at?.toISOString()??null}));
    if(hashTranscriptInput(session.timezone,hashParts)!==claim.inputHash) throw new DomainError("stale_snapshot","Transcript input changed");
    const prefixById=new Map(prefix.rows.map(part=>[part.part_id,part]));

    const memoryIds=changes.flatMap(change=>change.entity==="memory"&&change.targetId!==null?[change.targetId]:[]).sort();
    const commitmentIds=changes.flatMap(change=>change.entity==="commitment"&&change.targetId!==null?[change.targetId]:[]).sort();
    const memoryRows=new Map<string,Memory>();
    for(const id of memoryIds){const result=await client.query(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE user_id=$1 AND id=$2 FOR UPDATE`,[claim.userId,id]);if(!result.rows[0]) throw new DomainError("stale_snapshot","Memory target changed");memoryRows.set(id,memoryFromRow(result.rows[0]));}
    const commitmentRows=new Map<string,Commitment>();
    for(const id of commitmentIds){const result=await client.query(`SELECT ${COMMITMENT_COLUMNS} FROM commitments WHERE user_id=$1 AND id=$2 FOR UPDATE`,[claim.userId,id]);if(!result.rows[0]) throw new DomainError("stale_snapshot","Commitment target changed");commitmentRows.set(id,commitmentFromRow(result.rows[0]));}
    const prepared:PreparedChange[]=changes.map(change=>{
      const target=change.targetId===null?null:change.entity==="memory"?memoryRows.get(change.targetId)??null:commitmentRows.get(change.targetId)??null;
      const allowedOverride=change.entity==="commitment" && ["complete","dismiss"].includes(change.action);
      if(change.targetId && (!target || target.version!==change.expectedVersion || (target.manualOverride && !allowedOverride))) throw new DomainError("stale_snapshot","Extraction target changed");
      const sources:SourceRow[]=change.sources.map(source=>{
        const part=prefixById.get(source.transcriptPartId);
        if(!part || !part.final_text || !part.final_text.includes(source.evidenceText) || part.ordinal>claim.throughOrdinal) invalid("Invalid extraction evidence");
        return {partId:source.transcriptPartId,ordinal:part.ordinal,text:source.evidenceText};
      });
      if(!sources.some(source=>source.ordinal>=claim.fromOrdinal)) invalid("Change lacks new transcript evidence");
      return {change,sources,target,newId:uuidSchema.parse(crypto.randomUUID())};
    });
    const createdMemoryIds:UUID[]=[];const updatedMemoryIds:UUID[]=[];const createdCommitmentIds:UUID[]=[];const updatedCommitmentIds:UUID[]=[];
    const memories=prepared.filter(p=>p.change.entity==="memory");
    const commitments=prepared.filter((p):p is PreparedChange & {change:ValidatedCommitmentChange}=>p.change.entity==="commitment").sort((a,b)=>{
      const va=a.change.value;const vb=b.change.value;
      if(!va||!vb) return 0;
      return va.priority-vb.priority || (va.dueAt??"~").localeCompare(vb.dueAt??"~") || Math.min(...a.sources.map(s=>s.ordinal))-Math.min(...b.sources.map(s=>s.ordinal)) || a.newId.localeCompare(b.newId);
    });
    for(const preparedChange of [...memories,...commitments]){
      const {change,target,sources,newId}=preparedChange;
      if(change.entity==="memory"){
        let record:Memory;
        if(change.action==="create"){
          if(!change.value) invalid("Missing memory value");
          const value=change.value;
          const result=await client.query(`INSERT INTO memories(id,user_id,kind,subject,predicate,content,occurred_at,time_text,state)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active') RETURNING ${MEMORY_COLUMNS}`,[newId,claim.userId,value.kind,value.subject,value.predicate,value.content,value.occurredAt,value.timeText]);
          record=memoryFromRow(result.rows[0]??{});createdMemoryIds.push(record.id);
        }else{
          if(!target || !("kind" in target) || !change.targetId) invalid("Invalid memory target");
          const old=memorySchema.parse(target);
          if(old.state==="deleted") invalid("Deleted memory cannot be extracted into");
          if(change.action==="update"){
            if(!change.value || change.value.kind!==old.kind) invalid("Memory kind cannot change");
            const value=change.value;
            if(old.subject===value.subject && old.predicate===value.predicate && old.content===value.content && old.occurredAt===value.occurredAt && old.timeText===value.timeText) continue;
            const result=await client.query(`UPDATE memories SET subject=$3,predicate=$4,content=$5,occurred_at=$6,time_text=$7,version=$8,updated_at=now()
              WHERE user_id=$1 AND id=$2 RETURNING ${MEMORY_COLUMNS}`,[claim.userId,old.id,value.subject,value.predicate,value.content,value.occurredAt,value.timeText,nextCounter(old.version)]);
            record=memoryFromRow(result.rows[0]??{});
          }else{
            const result=await client.query(`UPDATE memories SET state='deleted',version=$3,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING ${MEMORY_COLUMNS}`,[claim.userId,old.id,nextCounter(old.version)]);
            record=memoryFromRow(result.rows[0]??{});
          }
          updatedMemoryIds.push(record.id);
        }
        const changeId=await addChange(client,{userId:claim.userId,memoryId:record.id,jobId:claim.jobId,version:record.version,operation:change.action,actor:"reconciler",afterState:record});
        for(const source of sources) await client.query("INSERT INTO change_sources(user_id,change_id,transcript_part_id,evidence_text) VALUES($1,$2,$3,$4)",[claim.userId,changeId,source.partId,source.text]);
      }else{
        const value=parseInput(commitmentValueSchema,change.value);
        let record:Commitment;
        if(change.action==="create"){
          const result=await client.query(`INSERT INTO commitments(id,user_id,title,subject,status,priority,due_at,due_timezone,due_text,due_precision,completed_at,dismissed_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${COMMITMENT_COLUMNS}`,[newId,claim.userId,value.title,value.subject,value.status,value.priority,value.dueAt,value.dueTimezone,value.dueText,value.duePrecision,value.status==="completed"?clock:null,value.status==="dismissed"?clock:null]);
          record=commitmentFromRow(result.rows[0]??{});createdCommitmentIds.push(record.id);
        }else{
          if(!target || !change.targetId) invalid("Invalid commitment target");
          const old=commitmentSchema.parse(target);
          if(old.status==="deleted" || (old.manualOverride && !["complete","dismiss"].includes(change.action))) invalid("Commitment is protected from extraction");
          if(old.manualOverride && (old.title!==value.title || old.subject!==value.subject || old.priority!==value.priority || old.dueAt!==value.dueAt ||
            old.dueTimezone!==value.dueTimezone || old.dueText!==value.dueText || old.duePrecision!==value.duePrecision)) invalid("Manual commitment details must be preserved");
          const validStatus=change.action==="update"?value.status===old.status:
            change.action==="complete"?old.status==="open"&&value.status==="completed":
              change.action==="dismiss"?old.status==="open"&&value.status==="dismissed":old.status!=="open"&&value.status==="open";
          if(!validStatus) invalid("Invalid commitment transition");
          if(change.action==="update" && old.title===value.title && old.subject===value.subject && old.priority===value.priority && old.dueAt===value.dueAt && old.dueTimezone===value.dueTimezone && old.dueText===value.dueText && old.duePrecision===value.duePrecision) continue;
          const scheduleChanged=value.dueAt!==old.dueAt || change.action==="reopen";
          const result=await client.query(`UPDATE commitments SET title=$3,subject=$4,status=$5,priority=$6,due_at=$7,due_timezone=$8,due_text=$9,due_precision=$10,
            version=$11,schedule_version=$12,completed_at=$13,dismissed_at=$14,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING ${COMMITMENT_COLUMNS}`,
            [claim.userId,old.id,value.title,value.subject,value.status,value.priority,value.dueAt,value.dueTimezone,value.dueText,value.duePrecision,nextCounter(old.version),scheduleChanged?nextCounter(old.scheduleVersion):old.scheduleVersion,value.status==="completed"?(old.completedAt??clock):null,value.status==="dismissed"?(old.dismissedAt??clock):null]);
          record=commitmentFromRow(result.rows[0]??{});updatedCommitmentIds.push(record.id);
          if(value.status!=="open" || scheduleChanged) await client.query("UPDATE commitment_logs SET canceled_at=now() WHERE user_id=$1 AND commitment_id=$2 AND emitted_at IS NULL AND canceled_at IS NULL",[claim.userId,old.id]);
        }
        const changeId=await addChange(client,{userId:claim.userId,commitmentId:record.id,jobId:claim.jobId,version:record.version,operation:change.action,actor:"reconciler",afterState:record});
        for(const source of sources) await client.query("INSERT INTO change_sources(user_id,change_id,transcript_part_id,evidence_text) VALUES($1,$2,$3,$4)",[claim.userId,changeId,source.partId,source.text]);
      }
    }
    await client.query("UPDATE voice_sessions SET applied_through=$3,updated_at=now() WHERE user_id=$1 AND id=$2",[claim.userId,claim.sessionId,claim.throughOrdinal]);
    await client.query("UPDATE reconciliation_jobs SET state='succeeded',claim_token=NULL,lease_until=NULL,base_mind_revision=NULL,finished_at=now(),updated_at=now() WHERE user_id=$1 AND id=$2",[claim.userId,claim.jobId]);
    const mindRevision=await advanceMindState(client,claim.userId);
    return {mindRevision,appliedThrough:claim.throughOrdinal,createdMemoryIds,updatedMemoryIds,createdCommitmentIds,updatedCommitmentIds};
  });
}
