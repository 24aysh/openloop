import type pg from "pg";
import { DomainError, jobSettingsSchema, uuidSchema, userScopeSchema, type BatchResult, type JobSettings, type UserScope, type UUID } from "../contracts";
import { withTransaction } from "../db/transaction";
import { hashTranscriptInput, type HashInputPart } from "../mind";
import { assemble } from "./assemble";
import { lockSession, TranscriptIntegrityError, type ItemRow, type SessionRow } from "./internal";

type BatchJob = BatchResult["jobs"][number];
async function allParts(client:pg.PoolClient,session:SessionRow,boundary:number):Promise<HashInputPart[]> {
  const result=await client.query<{ordinal:number;item_id:string;part_id:string;content_index:number;text_hash:string|null;time_anchor_at:Date|null}>(`
    SELECT i.ordinal,i.id AS item_id,p.id AS part_id,p.content_index,p.text_hash,i.time_anchor_at
    FROM transcript_items i JOIN transcript_parts p ON p.user_id=i.user_id AND p.item_id=i.id
    WHERE i.user_id=$1 AND i.session_id=$2 AND i.ordinal BETWEEN 1 AND $3 AND i.role='user'
    ORDER BY i.ordinal,p.content_index`,[session.user_id,session.id,boundary]);
  return result.rows.map(row=>{
    if(row.text_hash===null) throw new TranscriptIntegrityError();
    return {ordinal:row.ordinal,itemId:uuidSchema.parse(row.item_id),partId:uuidSchema.parse(row.part_id),contentIndex:row.content_index,textHash:row.text_hash,timeAnchorAt:row.time_anchor_at?.toISOString()??null};
  });
}
async function completeUser(client:pg.PoolClient,session:SessionRow,item:ItemRow):Promise<boolean> {
  if(item.role!=="user" || item.state!=="complete" || item.expected_parts===null || item.expected_parts<1) return false;
  const result=await client.query<{content_index:number;state:string;text_hash:string|null}>("SELECT content_index,state,text_hash FROM transcript_parts WHERE user_id=$1 AND item_id=$2 ORDER BY content_index",[session.user_id,item.id]);
  return result.rows.length===item.expected_parts && result.rows.every((part,index)=>part.content_index===index && part.state==="complete" && part.text_hash!==null);
}

export async function sealOne(client:pg.PoolClient,session:SessionRow,settings:JobSettings):Promise<BatchJob|null> {
  const chain=await assemble(client,session);
  let boundary=0;let users=0;
  for(const item of chain.slice(session.sealed_through)){
    if(item.role==="assistant") continue;
    if(item.role!=="user" || !(await completeUser(client,session,item))) break;
    users++;
    boundary=item.ordinal??0;
    if(users===20) break;
  }
  if(boundary===0) return null;
  for(const item of chain.filter(row=>row.role==="user" && row.ordinal!==null && row.ordinal>session.sealed_through && row.ordinal<=boundary)){
    if(item.time_anchor_at!==null) continue;
    const anchor=item.speech_stopped_at??item.committed_at;
    if(anchor!==null) await client.query("UPDATE transcript_items SET time_anchor_at=$3,updated_at=now() WHERE user_id=$1 AND id=$2",[session.user_id,item.id,anchor]);
  }
  const parts=await allParts(client,session,boundary);
  const hash=hashTranscriptInput(session.timezone,parts);
  const jobId=uuidSchema.parse(crypto.randomUUID());
  const fromOrdinal=session.sealed_through+1;
  await client.query(`INSERT INTO reconciliation_jobs(id,user_id,session_id,from_ordinal,through_ordinal,input_hash,model,prompt_version,schema_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[jobId,session.user_id,session.id,fromOrdinal,boundary,hash,settings.model,settings.promptVersion,settings.schemaVersion]);
  await client.query("UPDATE voice_sessions SET sealed_through=$3,updated_at=now() WHERE user_id=$1 AND id=$2",[session.user_id,session.id,boundary]);
  session.sealed_through=boundary;
  return {id:jobId,fromOrdinal,throughOrdinal:boundary};
}

export async function sealAll(client:pg.PoolClient,session:SessionRow,settings:JobSettings):Promise<BatchJob[]> {
  const jobs:BatchJob[]=[];
  while(true){const job=await sealOne(client,session,settings);if(!job) return jobs;jobs.push(job);}
}

export async function sealReadyPrefix(pool:pg.Pool,scope:UserScope,sessionId:UUID,_cause:"timer"|"close",settings:JobSettings):Promise<BatchResult> {
  userScopeSchema.parse(scope);uuidSchema.parse(sessionId);jobSettingsSchema.parse(settings);
  return withTransaction(pool,{isolation:"read committed"},async client=>{
    const session=await lockSession(client,sessionId,scope);
    if(!["active","draining"].includes(session.state)) throw new DomainError("capture_closed","Session is not capturing");
    const job=await sealOne(client,session,settings);
    return {jobs:job?[job]:[],orderedThrough:session.ordered_through,sealedThrough:session.sealed_through};
  });
}
