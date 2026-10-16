import { createHash } from "node:crypto";
import type pg from "pg";
import { counterSchema, uuidSchema, type UUID } from "../../src/contracts";
import { hashTranscriptInput } from "../../src/mind";
import { commitmentFromRow, COMMITMENT_COLUMNS, memoryFromRow, MEMORY_COLUMNS } from "../../src/mind/rows";

export const userId=uuidSchema.parse("00000000-0000-4000-8000-000000000001");
export const otherUserId=uuidSchema.parse("00000000-0000-4000-8000-000000000002");
export const sessionId=uuidSchema.parse("00000000-0000-4000-8000-000000000011");
export const itemId=uuidSchema.parse("00000000-0000-4000-8000-000000000021");
export const partId=uuidSchema.parse("00000000-0000-4000-8000-000000000031");
export const jobId=uuidSchema.parse("00000000-0000-4000-8000-000000000041");
export const claimToken=uuidSchema.parse("00000000-0000-4000-8000-000000000051");

export async function seedUser(pool:pg.Pool,id:UUID=userId,timezone="Asia/Kolkata") {
  await pool.query("INSERT INTO users(id,timezone) VALUES($1,$2)",[id,timezone]);
  await pool.query("INSERT INTO mind_state(user_id) VALUES($1)",[id]);
  return {userId:id};
}
export async function seedMemory(pool:pg.Pool,id:UUID=uuidSchema.parse(crypto.randomUUID()),owner:UUID=userId) {
  const result=await pool.query(`INSERT INTO memories(id,user_id,kind,subject,predicate,content) VALUES($1,$2,'semantic','Ananya','movie_preference','Ananya likes science fiction') RETURNING ${MEMORY_COLUMNS}`,[id,owner]);
  const record=memoryFromRow(result.rows[0]??{});
  await pool.query("INSERT INTO mind_changes(id,user_id,memory_id,entity_version,operation,actor,after_state) VALUES($1,$2,$3,1,'create','user',$4::jsonb)",[crypto.randomUUID(),owner,id,JSON.stringify(record)]);
  return record;
}
export async function seedCommitment(pool:pg.Pool,id:UUID=uuidSchema.parse(crypto.randomUUID()),owner:UUID=userId,dueAt:string|null=null) {
  const result=await pool.query(`INSERT INTO commitments(id,user_id,title,subject,due_at,due_timezone,due_text,due_precision)
    VALUES($1,$2,'Send presentation','Ananya',$3,$4,$5,$6) RETURNING ${COMMITMENT_COLUMNS}`,[id,owner,dueAt,dueAt?"Asia/Kolkata":null,dueAt?"tomorrow at nine":null,dueAt?"instant":"none"]);
  const record=commitmentFromRow(result.rows[0]??{});
  await pool.query("INSERT INTO mind_changes(id,user_id,commitment_id,entity_version,operation,actor,after_state) VALUES($1,$2,$3,1,'create','user',$4::jsonb)",[crypto.randomUUID(),owner,id,JSON.stringify(record)]);
  return record;
}
export async function seedRunningJob(pool:pg.Pool,text="I promised to send Ananya the presentation") {
  const textHash=createHash("sha256").update(text).digest("hex");
  const inputHash=hashTranscriptInput("Asia/Kolkata",[{ordinal:1,itemId,partId,contentIndex:0,textHash,timeAnchorAt:null}]);
  await pool.query(`INSERT INTO voice_sessions(id,user_id,session_seq,start_request_id,offer_hash,state,timezone,closed_at,ordered_through,sealed_through)
    VALUES($1,$2,1,$3,$4,'closed','Asia/Kolkata',now(),1,1)`,[sessionId,userId,crypto.randomUUID(),"a".repeat(64)]);
  await pool.query(`INSERT INTO transcript_items(id,user_id,session_id,provider_item_id,predecessor_known,ordinal,role,item_type,state,expected_parts,terminal_at)
    VALUES($1,$2,$3,'item_1',true,1,'user','message','complete',1,now())`,[itemId,userId,sessionId]);
  await pool.query(`INSERT INTO transcript_parts(id,user_id,item_id,content_index,kind,final_text,state,final_event_id,text_hash,completed_at)
    VALUES($1,$2,$3,0,'user_audio',$4,'complete','event_1',$5,now())`,[partId,userId,itemId,text,textHash]);
  await pool.query(`INSERT INTO reconciliation_jobs(id,user_id,session_id,from_ordinal,through_ordinal,input_hash,state,attempts,claim_token,lease_until,base_mind_revision,model,prompt_version,schema_version)
    VALUES($1,$2,$3,1,1,$4,'running',1,$5,now()+interval '10 minutes',0,'test-model','v1','1')`,[jobId,userId,sessionId,inputHash,claimToken]);
  return {userId,jobId,sessionId,claimToken,baseMindRevision:counterSchema.parse("0"),fromOrdinal:1,throughOrdinal:1,inputHash};
}
