import type pg from "pg";
import { counterSchema, databaseTimestampSchema, DomainError, nextCounter, sessionStatusSchema, userScopeSchema, uuidSchema,
  voiceSessionStateSchema, type SessionStateRecord, type SessionStatus, type UserScope, type UUID } from "../contracts";
import { withTransaction } from "../db/transaction";

type Row={id:string;user_id:string;state:string;capture_epoch:string;call_id:string|null;realtime_session_id:string|null;created_at:Date;activated_at:Date|null;close_requested_at:Date|null;last_client_heartbeat_at:Date|null};
type ReserveRow=Row&{offer_hash:string};
const RECORD_COLUMNS="id,user_id,state,capture_epoch,call_id,realtime_session_id,created_at,activated_at,close_requested_at,last_client_heartbeat_at";

function record(row:Row):SessionStateRecord {
  return {id:uuidSchema.parse(row.id),userId:uuidSchema.parse(row.user_id),state:voiceSessionStateSchema.parse(row.state),captureEpoch:counterSchema.parse(row.capture_epoch),
    callId:row.call_id,realtimeSessionId:row.realtime_session_id,createdAt:new Date(databaseTimestampSchema.parse(row.created_at)),
    activatedAt:row.activated_at,closeRequestedAt:row.close_requested_at,lastClientHeartbeatAt:row.last_client_heartbeat_at};
}

export class SessionRepository {
  constructor(private readonly pool:pg.Pool) {}

  async reserve(scope:UserScope,input:Readonly<{startRequestId:UUID;offerHash:string;timezone:string}>):Promise<Readonly<{created:boolean;session:SessionStateRecord;offerHash:string}>> {
    userScopeSchema.parse(scope);
    return withTransaction(this.pool,{isolation:"read committed"},async client=>{
      const mind=await client.query<{next_session_seq:string}>("SELECT next_session_seq FROM mind_state WHERE user_id=$1 FOR UPDATE",[scope.userId]);
      if(!mind.rows[0]) throw new DomainError("not_found","User not found");
      const old=await client.query<ReserveRow>(`SELECT ${RECORD_COLUMNS},offer_hash FROM voice_sessions WHERE user_id=$1 AND start_request_id=$2`,[scope.userId,input.startRequestId]);
      if(old.rows[0]) return {created:false,session:record(old.rows[0]),offerHash:old.rows[0].offer_hash};
      const live=await client.query("SELECT id FROM voice_sessions WHERE user_id=$1 AND state IN ('initializing','connecting','active','draining') LIMIT 1",[scope.userId]);
      if(live.rows[0]) throw new DomainError("active_session_exists","Another voice session is active");
      const id=uuidSchema.parse(crypto.randomUUID());
      const sequence=counterSchema.parse(mind.rows[0].next_session_seq);
      await client.query("UPDATE mind_state SET next_session_seq=$2,updated_at=now() WHERE user_id=$1",[scope.userId,nextCounter(sequence)]);
      const inserted=await client.query<ReserveRow>(`INSERT INTO voice_sessions(id,user_id,session_seq,start_request_id,offer_hash,state,timezone)
        VALUES($1,$2,$3,$4,$5,'initializing',$6) RETURNING ${RECORD_COLUMNS},offer_hash`,[id,scope.userId,sequence,input.startRequestId,input.offerHash,input.timezone]);
      return {created:true,session:record(inserted.rows[0]!),offerHash:input.offerHash};
    });
  }

  private async locked(client:pg.PoolClient,scope:UserScope,sessionId:UUID):Promise<Row> {
    const mind=await client.query("SELECT user_id FROM mind_state WHERE user_id=$1 FOR UPDATE",[scope.userId]);
    if(!mind.rows[0]) throw new DomainError("not_found","Session not found");
    const result=await client.query<Row>(`SELECT ${RECORD_COLUMNS} FROM voice_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE`,[scope.userId,sessionId]);
    if(!result.rows[0]) throw new DomainError("not_found","Session not found");
    return result.rows[0];
  }

  async bindCall(scope:UserScope,sessionId:UUID,callId:string):Promise<SessionStateRecord> {
    return withTransaction(this.pool,{isolation:"read committed"},async client=>{
      const row=await this.locked(client,scope,sessionId);
      if(row.call_id!==null && row.call_id!==callId) throw new DomainError("version_conflict","Provider call already bound");
      if(row.state!=="initializing" && !(row.state==="connecting" && row.call_id===callId)) throw new DomainError("capture_closed","Session setup is closed");
      const result=await client.query<Row>(`UPDATE voice_sessions SET call_id=$3,state='connecting',updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING ${RECORD_COLUMNS}`,[scope.userId,sessionId,callId]);
      return record(result.rows[0]!);
    });
  }

  async saveProviderSession(scope:UserScope,sessionId:UUID,providerSessionId:string):Promise<void> {
    await withTransaction(this.pool,{isolation:"read committed"},async client=>{
      const row=await this.locked(client,scope,sessionId);
      if(row.realtime_session_id!==null && row.realtime_session_id!==providerSessionId) throw new DomainError("version_conflict","Provider session identity changed");
      if(["failed","closed","incomplete"].includes(row.state)) return;
      await client.query("UPDATE voice_sessions SET realtime_session_id=$3,updated_at=now() WHERE user_id=$1 AND id=$2",[scope.userId,sessionId,providerSessionId]);
    });
  }

  async activate(scope:UserScope,sessionId:UUID):Promise<void> {
    await withTransaction(this.pool,{isolation:"read committed"},async client=>{
      const row=await this.locked(client,scope,sessionId);
      if(row.state==="active") return;
      if(row.state!=="connecting" || row.realtime_session_id===null) throw new DomainError("session_not_ready","Session is not ready to activate");
      await client.query("UPDATE voice_sessions SET state='active',activated_at=now(),last_client_heartbeat_at=now(),updated_at=now() WHERE user_id=$1 AND id=$2",[scope.userId,sessionId]);
    });
  }

  async heartbeat(scope:UserScope,sessionId:UUID):Promise<void> {
    await withTransaction(this.pool,{isolation:"read committed"},async client=>{
      const row=await this.locked(client,scope,sessionId);
      if(["active","draining"].includes(row.state)) await client.query("UPDATE voice_sessions SET last_client_heartbeat_at=now(),updated_at=now() WHERE user_id=$1 AND id=$2",[scope.userId,sessionId]);
    });
  }

  async beginClose(scope:UserScope,sessionId:UUID,errorCode:string|null=null):Promise<SessionStateRecord> {
    return withTransaction(this.pool,{isolation:"read committed"},async client=>{
      const row=await this.locked(client,scope,sessionId);
      if(["closed","incomplete","failed","draining"].includes(row.state)) return record(row);
      if(["initializing","connecting"].includes(row.state)){
        const epoch=nextCounter(counterSchema.parse(row.capture_epoch));
        const result=await client.query<Row>(`UPDATE voice_sessions SET state='failed',capture_epoch=$3,closed_at=now(),updated_at=now(),close_reason='client_cancelled',error_code='client_cancelled'
          WHERE user_id=$1 AND id=$2 RETURNING ${RECORD_COLUMNS}`,[scope.userId,sessionId,epoch]);
        return record(result.rows[0]!);
      }
      const result=await client.query<Row>(`UPDATE voice_sessions SET state='draining',close_requested_at=COALESCE(close_requested_at,now()),last_client_heartbeat_at=now(),updated_at=now(),error_code=COALESCE($3,error_code)
        WHERE user_id=$1 AND id=$2 RETURNING ${RECORD_COLUMNS}`,[scope.userId,sessionId,errorCode]);
      return record(result.rows[0]!);
    });
  }

  async failSetup(scope:UserScope,sessionId:UUID,errorCode:string):Promise<void> {
    await withTransaction(this.pool,{isolation:"read committed"},async client=>{
      const row=await this.locked(client,scope,sessionId);
      if(["closed","incomplete","failed"].includes(row.state)) return;
      if(["active","draining"].includes(row.state)) throw new DomainError("version_conflict","Activated capture cannot become a setup failure");
      await client.query(`UPDATE voice_sessions SET state='failed',capture_epoch=$3,closed_at=now(),updated_at=now(),close_reason=$4,error_code=$4 WHERE user_id=$1 AND id=$2`,
        [scope.userId,sessionId,nextCounter(counterSchema.parse(row.capture_epoch)),errorCode]);
    });
  }

  async getRecord(scope:UserScope,sessionId:UUID):Promise<SessionStateRecord> {
    userScopeSchema.parse(scope);uuidSchema.parse(sessionId);
    const result=await this.pool.query<Row>(`SELECT ${RECORD_COLUMNS} FROM voice_sessions WHERE user_id=$1 AND id=$2`,[scope.userId,sessionId]);
    if(!result.rows[0]) throw new DomainError("not_found","Session not found");
    return record(result.rows[0]);
  }

  async status(scope:UserScope,sessionId:UUID,captureReady:boolean):Promise<SessionStatus> {
    const result=await this.pool.query<{id:string;state:string;ordered_through:number;sealed_through:number;applied_through:number;close_reason:string|null;error_code:string|null;backlog:number;blocked:number;transcript_gap_count:number}>(`
      SELECT s.id,s.state,s.ordered_through,s.sealed_through,s.applied_through,s.close_reason,s.error_code,
        count(j.id) FILTER (WHERE j.state IN ('pending','running','retry_wait','blocked'))::integer AS backlog,
        count(j.id) FILTER (WHERE j.state='blocked')::integer AS blocked,
        (SELECT count(*)::integer FROM transcript_items i WHERE i.user_id=s.user_id AND i.session_id=s.id
          AND (i.ordinal IS NULL OR (i.role IN ('user','unknown') AND i.state<>'complete'))) AS transcript_gap_count
      FROM voice_sessions s LEFT JOIN reconciliation_jobs j ON j.user_id=s.user_id AND j.session_id=s.id
      WHERE s.user_id=$1 AND s.id=$2 GROUP BY s.id`,[scope.userId,sessionId]);
    const row=result.rows[0];
    if(!row) throw new DomainError("not_found","Session not found");
    return sessionStatusSchema.parse({sessionId:row.id,state:row.state,captureReady,orderedThrough:row.ordered_through,sealedThrough:row.sealed_through,
      appliedThrough:row.applied_through,reconciliationBacklog:row.backlog,blockedReconciliationJobs:row.blocked,
      transcriptGapCount:row.transcript_gap_count,closeReason:row.close_reason,errorCode:row.error_code});
  }

  async listOpen():Promise<readonly SessionStateRecord[]> {
    const result=await this.pool.query<Row>(`SELECT ${RECORD_COLUMNS} FROM voice_sessions WHERE state IN ('initializing','connecting','active','draining') ORDER BY created_at`);
    return result.rows.map(record);
  }
}
