import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import express from "express";
import type pg from "pg";
import { commitmentValueSchema, counterSchema, memoryValueSchema, timestampSchema, uuidSchema } from "../../src/contracts";
import { errorResponse } from "../../src/http/error-response";
import { createMindRouter } from "../../src/http/mind-routes";
import { MindReader, MindWriter } from "../../src/mind";
import { createTestPool, prepareTestDatabase, clearTestDatabase } from "../helpers/database";
import { itemId, jobId, otherUserId, partId, seedCommitment, seedMemory, seedRunningJob, seedUser, sessionId, userId } from "../helpers/factories";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../scripts/migrate";

let pool:pg.Pool;
let reader:MindReader;
let writer:MindWriter;
beforeAll(async()=>{pool=createTestPool();await prepareTestDatabase(pool);reader=new MindReader(pool);writer=new MindWriter(pool);});
beforeEach(async()=>{await clearTestDatabase(pool);});
afterAll(async()=>{await pool?.end();});
const page={limit:50,cursor:null};
const counterVersion=(value:string)=>counterSchema.parse(value);

describe("migration and database constraints",()=>{
  test("migration is repeatable through its ledger and creates all domain tables",async()=>{
    await prepareTestDatabase(pool);
    const result=await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename");
    for(const table of ["users","mind_state","voice_sessions","transcript_items","transcript_parts","reconciliation_jobs","memories","commitments","mind_changes","change_sources","commitment_logs"]) expect(result.rows.map(row=>row.tablename)).toContain(table);
  });
  test("applied migration checksum drift is rejected",async()=>{
    await pool.query("UPDATE schema_migrations SET checksum=$1 WHERE version='0001_layer_1.sql'",["0".repeat(64)]);
    try {await expect(migrate(pool)).rejects.toThrow("Migration checksum mismatch");}
    finally {const content=await Bun.file("apps/backend/migrations/0001_layer_1.sql").text();await pool.query("UPDATE schema_migrations SET checksum=$1 WHERE version='0001_layer_1.sql'",[createHash("sha256").update(content).digest("hex")]);}
  });
  test("checks reject invalid priority, due tuple, and cross-user ownership",async()=>{
    await seedUser(pool);await seedUser(pool,otherUserId);
    await expect(pool.query("INSERT INTO commitments(id,user_id,title,priority) VALUES($1,$2,'x',4)",[crypto.randomUUID(),userId])).rejects.toThrow();
    await expect(pool.query("INSERT INTO commitments(id,user_id,title,due_precision) VALUES($1,$2,'x','date')",[crypto.randomUUID(),userId])).rejects.toThrow();
    const claim=await seedRunningJob(pool);
    await expect(pool.query("INSERT INTO transcript_parts(id,user_id,item_id,content_index,kind) VALUES($1,$2,$3,1,'user_audio')",[crypto.randomUUID(),otherUserId,itemId])).rejects.toThrow();
    expect(claim.sessionId).toBe(sessionId);
  });
  test("a user cannot have two live sessions or two running jobs",async()=>{
    await seedUser(pool);
    await pool.query("INSERT INTO voice_sessions(id,user_id,session_seq,start_request_id,offer_hash,state,timezone) VALUES($1,$2,1,$3,$4,'initializing','Asia/Kolkata')",[sessionId,userId,crypto.randomUUID(),"a".repeat(64)]);
    await expect(pool.query("INSERT INTO voice_sessions(id,user_id,session_seq,start_request_id,offer_hash,state,timezone) VALUES($1,$2,2,$3,$4,'initializing','Asia/Kolkata')",[crypto.randomUUID(),userId,crypto.randomUUID(),"b".repeat(64)])).rejects.toThrow();
    await pool.query("UPDATE voice_sessions SET state='closed',closed_at=now() WHERE id=$1",[sessionId]);
    const nextSession=uuidSchema.parse(crypto.randomUUID());
    await pool.query("INSERT INTO voice_sessions(id,user_id,session_seq,start_request_id,offer_hash,state,timezone,closed_at) VALUES($1,$2,2,$3,$4,'closed','Asia/Kolkata',now())",[nextSession,userId,crypto.randomUUID(),"b".repeat(64)]);
    for(const [index,id] of [sessionId,nextSession].entries()){
      const fields=[crypto.randomUUID(),userId,id,"c".repeat(64),crypto.randomUUID()];
      const insert=pool.query("INSERT INTO reconciliation_jobs(id,user_id,session_id,from_ordinal,through_ordinal,input_hash,state,claim_token,lease_until,base_mind_revision,model,prompt_version,schema_version) VALUES($1,$2,$3,1,1,$4,'running',$5,now()+interval '1 minute',0,'x','v1','1')",fields);
      if(index===0) await insert;else await expect(insert).rejects.toThrow();
    }
  });
});

describe("Mind reads and manual edits",()=>{
  test("snapshot includes tombstones and versioned edits retain provenance",async()=>{
    await seedUser(pool);const memory=await seedMemory(pool);const commitment=await seedCommitment(pool);
    const edited=await writer.editMemory({userId},memory.id,{expectedVersion:memory.version,content:"Ananya prefers science fiction"});
    expect(edited.version).toBe(counterVersion("2"));expect(edited.manualOverride).toBe(true);
    const provenance=await reader.getProvenance({userId},{type:"memory",id:memory.id});
    expect(provenance.map(change=>change.entityVersion)).toEqual([counterVersion("1"),counterVersion("2")]);
    expect(provenance[1]?.sources).toEqual([]);
    await expect(writer.editMemory({userId},memory.id,{expectedVersion:memory.version,content:"stale"})).rejects.toMatchObject({code:"version_conflict"});
    const deleted=await writer.deleteMemory({userId},memory.id,{expectedVersion:edited.version});
    expect(deleted.state).toBe("deleted");
    const snapshot=await reader.getSnapshot({userId});
    expect(snapshot.revision).toBe(counterVersion("2"));expect(snapshot.memories[0]?.state).toBe("deleted");expect(snapshot.commitments[0]?.id).toBe(commitment.id);
    expect((await reader.listMemories({userId},{...page})).items).toEqual([]);
  });
  test("commitment due changes increment schedule version; status changes do not",async()=>{
    await seedUser(pool);const first=await seedCommitment(pool);
    const rescheduled=await writer.editCommitment({userId},first.id,{expectedVersion:first.version,dueAt:timestampSchema.parse("2026-11-01T09:00:00+05:30"),dueTimezone:"Asia/Kolkata",dueText:"Nov 1 at nine",duePrecision:"instant"});
    expect(rescheduled.scheduleVersion).toBe(counterVersion("2"));
    const completed=await writer.editCommitment({userId},first.id,{expectedVersion:rescheduled.version,status:"completed"});
    expect(completed.scheduleVersion).toBe(counterVersion("2"));expect(completed.completedAt).not.toBeNull();
    const reopened=await writer.editCommitment({userId},first.id,{expectedVersion:completed.version,status:"open"});
    expect(reopened.scheduleVersion).toBe(counterVersion("3"));expect(reopened.completedAt).toBeNull();
  });
  test("no-op edits fail; override release is explicit",async()=>{
    await seedUser(pool);const memory=await seedMemory(pool);
    await expect(writer.editMemory({userId},memory.id,{expectedVersion:memory.version,content:memory.content})).rejects.toMatchObject({code:"invalid_input"});
    const edited=await writer.editMemory({userId},memory.id,{expectedVersion:memory.version,content:"Ananya likes documentaries"});
    const released=await writer.editMemory({userId},memory.id,{expectedVersion:edited.version,releaseManualOverride:true});
    expect(released.manualOverride).toBe(false);
    await expect(writer.editMemory({userId},memory.id,{expectedVersion:released.version,releaseManualOverride:true})).rejects.toMatchObject({code:"invalid_input"});
  });
  test("text search escapes wildcard characters",async()=>{
    await seedUser(pool);const memory=await seedMemory(pool);
    await writer.editMemory({userId},memory.id,{expectedVersion:memory.version,content:"Ananya likes 100% science fiction"});
    expect((await reader.listMemories({userId},{...page,text:"100%"})).items).toHaveLength(1);
    expect((await reader.listMemories({userId},{...page,text:"100_"})).items).toHaveLength(0);
  });
  test("late audit insertion failure rolls back the entity and Mind revision",async()=>{
    await seedUser(pool);const memory=await seedMemory(pool);
    await pool.query("INSERT INTO mind_changes(id,user_id,memory_id,entity_version,operation,actor,after_state) VALUES($1,$2,$3,2,'update','user',$4::jsonb)",[crypto.randomUUID(),userId,memory.id,JSON.stringify(memory)]);
    await expect(writer.editMemory({userId},memory.id,{expectedVersion:memory.version,content:"New wording"})).rejects.toThrow();
    const snapshot=await reader.getSnapshot({userId});expect(snapshot.revision).toBe(counterVersion("0"));expect(snapshot.memories[0]?.version).toBe(memory.version);
  });
  test("reads are user scoped and pagination is stable with tied dates",async()=>{
    await seedUser(pool);await seedUser(pool,otherUserId);
    const a=await seedMemory(pool);const b=await seedMemory(pool);await seedMemory(pool,undefined,otherUserId);
    await pool.query("UPDATE memories SET updated_at='2026-01-01T00:00:00Z' WHERE user_id=$1",[userId]);
    const first=await reader.listMemories({userId},{limit:1,cursor:null});
    const second=await reader.listMemories({userId},{limit:1,cursor:first.nextCursor});
    expect(new Set([...first.items,...second.items].map(item=>item.id))).toEqual(new Set([a.id,b.id]));
    await expect(reader.getProvenance({userId},{type:"memory",id:(await reader.listMemories({userId:otherUserId},{...page})).items[0]!.id})).rejects.toMatchObject({code:"not_found"});
    await expect(writer.editMemory({userId},(await reader.listMemories({userId:otherUserId},{...page})).items[0]!.id,{expectedVersion:counterVersion("1"),content:"cross-user"})).rejects.toMatchObject({code:"not_found"});
    await expect(reader.listMemories({userId},{limit:1,cursor:first.nextCursor,kind:"episodic"})).rejects.toMatchObject({code:"invalid_input"});
  });
  test("commitment pagination includes null due dates without duplicates",async()=>{
    await seedUser(pool);const a=await seedCommitment(pool);const b=await seedCommitment(pool);const c=await seedCommitment(pool,undefined,userId,"2026-11-01T00:00:00Z");
    const first=await reader.listCommitments({userId},{limit:1,cursor:null});
    const second=await reader.listCommitments({userId},{limit:1,cursor:first.nextCursor});
    const third=await reader.listCommitments({userId},{limit:1,cursor:second.nextCursor});
    expect([first,second,third].flatMap(page=>page.items.map(item=>item.id))).toEqual([c.id,...[a.id,b.id].sort()]);
  });
  test("commitment reads expose an emitted log only for the current schedule",async()=>{
    await seedUser(pool);const commitment=await seedCommitment(pool,undefined,userId,"2026-10-17T03:25:00Z");
    await pool.query(`INSERT INTO commitment_logs(id,user_id,commitment_id,schedule_version,commitment_version,due_at,eligible_at,priority,title_snapshot,batch_id,batch_position,emitted_at)
      VALUES($1,$2,$3,1,1,$4,$4,2,$5,$6,1,$4)`,[crypto.randomUUID(),userId,commitment.id,commitment.dueAt,commitment.title,crypto.randomUUID()]);
    expect((await reader.listCommitments({userId},page)).items[0]?.loggedAt).toBe(commitment.dueAt);
    await writer.editCommitment({userId},commitment.id,{expectedVersion:commitment.version,dueAt:timestampSchema.parse("2026-10-17T03:30:00Z")});
    expect((await reader.listCommitments({userId},page)).items[0]?.loggedAt).toBeNull();
  });
  test("transcript page uses ordinals and reports unplaced items as gaps",async()=>{
    await seedUser(pool);await seedRunningJob(pool);
    await pool.query("INSERT INTO transcript_items(id,user_id,session_id,provider_item_id,role,state,first_seen_at) VALUES($1,$2,$3,'later','user','pending',now()-interval '1 hour')",[crypto.randomUUID(),userId,sessionId]);
    const pageResult=await reader.getTranscript({userId},sessionId,{limit:1,cursor:null});
    expect(pageResult.items).toHaveLength(1);expect(pageResult.items[0]?.parts[0]?.id).toBe(partId);expect(pageResult.gaps).toHaveLength(1);
  });
  test("corrupt audit snapshots fail visibly",async()=>{
    await seedUser(pool);const memory=await seedMemory(pool);
    await pool.query("UPDATE mind_changes SET after_state='{}'::jsonb WHERE memory_id=$1",[memory.id]);
    await expect(reader.getProvenance({userId},{type:"memory",id:memory.id})).rejects.toThrow();
  });
});

describe("atomic extraction apply",()=>{
  test("creates source-backed commitment and advances job, cursor, Mind revision together",async()=>{
    await seedUser(pool);const claim=await seedRunningJob(pool);
    const value=commitmentValueSchema.parse({title:"Send Ananya the presentation",subject:"Ananya",status:"open",priority:2,dueAt:null,dueTimezone:null,dueText:null,duePrecision:"none"});
    const result=await writer.applyExtraction(claim,{changes:[{entity:"commitment",action:"create",targetId:null,expectedVersion:null,value,sources:[{transcriptPartId:partId,evidenceText:"promised to send Ananya"}]}]});
    expect(result.mindRevision).toBe(counterVersion("1"));expect(result.appliedThrough).toBe(1);expect(result.createdCommitmentIds).toHaveLength(1);
    const provenance=await reader.getProvenance({userId},{type:"commitment",id:result.createdCommitmentIds[0]!});
    expect(provenance[0]?.sources[0]?.transcriptPartId).toBe(partId);
    const job=await pool.query("SELECT state,claim_token FROM reconciliation_jobs WHERE id=$1",[jobId]);
    expect(job.rows[0]?.state).toBe("succeeded");expect(job.rows[0]?.claim_token).toBeNull();
  });
  test("empty changes still succeed and late stale worker changes zero rows",async()=>{
    await seedUser(pool);const claim=await seedRunningJob(pool);
    const wrong={...claim,claimToken:uuidSchema.parse(crypto.randomUUID())};
    await expect(writer.applyExtraction(wrong,{changes:[]})).rejects.toMatchObject({code:"stale_claim"});
    const result=await writer.applyExtraction(claim,{changes:[]});expect(result.mindRevision).toBe(counterVersion("1"));
    await expect(writer.applyExtraction(claim,{changes:[]})).rejects.toMatchObject({code:"stale_claim"});
    const snapshot=await reader.getSnapshot({userId});expect(snapshot.revision).toBe(counterVersion("1"));
  });
  test("invalid evidence rolls back all mutations",async()=>{
    await seedUser(pool);const claim=await seedRunningJob(pool);
    const value=commitmentValueSchema.parse({title:"Send presentation",subject:null,status:"open",priority:2,dueAt:null,dueTimezone:null,dueText:null,duePrecision:"none"});
    await expect(writer.applyExtraction(claim,{changes:[{entity:"commitment",action:"create",targetId:null,expectedVersion:null,value,sources:[{transcriptPartId:partId,evidenceText:"words not spoken"}]}]})).rejects.toMatchObject({code:"invalid_input"});
    const result=await pool.query("SELECT (SELECT count(*) FROM commitments) AS commitments,(SELECT revision FROM mind_state WHERE user_id=$1) AS revision,(SELECT state FROM reconciliation_jobs WHERE id=$2) AS state",[userId,jobId]);
    expect(result.rows[0]).toMatchObject({commitments:"0",revision:"0",state:"running"});
  });
  test("transcript text/hash disagreement rejects a job before any write",async()=>{
    await seedUser(pool);const claim=await seedRunningJob(pool);
    await pool.query("UPDATE transcript_parts SET final_text='changed after sealing' WHERE id=$1",[partId]);
    await expect(writer.applyExtraction(claim,{changes:[]})).rejects.toMatchObject({code:"stale_snapshot"});
    expect((await reader.getSnapshot({userId})).revision).toBe(counterVersion("0"));
  });
  test("assistant and cross-user transcript parts cannot serve as evidence",async()=>{
    await seedUser(pool);await seedUser(pool,otherUserId);const claim=await seedRunningJob(pool);
    const value=commitmentValueSchema.parse({title:"Send presentation",subject:null,status:"open",priority:2,dueAt:null,dueTimezone:null,dueText:null,duePrecision:"none"});
    const assistantPart=uuidSchema.parse(crypto.randomUUID());
    const assistantItem=uuidSchema.parse(crypto.randomUUID());
    await pool.query("UPDATE voice_sessions SET ordered_through=2 WHERE id=$1",[sessionId]);
    await pool.query("INSERT INTO transcript_items(id,user_id,session_id,provider_item_id,predecessor_known,previous_item_id,ordinal,role,state,expected_parts) VALUES($1,$2,$3,'assistant',true,'item_1',2,'assistant','complete',1)",[assistantItem,userId,sessionId]);
    await pool.query("INSERT INTO transcript_parts(id,user_id,item_id,content_index,kind,final_text,state,final_event_id,text_hash,completed_at) VALUES($1,$2,$3,0,'assistant_text','send this','complete','event_assistant',$4,now())",[assistantPart,userId,assistantItem,createHash("sha256").update("send this").digest("hex")]);
    await expect(writer.applyExtraction(claim,{changes:[{entity:"commitment",action:"create",targetId:null,expectedVersion:null,value,sources:[{transcriptPartId:assistantPart,evidenceText:"send this"}]}]})).rejects.toMatchObject({code:"invalid_input"});
    const otherSession=uuidSchema.parse(crypto.randomUUID());
    const otherItem=uuidSchema.parse(crypto.randomUUID());
    const otherPart=uuidSchema.parse(crypto.randomUUID());
    await pool.query("INSERT INTO voice_sessions(id,user_id,session_seq,start_request_id,offer_hash,state,timezone,closed_at,ordered_through,sealed_through) VALUES($1,$2,1,$3,$4,'closed','Asia/Kolkata',now(),1,1)",[otherSession,otherUserId,crypto.randomUUID(),"b".repeat(64)]);
    await pool.query("INSERT INTO transcript_items(id,user_id,session_id,provider_item_id,predecessor_known,ordinal,role,state,expected_parts) VALUES($1,$2,$3,'other_item',true,1,'user','complete',1)",[otherItem,otherUserId,otherSession]);
    await pool.query("INSERT INTO transcript_parts(id,user_id,item_id,content_index,kind,final_text,state,final_event_id,text_hash,completed_at) VALUES($1,$2,$3,0,'user_audio','send this','complete','other_event',$4,now())",[otherPart,otherUserId,otherItem,createHash("sha256").update("send this").digest("hex")]);
    await expect(writer.applyExtraction(claim,{changes:[{entity:"commitment",action:"create",targetId:null,expectedVersion:null,value,sources:[{transcriptPartId:otherPart,evidenceText:"send this"}]}]})).rejects.toMatchObject({code:"invalid_input"});
  });
  test("a manual edit during inference rejects the old Mind revision",async()=>{
    await seedUser(pool);const memory=await seedMemory(pool);const claim=await seedRunningJob(pool);
    await writer.editMemory({userId},memory.id,{expectedVersion:memory.version,content:"Corrected by user"});
    await expect(writer.applyExtraction(claim,{changes:[]})).rejects.toMatchObject({code:"stale_snapshot"});
    expect((await reader.getSnapshot({userId})).memories[0]?.content).toBe("Corrected by user");
  });
  test("updates a memory with source history and rejects assistant evidence",async()=>{
    await seedUser(pool);const memory=await seedMemory(pool);const claim=await seedRunningJob(pool);
    const value=memoryValueSchema.parse({kind:"semantic",subject:"Ananya",predicate:"movie_preference",content:"Ananya prefers science fiction",occurredAt:null,timeText:null});
    const result=await writer.applyExtraction(claim,{changes:[{entity:"memory",action:"update",targetId:memory.id,expectedVersion:memory.version,value,sources:[{transcriptPartId:partId,evidenceText:"Ananya"}]}]});
    expect(result.updatedMemoryIds).toEqual([memory.id]);
    expect((await reader.getProvenance({userId},{type:"memory",id:memory.id})).length).toBe(2);
  });
  test("unchanged extraction proposal does not create another entity version",async()=>{
    await seedUser(pool);const memory=await seedMemory(pool);const claim=await seedRunningJob(pool);
    const value=memoryValueSchema.parse({kind:memory.kind,subject:memory.subject,predicate:memory.predicate,content:memory.content,occurredAt:memory.occurredAt,timeText:memory.timeText});
    const result=await writer.applyExtraction(claim,{changes:[{entity:"memory",action:"update",targetId:memory.id,expectedVersion:memory.version,value,sources:[{transcriptPartId:partId,evidenceText:"Ananya"}]}]});
    expect(result.updatedMemoryIds).toEqual([]);
    expect((await reader.getProvenance({userId},{type:"memory",id:memory.id}))).toHaveLength(1);
  });
  test("an extraction can delete a memory while preserving its earlier change",async()=>{
    await seedUser(pool);const memory=await seedMemory(pool);const claim=await seedRunningJob(pool);
    const result=await writer.applyExtraction(claim,{changes:[{entity:"memory",action:"delete",targetId:memory.id,expectedVersion:memory.version,value:null,sources:[{transcriptPartId:partId,evidenceText:"Ananya"}]}]});
    expect(result.updatedMemoryIds).toEqual([memory.id]);
    expect((await reader.getSnapshot({userId})).memories[0]?.state).toBe("deleted");
    expect((await reader.getProvenance({userId},{type:"memory",id:memory.id}))).toHaveLength(2);
  });
  test("completed commitment keeps its ID and exact log revision reference",async()=>{
    await seedUser(pool);const commitment=await seedCommitment(pool);const claim=await seedRunningJob(pool,"I sent Ananya the presentation");
    const value=commitmentValueSchema.parse({title:commitment.title,subject:commitment.subject,status:"completed",priority:2,dueAt:null,dueTimezone:null,dueText:null,duePrecision:"none"});
    const result=await writer.applyExtraction(claim,{changes:[{entity:"commitment",action:"complete",targetId:commitment.id,expectedVersion:commitment.version,value,sources:[{transcriptPartId:partId,evidenceText:"sent Ananya"}]}]});
    expect(result.updatedCommitmentIds).toEqual([commitment.id]);
    await pool.query("INSERT INTO commitment_logs(id,user_id,commitment_id,schedule_version,commitment_version,due_at,eligible_at,priority,title_snapshot,batch_id,batch_position) VALUES($1,$2,$3,1,2,now(),now(),2,'snapshot',$4,1)",[crypto.randomUUID(),userId,commitment.id,crypto.randomUUID()]);
    await expect(pool.query("INSERT INTO commitment_logs(id,user_id,commitment_id,schedule_version,commitment_version,due_at,eligible_at,priority,title_snapshot,batch_id,batch_position) VALUES($1,$2,$3,2,99,now(),now(),2,'bad',$4,2)",[crypto.randomUUID(),userId,commitment.id,crypto.randomUUID()])).rejects.toThrow();
  });
  test("expired claims and duplicate targets do not write",async()=>{
    await seedUser(pool);const memory=await seedMemory(pool);const claim=await seedRunningJob(pool);
    const value=memoryValueSchema.parse({kind:"semantic",subject:"Ananya",predicate:"movie_preference",content:"Changed",occurredAt:null,timeText:null});
    const change={entity:"memory" as const,action:"update" as const,targetId:memory.id,expectedVersion:memory.version,value,sources:[{transcriptPartId:partId,evidenceText:"Ananya"}]};
    await expect(writer.applyExtraction(claim,{changes:[change,change]})).rejects.toMatchObject({code:"invalid_input"});
    await pool.query("UPDATE reconciliation_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[jobId]);
    await expect(writer.applyExtraction(claim,{changes:[]})).rejects.toMatchObject({code:"stale_claim"});
    expect((await reader.getSnapshot({userId})).revision).toBe(counterVersion("0"));
  });
  test("changed claim hash and missing earlier cursor are rejected",async()=>{
    await seedUser(pool);const claim=await seedRunningJob(pool);
    await expect(writer.applyExtraction({...claim,inputHash:"a".repeat(64)},{changes:[]})).rejects.toMatchObject({code:"invalid_input"});
    await pool.query("UPDATE voice_sessions SET applied_through=1 WHERE id=$1",[sessionId]);
    await expect(writer.applyExtraction(claim,{changes:[]})).rejects.toMatchObject({code:"dependency_blocked"});
  });
  test("replacement claim wins; a late worker is fenced",async()=>{
    await seedUser(pool);const old=await seedRunningJob(pool);
    const replacement=uuidSchema.parse(crypto.randomUUID());
    await pool.query("UPDATE reconciliation_jobs SET claim_token=$2 WHERE id=$1",[jobId,replacement]);
    const secondPool=createPool(process.env.TEST_DATABASE_URL ?? "",2);
    try{const secondWriter=new MindWriter(secondPool);await secondWriter.applyExtraction({...old,claimToken:replacement},{changes:[]});}
    finally{await secondPool.end();}
    await expect(writer.applyExtraction(old,{changes:[]})).rejects.toMatchObject({code:"stale_claim"});
    expect((await reader.getSnapshot({userId})).revision).toBe(counterVersion("1"));
  });
});

describe("HTTP boundary",()=>{
  test("scopes reads, validates fields, and emits safe error bodies",async()=>{
    await seedUser(pool);const memory=await seedMemory(pool);await seedUser(pool,otherUserId);
    const app=express();app.use(express.json({limit:"32kb"}));app.use(createMindRouter(reader,writer,()=>({userId:otherUserId})));app.use(errorResponse);
    const server=app.listen(0,"127.0.0.1");
    try{
      const address=server.address();if(!address || typeof address==="string") throw new Error("No test port");
      const base=`http://127.0.0.1:${address.port}`;
      const list=await fetch(`${base}/api/mind/memories`);expect(list.status).toBe(200);expect((await list.json()).items).toEqual([]);
      const unknown=await fetch(`${base}/api/mind/memories?surprise=1`);expect(unknown.status).toBe(400);
      const wrongOwner=await fetch(`${base}/api/mind/${"memory"}/${memory.id}/provenance`);expect(wrongOwner.status).toBe(404);
      const malformed=await fetch(`${base}/api/commitments/not-a-uuid`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({expectedVersion:"1",title:"x"})});expect(malformed.status).toBe(400);
      const unknownBody=await fetch(`${base}/api/commitments/${crypto.randomUUID()}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({expectedVersion:"1",title:"x",extra:true})});expect(unknownBody.status).toBe(400);
    }finally{server.close();}
  });
});
