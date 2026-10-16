import type pg from "pg";
import { DomainError, counterSchema, uuidSchema, userScopeSchema, type UserScope, type UUID } from "../contracts";

export class TranscriptIntegrityError extends Error {
  constructor(readonly detailCode: string) { super("Transcript integrity conflict"); this.name="TranscriptIntegrityError"; }
}
export type SessionRow = {
  id:string;user_id:string;timezone:string;state:string;capture_epoch:string;ordered_through:number;sealed_through:number;
  close_requested_at:Date|null;last_sideband_event_at:Date|null;close_reason:string|null;
};
export type ItemRow = {
  id:string;user_id:string;session_id:string;provider_item_id:string;predecessor_known:boolean;previous_item_id:string|null;
  ordinal:number|null;role:string;item_type:string|null;state:string;expected_parts:number|null;
  provider_response_id:string|null;first_seen_at:Date;committed_at:Date|null;time_anchor_at:Date|null;
  speech_started_at:Date|null;speech_stopped_at:Date|null;audio_start_ms:number|null;audio_end_ms:number|null;
};
export type PartRow = {
  id:string;user_id:string;item_id:string;content_index:number;kind:string;final_text:string|null;state:string;
  final_event_id:string|null;text_hash:string|null;completed_at:Date|null;error_code:string|null;
};
export const ITEM_SELECT=`id,user_id,session_id,provider_item_id,predecessor_known,previous_item_id,ordinal,role,item_type,state,expected_parts,provider_response_id,first_seen_at,committed_at,time_anchor_at,speech_started_at,speech_stopped_at,audio_start_ms,audio_end_ms`;
export const PART_SELECT=`id,user_id,item_id,content_index,kind,final_text,state,final_event_id,text_hash,completed_at,error_code`;

export async function lockSession(client:pg.PoolClient,sessionId:UUID,scope?:UserScope):Promise<SessionRow> {
  uuidSchema.parse(sessionId);
  if(scope) userScopeSchema.parse(scope);
  const owner=await client.query<{user_id:string}>("SELECT user_id FROM voice_sessions WHERE id=$1",[sessionId]);
  if(!owner.rows[0] || (scope && owner.rows[0].user_id!==scope.userId)) throw new DomainError("not_found","Session not found");
  const userId=uuidSchema.parse(owner.rows[0].user_id);
  const mind=await client.query("SELECT user_id FROM mind_state WHERE user_id=$1 FOR UPDATE",[userId]);
  if(!mind.rows[0]) throw new DomainError("not_found","User not found");
  const result=await client.query<SessionRow>(`SELECT id,user_id,timezone,state,capture_epoch,ordered_through,sealed_through,close_requested_at,last_sideband_event_at,close_reason FROM voice_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`,[sessionId,userId]);
  if(!result.rows[0]) throw new DomainError("not_found","Session not found");
  counterSchema.parse(result.rows[0].capture_epoch);
  return result.rows[0];
}
export async function getItem(client:pg.PoolClient,session:SessionRow,providerItemId:string):Promise<ItemRow|null> {
  const result=await client.query<ItemRow>(`SELECT ${ITEM_SELECT} FROM transcript_items WHERE user_id=$1 AND session_id=$2 AND provider_item_id=$3 FOR UPDATE`,[session.user_id,session.id,providerItemId]);
  return result.rows[0]??null;
}
export async function ensureItem(client:pg.PoolClient,session:SessionRow,providerItemId:string):Promise<{item:ItemRow;created:boolean}> {
  const old=await getItem(client,session,providerItemId);
  if(old) return {item:old,created:false};
  const id=uuidSchema.parse(crypto.randomUUID());
  const result=await client.query<ItemRow>(`INSERT INTO transcript_items(id,user_id,session_id,provider_item_id) VALUES($1,$2,$3,$4) RETURNING ${ITEM_SELECT}`,[id,session.user_id,session.id,providerItemId]);
  const item=result.rows[0];
  if(!item) throw new Error("Transcript item insert returned no row");
  return {item,created:true};
}
export async function getPart(client:pg.PoolClient,session:SessionRow,itemId:string,contentIndex:number):Promise<PartRow|null> {
  const result=await client.query<PartRow>(`SELECT ${PART_SELECT} FROM transcript_parts WHERE user_id=$1 AND item_id=$2 AND content_index=$3 FOR UPDATE`,[session.user_id,itemId,contentIndex]);
  return result.rows[0]??null;
}
