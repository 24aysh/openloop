import { createHash } from "node:crypto";
import type pg from "pg";
import { DomainError, counterSchema, normalizedEventSchema, uuidSchema, type Counter, type IngestResult, type NormalizedEvent, type UUID } from "../contracts";
import { withTransaction } from "../db/transaction";
import { assemble } from "./assemble";
import { getPart, ensureItem, lockSession, TranscriptIntegrityError, ITEM_SELECT, type ItemRow, type SessionRow } from "./internal";
import { finishCapture } from "./capture";
import { logOperational } from "../operational-log";

type Event = NormalizedEvent;
function sameOrUnknown<T>(current:T|null,incoming:T):boolean { return current===null || current===incoming; }
function mergeRole(current:string,incoming:string):string {
  if(current!=="unknown" && current!==incoming) throw new TranscriptIntegrityError("role_conflict");
  return incoming;
}
function mergePredecessor(item:ItemRow,event:{predecessorKnown:boolean;previousItemId:string|null}):{known:boolean;previous:string|null;changed:boolean} {
  if(!event.predecessorKnown) return {known:item.predecessor_known,previous:item.previous_item_id,changed:false};
  if(item.predecessor_known && item.previous_item_id!==event.previousItemId) throw new TranscriptIntegrityError("predecessor_conflict");
  return {known:true,previous:event.previousItemId,changed:!item.predecessor_known};
}
async function setItem(client:pg.PoolClient,session:SessionRow,item:ItemRow,values:Record<string,unknown>):Promise<void> {
  const entries=Object.entries(values);
  if(entries.length===0) return;
  const fields=entries.map(([name],index)=>`${name}=$${index+3}`).join(",");
  const updated=await client.query<ItemRow>(`UPDATE transcript_items SET ${fields},updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING ${ITEM_SELECT}`,[session.user_id,item.id,...entries.map(([,value])=>value)]);
  if(!updated.rows[0]) throw new Error("Transcript item update returned no row");
  Object.assign(item,updated.rows[0]);
}
async function refreshUserState(client:pg.PoolClient,session:SessionRow,item:ItemRow,at:string):Promise<boolean> {
  if(item.role!=="user") return false;
  const result=await client.query<{content_index:number;state:string}>("SELECT content_index,state FROM transcript_parts WHERE user_id=$1 AND item_id=$2 ORDER BY content_index",[session.user_id,item.id]);
  if(result.rows.some(part=>part.state==="failed")) {
    if(item.state!=="failed") { await setItem(client,session,item,{state:"failed",terminal_at:at});return true; }
    return false;
  }
  const complete=item.expected_parts!==null && item.expected_parts>0 && result.rows.length===item.expected_parts && result.rows.every((part,index)=>part.content_index===index && part.state==="complete");
  if(complete && item.state!=="complete") { await setItem(client,session,item,{state:"complete",terminal_at:at});return true; }
  return false;
}
async function saveFinalPart(client:pg.PoolClient,session:SessionRow,item:ItemRow,part:{contentIndex:number;kind:"user_audio"|"assistant_audio"|"assistant_text";text:string;eventId:string;at:string}):Promise<boolean> {
  const hash=createHash("sha256").update(part.text).digest("hex");
  const previous=await getPart(client,session,item.id,part.contentIndex);
  if(previous){
    if(previous.kind!==part.kind || previous.state!=="complete" || previous.text_hash!==hash || previous.final_text!==part.text) throw new TranscriptIntegrityError("final_part_conflict");
    return false;
  }
  if(item.role==="user" && item.ordinal!==null && item.ordinal<=session.sealed_through) throw new TranscriptIntegrityError("late_final_after_seal");
  await client.query(`INSERT INTO transcript_parts(id,user_id,item_id,content_index,kind,final_text,state,final_event_id,text_hash,completed_at)
    VALUES($1,$2,$3,$4,$5,$6,'complete',$7,$8,$9)`,[crypto.randomUUID(),session.user_id,item.id,part.contentIndex,part.kind,part.text,part.eventId,hash,part.at]);
  return true;
}
async function saveFailedPart(client:pg.PoolClient,session:SessionRow,item:ItemRow,event:Extract<Event,{kind:"user_failed"}>):Promise<boolean> {
  const previous=await getPart(client,session,item.id,event.contentIndex);
  if(previous){
    if(previous.kind!=="user_audio" || previous.state!=="failed" || previous.error_code!==event.errorCode) throw new TranscriptIntegrityError("failed_part_conflict");
    return false;
  }
  if(item.ordinal!==null && item.ordinal<=session.sealed_through) throw new TranscriptIntegrityError("late_failure_after_seal");
  await client.query(`INSERT INTO transcript_parts(id,user_id,item_id,content_index,kind,state,error_code)
    VALUES($1,$2,$3,$4,'user_audio','failed',$5)`,[crypto.randomUUID(),session.user_id,item.id,event.contentIndex,event.errorCode]);
  return true;
}
async function processEvent(client:pg.PoolClient,session:SessionRow,event:Event):Promise<{changed:boolean;itemId:UUID|null}> {
  if(event.kind==="deleted") throw new TranscriptIntegrityError("deleted_item");
  if(event.kind==="assistant_response") {
    let changed=false;
    for(const output of event.items){
      if(output.unsupported) throw new TranscriptIntegrityError("unsupported_response_item");
      const result=await ensureItem(client,session,output.itemId);const item=result.item;
      if(item.role!=="unknown" && item.role!=="assistant") throw new TranscriptIntegrityError("response_role_conflict");
      if(item.item_type!==null && item.item_type!=="message") throw new TranscriptIntegrityError("response_item_type_conflict");
      if(item.provider_response_id!==null && item.provider_response_id!==event.responseId) throw new TranscriptIntegrityError("response_id_conflict");
      const good=event.status==="completed" && output.status==="completed" && item.state!=="interrupted";
      const fields:Record<string,unknown>={};
      if(item.role!=="assistant") fields.role="assistant";
      if(item.item_type===null) fields.item_type="message";
      if(item.provider_response_id===null) fields.provider_response_id=event.responseId;
      const nextState=good?"complete":"interrupted";
      if(item.state!==nextState) {
        fields.state=nextState;fields.terminal_at=event.receivedAt;
      }
      await setItem(client,session,item,fields);
      changed ||=result.created || Object.keys(fields).length>0;
      if(good) for(const part of output.parts) changed=(await saveFinalPart(client,session,item,{...part,eventId:event.eventId,at:event.receivedAt}))||changed;
    }
    return {changed,itemId:null};
  }
  const result=await ensureItem(client,session,event.itemId);const item=result.item;
  const sealed=item.ordinal!==null && item.ordinal<=session.sealed_through;
  let changed=result.created;
  const fields:Record<string,unknown>={};
  if(event.kind==="item" || event.kind==="committed"){
    if(event.kind==="item" && event.unsupported) throw new TranscriptIntegrityError("unsupported_item");
    const link=mergePredecessor(item,event);
    if(link.changed){fields.predecessor_known=link.known;fields.previous_item_id=link.previous;}
    const role=event.kind==="committed"?"user":event.role;
    if(role!=="unknown" && item.role!==role) fields.role=mergeRole(item.role,role);
    if(event.kind==="item"){
      if(item.item_type!==null && item.item_type!==event.itemType) throw new TranscriptIntegrityError("item_type_conflict");
      if(item.item_type===null) fields.item_type=event.itemType;
      if(event.expectedParts!==null){
        if(!sameOrUnknown(item.expected_parts,event.expectedParts)) throw new TranscriptIntegrityError("part_count_conflict");
        const outside=await client.query("SELECT id FROM transcript_parts WHERE user_id=$1 AND item_id=$2 AND content_index>=$3 LIMIT 1",[session.user_id,item.id,event.expectedParts]);
        if(outside.rows[0]) throw new TranscriptIntegrityError("part_index_out_of_range");
        if(item.expected_parts===null) fields.expected_parts=event.expectedParts;
      }
    }else if(item.committed_at===null) fields.committed_at=event.receivedAt;
  }else if(event.kind==="speech"){
    if(item.role!=="user") fields.role=mergeRole(item.role,"user");
    const timeField=event.boundary==="started"?"speech_started_at":"speech_stopped_at";
    const offsetField=event.boundary==="started"?"audio_start_ms":"audio_end_ms";
    const currentOffset=item[offsetField];
    if(currentOffset!==null && currentOffset!==event.audioMs) throw new TranscriptIntegrityError("speech_offset_conflict");
    if(currentOffset===null){fields[offsetField]=event.audioMs;fields[timeField]=event.receivedAt;}
    if(event.boundary==="started" && item.audio_end_ms!==null && event.audioMs>item.audio_end_ms) throw new TranscriptIntegrityError("speech_range_conflict");
    if(event.boundary==="stopped" && item.audio_start_ms!==null && event.audioMs<item.audio_start_ms) throw new TranscriptIntegrityError("speech_range_conflict");
  }else if(event.kind==="user_final" || event.kind==="user_failed"){
    if(item.role!=="user") fields.role=mergeRole(item.role,"user");
    if(item.expected_parts!==null && event.contentIndex>=item.expected_parts) throw new TranscriptIntegrityError("part_index_out_of_range");
  }else if(event.kind==="truncated"){
    if(item.role!=="assistant") fields.role=mergeRole(item.role,"assistant");
    if(item.state!=="interrupted") {fields.state="interrupted";fields.terminal_at=event.receivedAt;}
    const part=await getPart(client,session,item.id,event.contentIndex);
    if(part && part.state!=="interrupted") await client.query("UPDATE transcript_parts SET state='interrupted' WHERE user_id=$1 AND id=$2",[session.user_id,part.id]);
    if(item.audio_end_ms!==null && item.audio_end_ms!==event.audioEndMs) throw new TranscriptIntegrityError("truncation_offset_conflict");
    if(item.audio_end_ms===null) fields.audio_end_ms=event.audioEndMs;
    changed ||=part!==null && part.state!=="interrupted";
  }
  if(sealed && item.role==="user" && Object.keys(fields).some(key=>!["speech_started_at","speech_stopped_at","audio_start_ms","audio_end_ms"].includes(key))) throw new TranscriptIntegrityError("sealed_item_changed");
  await setItem(client,session,item,fields);changed ||=Object.keys(fields).length>0;
  if(event.kind==="user_final") changed=(await saveFinalPart(client,session,item,{contentIndex:event.contentIndex,kind:"user_audio",text:event.text,eventId:event.eventId,at:event.receivedAt}))||changed;
  if(event.kind==="user_failed") changed=(await saveFailedPart(client,session,item,event))||changed;
  if(event.kind==="user_final" || event.kind==="user_failed" || event.kind==="item") changed=(await refreshUserState(client,session,item,event.receivedAt))||changed;
  if(event.kind==="truncated" && item.role==="user") throw new TranscriptIntegrityError("user_truncated");
  return {changed,itemId:uuidSchema.parse(item.id)};
}

export async function ingest(pool:pg.Pool,sessionId:UUID,epoch:Counter,rawEvent:NormalizedEvent,settings:{model:string;promptVersion:string;schemaVersion:string},clock:()=>Date):Promise<IngestResult> {
  uuidSchema.parse(sessionId);counterSchema.parse(epoch);
  const parsed=normalizedEventSchema.safeParse(rawEvent);
  if(!parsed.success) throw new DomainError("invalid_input","Invalid normalized event");
  try {
    return await withTransaction(pool,{isolation:"read committed"},async client=>{
      const session=await lockSession(client,sessionId);
      if(session.capture_epoch!==epoch || !["active","draining"].includes(session.state)) return {status:"capture_closed",sessionId,itemId:null};
      const {changed,itemId}=await processEvent(client,session,parsed.data);
      if(changed){
        await assemble(client,session);
        await client.query("UPDATE voice_sessions SET last_sideband_event_at=$3,updated_at=now() WHERE user_id=$1 AND id=$2",[session.user_id,session.id,parsed.data.receivedAt]);
      }
      return {status:changed?"stored":"duplicate",sessionId,itemId};
    });
  }catch(error){
    if(error instanceof TranscriptIntegrityError){
      logOperational("transcript","integrity_failed",{sessionId,eventKind:parsed.data.kind,eventId:parsed.data.eventId,detailCode:error.detailCode});
      await finishCapture(pool,{userId:uuidSchema.parse((await pool.query<{user_id:string}>("SELECT user_id FROM voice_sessions WHERE id=$1",[sessionId])).rows[0]?.user_id)},sessionId,"integrity_error",settings,clock);
      throw new DomainError("invalid_input","Transcript integrity conflict");
    }
    throw error;
  }
}
