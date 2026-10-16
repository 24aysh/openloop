import type pg from "pg";
import { closeReasonSchema, jobSettingsSchema, nextCounter, counterSchema, uuidSchema, userScopeSchema,
  type CaptureSummary, type CloseReason, type Clock, type JobSettings, type UserScope, type UUID } from "../contracts";
import { withTransaction } from "../db/transaction";
import { sealAll, sealReadyPrefix } from "./batch";
import { lockSession, type SessionRow } from "./internal";

async function pendingUserInput(client:pg.PoolClient,session:SessionRow):Promise<boolean> {
  const result=await client.query<{id:string}>(`SELECT id FROM transcript_items WHERE user_id=$1 AND session_id=$2
    AND (ordinal IS NULL OR (role IN ('user','unknown') AND (ordinal>$3 OR state<>'complete'))) LIMIT 1`,[session.user_id,session.id,session.sealed_through]);
  return result.rows.length>0;
}
async function excludeSuffix(client:pg.PoolClient,session:SessionRow):Promise<void> {
  await client.query(`UPDATE transcript_parts SET state='excluded' WHERE user_id=$1 AND item_id IN
    (SELECT id FROM transcript_items WHERE user_id=$1 AND session_id=$2 AND role IN ('user','unknown') AND (ordinal IS NULL OR ordinal>$3))`,
  [session.user_id,session.id,session.sealed_through]);
  await client.query(`UPDATE transcript_items SET state='excluded',updated_at=now() WHERE user_id=$1 AND session_id=$2
    AND role IN ('user','unknown') AND (ordinal IS NULL OR ordinal>$3)`,[session.user_id,session.id,session.sealed_through]);
}
export async function finishCapture(pool:pg.Pool,scope:UserScope,sessionId:UUID,rawReason:CloseReason,settings:JobSettings,clock:Clock):Promise<CaptureSummary> {
  userScopeSchema.parse(scope);uuidSchema.parse(sessionId);const reason=closeReasonSchema.parse(rawReason);jobSettingsSchema.parse(settings);
  return withTransaction(pool,{isolation:"read committed"},async client=>{
    const session=await lockSession(client,sessionId,scope);
    if(["closed","incomplete","failed"].includes(session.state)) return {state:session.state==="closed"?"closed":"incomplete",sealedThrough:session.sealed_through,
      reason:session.state==="closed"?"clean":closeReasonSchema.safeParse(session.close_reason).data??reason};
    const now=clock();
    let closeReason:CloseReason=reason;
    let deadlineReached=false;
    if(reason==="clean") {
      const closeAt=session.close_requested_at?.getTime();
      const last=session.last_sideband_event_at?.getTime()??0;
      if(session.state!=="draining" || closeAt===undefined) return {state:"draining",sealedThrough:session.sealed_through,reason:null};
      deadlineReached=now.getTime()-closeAt>=10_000;
      if(now.getTime()-closeAt<1000 || now.getTime()-last<1000){
        if(!deadlineReached) return {state:"draining",sealedThrough:session.sealed_through,reason:null};
        closeReason="drain_timeout";
      }
    }
    await sealAll(client,session,settings);
    const pending=await pendingUserInput(client,session);
    if(reason==="clean" && pending && !deadlineReached) return {state:"draining",sealedThrough:session.sealed_through,reason:null};
    if(reason==="clean" && pending) closeReason="drain_timeout";
    const terminal=closeReason==="clean" && !pending?"closed":"incomplete";
    if(terminal==="incomplete") await excludeSuffix(client,session);
    const epoch=nextCounter(counterSchema.parse(session.capture_epoch));
    await client.query(`UPDATE voice_sessions SET state=$3,capture_epoch=$4,closed_at=now(),updated_at=now(),
      close_reason=$5,error_code=$6 WHERE user_id=$1 AND id=$2`,
    [session.user_id,session.id,terminal,epoch,terminal==="closed"?"clean":closeReason,terminal==="closed"?null:closeReason]);
    return {state:terminal,sealedThrough:session.sealed_through,reason:terminal==="closed"?"clean":closeReason};
  });
}

export async function recoverOpenCaptures(pool:pg.Pool,settings:JobSettings,clock:Clock):Promise<readonly CaptureSummary[]> {
  const result=await pool.query<{id:string;user_id:string}>("SELECT id,user_id FROM voice_sessions WHERE state IN ('initializing','connecting','active','draining') ORDER BY user_id,session_seq");
  const output:CaptureSummary[]=[];
  for(const row of result.rows) output.push(await finishCapture(pool,{userId:uuidSchema.parse(row.user_id)},uuidSchema.parse(row.id),"restart",settings,clock));
  return output;
}

export async function scanReadySessions(pool:pg.Pool,settings:JobSettings,clock:Clock):Promise<void> {
  const result=await pool.query<{id:string;user_id:string}>("SELECT id,user_id FROM voice_sessions WHERE state IN ('active','draining') ORDER BY user_id,session_seq");
  for(const row of result.rows){
    const sessionId=uuidSchema.parse(row.id),scope={userId:uuidSchema.parse(row.user_id)};
    try { await sealReadyPrefix(pool,scope,sessionId,"timer",settings); }
    catch(error){if(typeof error==="object" && error!==null && "code" in error && error.code==="capture_closed") continue;throw error;}
    const stale=await pool.query<{id:string}>(`SELECT i.id FROM transcript_items i JOIN voice_sessions s ON s.user_id=i.user_id AND s.id=i.session_id
      WHERE i.user_id=$1 AND i.session_id=$2 AND s.state='active'
      AND (i.ordinal IS NULL OR (i.role IN ('user','unknown') AND i.state<>'complete'))
      AND i.first_seen_at<=$3::timestamptz - interval '30 seconds' LIMIT 1`,
    [scope.userId,sessionId,clock().toISOString()]);
    if(stale.rows[0]) await finishCapture(pool,scope,sessionId,"gap_timeout",settings,clock);
  }
}
