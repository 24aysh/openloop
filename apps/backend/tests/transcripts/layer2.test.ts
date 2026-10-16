import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type pg from "pg";
import { counterSchema, nowTimestamp, uuidSchema, type UUID } from "../../src/contracts";
import { MindReader, MindWriter } from "../../src/mind";
import { normalizeServerEvent, SerialTranscriptProcessor, TranscriptIngestor } from "../../src/transcripts";
import { createPool } from "../../src/db/pool";
import { clearTestDatabase, createTestPool, prepareTestDatabase } from "../helpers/database";
import { seedUser, userId } from "../helpers/factories";

let pool:pg.Pool;
let now=new Date("2026-10-16T00:00:00.000Z");
let ingestor:TranscriptIngestor;
const epoch=counterSchema.parse("1");
const settings={model:"test-model",promptVersion:"v1",schemaVersion:"1"};
const scope={userId};
beforeAll(async()=>{pool=createTestPool();await prepareTestDatabase(pool);});
beforeEach(async()=>{await clearTestDatabase(pool);now=new Date("2026-10-16T00:00:00.000Z");ingestor=new TranscriptIngestor(pool,settings,()=>now);});
afterAll(async()=>{await pool?.end();});

async function session(owner:UUID=userId):Promise<UUID> {
  await seedUser(pool,owner);
  const id=uuidSchema.parse(crypto.randomUUID());
  await pool.query(`INSERT INTO voice_sessions(id,user_id,session_seq,start_request_id,offer_hash,state,timezone,activated_at)
    VALUES($1,$2,1,$3,$4,'active','Asia/Kolkata',now())`,[id,owner,crypto.randomUUID(),"a".repeat(64)]);
  return id;
}
let eventNumber=0;
function provider(type:string,fields:Record<string,unknown>):Record<string,unknown> {return {type,event_id:`event_${++eventNumber}`,...fields};}
function item(itemId:string,previous:string|null|undefined,role="user",content:Record<string,unknown>[]=[{type:"input_audio"}]):Record<string,unknown> {
  return provider("conversation.item.created",{...(previous===undefined?{}:{previous_item_id:previous}),item:{id:itemId,type:"message",role,status:"completed",content}});
}
function final(itemId:string,text:string,index=0):Record<string,unknown> {return provider("conversation.item.input_audio_transcription.completed",{item_id:itemId,content_index:index,transcript:text});}
async function send(sessionId:UUID,payload:Record<string,unknown>) {
  const normalized=normalizeServerEvent(payload,nowTimestamp(now));
  expect(normalized.kind).toBe("event");
  if(normalized.kind!=="event") throw new Error("Expected event");
  return ingestor.ingest(sessionId,epoch,normalized.event);
}
async function rows(sessionId:UUID) {
  const [items,jobs,state]=await Promise.all([
    pool.query<{provider_item_id:string;ordinal:number|null;state:string;expected_parts:number|null;time_anchor_at:Date|null}>("SELECT provider_item_id,ordinal,state,expected_parts,time_anchor_at FROM transcript_items WHERE session_id=$1 ORDER BY ordinal NULLS LAST,provider_item_id",[sessionId]),
    pool.query<{id:string;from_ordinal:number;through_ordinal:number;input_hash:string;state:string}>("SELECT id,from_ordinal,through_ordinal,input_hash,state FROM reconciliation_jobs WHERE session_id=$1 ORDER BY from_ordinal",[sessionId]),
    pool.query<{state:string;ordered_through:number;sealed_through:number;capture_epoch:string}>("SELECT state,ordered_through,sealed_through,capture_epoch FROM voice_sessions WHERE id=$1",[sessionId]),
  ]);
  return {items:items.rows,jobs:jobs.rows,state:state.rows[0]!};
}

describe("normalization",()=>{
  test("distinguishes missing predecessor from confirmed root and discards deltas",()=>{
    const absent=normalizeServerEvent(item("u1",undefined),nowTimestamp(now));
    const root=normalizeServerEvent(item("u1",null),nowTimestamp(now));
    expect(absent.kind).toBe("event");expect(root.kind).toBe("event");
    if(absent.kind==="event" && absent.event.kind==="item") expect(absent.event.predecessorKnown).toBe(false);
    if(root.kind==="event" && root.event.kind==="item") expect(root.event).toMatchObject({predecessorKnown:true,previousItemId:null});
    expect(normalizeServerEvent(provider("conversation.item.input_audio_transcription.delta",{item_id:"u1",delta:"partial"}),nowTimestamp(now))).toEqual({kind:"ignored"});
    expect(normalizeServerEvent(provider("conversation.item.input_audio_transcription.segment",{item_id:"u1",text:"still partial"}),nowTimestamp(now))).toEqual({kind:"ignored"});
    expect(JSON.stringify(normalizeServerEvent(item("u1",null,"user",[{type:"input_audio",audio:"secret-audio"}]),nowTimestamp(now)))).not.toContain("secret-audio");
  });
  test("rejects malformed supported event without exposing text",()=>{
    expect(()=>normalizeServerEvent(provider("conversation.item.input_audio_transcription.completed",{item_id:"u1",content_index:-1,transcript:"private words"}),nowTimestamp(now))).toThrow("Malformed Realtime event");
  });
  test("optional response output metadata does not fabricate assistant text",()=>{
    const normalized=normalizeServerEvent(provider("response.done",{response:{id:"r1",status:"completed",output:[{id:"a1",type:"message",role:"assistant",content:[{type:"output_audio",transcript:"not proven complete"}]}]}}),nowTimestamp(now));
    expect(normalized.kind).toBe("event");
    if(normalized.kind==="event" && normalized.event.kind==="assistant_response") expect(normalized.event.items[0]?.status).toBe("in_progress");
    expect(normalizeServerEvent(provider("response.done",{response:{id:"r2",status:"failed"}}),nowTimestamp(now)).kind).toBe("event");
  });
});

describe("transcript ingestion and ordering",()=>{
  test("U2 final before U1 and assistant node yields ordered transcript and one compatible job",async()=>{
    const id=await session();
    await send(id,final("u2","I sent Ananya the presentation"));
    await send(id,item("u2","a1"));
    await send(id,item("a1","u1","assistant",[{type:"output_audio",transcript:"Okay"}]));
    expect((await ingestor.sealReadyPrefix(scope,id,"timer")).jobs).toEqual([]);
    await send(id,final("u1","I promised to send Ananya the presentation"));
    await send(id,item("u1",null));
    expect((await rows(id)).items.map(row=>[row.provider_item_id,row.ordinal])).toEqual([["u1",1],["a1",2],["u2",3]]);
    const batch=await ingestor.sealReadyPrefix(scope,id,"timer");
    expect(batch.jobs.map(job=>[job.fromOrdinal,job.throughOrdinal])).toEqual([[1,3]]);
    expect((await ingestor.sealReadyPrefix(scope,id,"timer")).jobs).toEqual([]);
    const job=(await rows(id)).jobs[0]!;
    const token=uuidSchema.parse(crypto.randomUUID());
    await pool.query("UPDATE reconciliation_jobs SET state='running',attempts=1,claim_token=$2,lease_until=now()+interval '10 minutes',base_mind_revision=0 WHERE id=$1",[job.id,token]);
    const writer=new MindWriter(pool);
    await writer.applyExtraction({userId,jobId:uuidSchema.parse(job.id),sessionId:id,claimToken:token,baseMindRevision:counterSchema.parse("0"),fromOrdinal:1,throughOrdinal:3,inputHash:job.input_hash},{changes:[]});
    expect((await rows(id)).state.sealed_through).toBe(3);
  });
  test("final before metadata is idempotent and conflicting text fences capture",async()=>{
    const id=await session();const first=final("u1","hello");
    expect((await send(id,first)).status).toBe("stored");
    expect((await send(id,first)).status).toBe("duplicate");
    await send(id,item("u1",null));
    const page=await new MindReader(pool).getTranscript(scope,id,{limit:50,cursor:null});
    expect(page.items[0]?.parts[0]?.finalText).toBe("hello");
    await expect(send(id,final("u1","different"))).rejects.toMatchObject({code:"invalid_input"});
    expect((await rows(id)).state).toMatchObject({state:"incomplete",capture_epoch:"2"});
    expect((await send(id,first)).status).toBe("capture_closed");
  });
  test("unknown root, missing predecessor, branch, and failed part never seal ambiguous text",async()=>{
    const id=await session();
    await send(id,item("u2","missing"));await send(id,final("u2","later"));
    expect((await rows(id)).state.ordered_through).toBe(0);
    await send(id,item("u1",undefined));await send(id,final("u1","earlier"));
    expect((await ingestor.sealReadyPrefix(scope,id,"timer")).jobs).toEqual([]);
    await send(id,item("u1",null));
    expect((await rows(id)).state.ordered_through).toBe(1);
    await send(id,provider("conversation.item.input_audio_transcription.failed",{item_id:"u3",content_index:0,error:{code:"audio_unintelligible",message:"private"}}));
    await send(id,item("u3","u1"));
    expect((await ingestor.sealReadyPrefix(scope,id,"timer")).jobs.map(job=>job.throughOrdinal)).toEqual([1]);
    await expect(send(id,item("u4","u1"))).rejects.toMatchObject({code:"invalid_input"});
    expect((await rows(id)).state.state).toBe("incomplete");
  });
  test("multi-part turns require all finals; empty final text is complete",async()=>{
    const id=await session();
    await send(id,item("u1",null,"user",[{type:"input_audio"},{type:"input_audio"}]));
    await send(id,final("u1","",0));
    expect((await ingestor.sealReadyPrefix(scope,id,"timer")).jobs).toEqual([]);
    await send(id,final("u1","send it",1));
    expect((await ingestor.sealReadyPrefix(scope,id,"timer")).jobs).toHaveLength(1);
    expect((await rows(id)).items[0]?.state).toBe("complete");
  });
  test("two users may reuse provider item IDs but evidence stays scoped",async()=>{
    const first=await session();const other=uuidSchema.parse(crypto.randomUUID());const second=await session(other);
    await send(first,item("same",null));await send(second,item("same",null));
    await send(first,final("same","first"));await send(second,final("same","second"));
    expect((await rows(first)).items[0]?.provider_item_id).toBe("same");
    expect((await rows(second)).items[0]?.provider_item_id).toBe("same");
    expect((await new MindReader(pool).getTranscript({userId:other},second,{limit:50,cursor:null})).items[0]?.parts[0]?.finalText).toBe("second");
  });
  test("a cycle and an extra final part are integrity failures",async()=>{
    const id=await session();
    await send(id,item("x","y"));
    await expect(send(id,item("y","x"))).rejects.toMatchObject({code:"invalid_input"});
    expect((await rows(id)).state.state).toBe("incomplete");
    const second=await session(uuidSchema.parse(crypto.randomUUID()));
    await send(second,item("one",null));
    await expect(send(second,final("one","unannounced second part",1))).rejects.toMatchObject({code:"invalid_input"});
    expect((await rows(second)).state.state).toBe("incomplete");
  });
  test("sealed user data cannot be moved by late metadata",async()=>{
    const id=await session();await send(id,item("u1",null));await send(id,final("u1","sealed"));
    await ingestor.sealReadyPrefix(scope,id,"timer");
    await expect(send(id,item("u1","someone_else"))).rejects.toMatchObject({code:"invalid_input"});
    const state=await rows(id);
    expect(state.state).toMatchObject({state:"incomplete",sealed_through:1});
    expect(state.jobs).toHaveLength(1);
  });
  test("late speech metadata cannot change a frozen input hash",async()=>{
    const id=await session();await send(id,item("u1",null));await send(id,final("u1","anchored later"));
    await ingestor.sealReadyPrefix(scope,id,"timer");
    const before=(await rows(id)).jobs[0]?.input_hash;
    await send(id,provider("input_audio_buffer.speech_stopped",{item_id:"u1",audio_end_ms:2000}));
    const after=await rows(id);
    expect(after.items[0]?.time_anchor_at).toBeNull();
    expect(after.jobs[0]?.input_hash).toBe(before);
    expect(after.state.state).toBe("active");
  });
  test("failed earlier user part blocks a complete later turn",async()=>{
    const id=await session();await send(id,item("u1",null));
    await send(id,provider("conversation.item.input_audio_transcription.failed",{item_id:"u1",content_index:0,error:{code:"no_speech"}}));
    await send(id,item("u2","u1"));await send(id,final("u2","I will do it"));
    expect((await ingestor.sealReadyPrefix(scope,id,"timer")).jobs).toEqual([]);
    expect((await rows(id)).state.ordered_through).toBe(2);
  });
  test("assistant completion then truncation retains order and ignores replayed final text",async()=>{
    const id=await session();
    await send(id,item("u1",null));await send(id,final("u1","hello"));
    await send(id,item("a1","u1","assistant",[{type:"output_audio"}]));
    const response=provider("response.done",{response:{id:"r1",status:"completed",output:[{id:"a1",type:"message",role:"assistant",status:"completed",content:[{type:"output_audio",transcript:"Hello back",audio:"private-audio"}]}]}});
    await send(id,response);
    expect((await new MindReader(pool).getTranscript(scope,id,{limit:50,cursor:null})).items[1]?.parts[0]?.finalText).toBe("Hello back");
    await send(id,provider("conversation.item.truncated",{item_id:"a1",content_index:0,audio_end_ms:500}));
    expect((await send(id,response)).status).toBe("duplicate");
    await send(id,item("u2","a1"));await send(id,final("u2","next"));
    expect((await ingestor.sealReadyPrefix(scope,id,"timer")).jobs.map(job=>job.throughOrdinal)).toEqual([3]);
    const transcript=await new MindReader(pool).getTranscript(scope,id,{limit:50,cursor:null});
    expect(transcript.items[1]?.item.state).toBe("interrupted");
    expect(transcript.items[1]?.parts[0]?.state).toBe("interrupted");
  });
});

describe("batch and capture lifecycle",()=>{
  test("batch cap is 20 user turns, and close drains the rest",async()=>{
    const id=await session();
    for(let i=1;i<=23;i++){await send(id,item(`u${i}`,i===1?null:`u${i-1}`));await send(id,final(`u${i}`,`turn ${i}`));}
    expect((await ingestor.sealReadyPrefix(scope,id,"timer")).jobs.map(job=>[job.fromOrdinal,job.throughOrdinal])).toEqual([[1,20]]);
    await pool.query("UPDATE voice_sessions SET state='draining',close_requested_at=$2,last_sideband_event_at=$2 WHERE id=$1",[id,new Date(now.getTime()-2000)]);
    expect((await ingestor.finishCapture(scope,id,"clean")).state).toBe("closed");
    expect((await rows(id)).jobs.map(job=>[job.from_ordinal,job.through_ordinal])).toEqual([[1,20],[21,23]]);
  });
  test("clean close waits for quiet, then excludes a missing suffix at timeout",async()=>{
    const id=await session();await send(id,item("u1",null));await send(id,final("u1","safe"));await send(id,item("u2","u1"));
    await pool.query("UPDATE voice_sessions SET state='draining',close_requested_at=$2 WHERE id=$1",[id,now]);
    expect((await ingestor.finishCapture(scope,id,"clean")).state).toBe("draining");
    now=new Date(now.getTime()+11_000);
    expect((await ingestor.finishCapture(scope,id,"drain_timeout")).state).toBe("incomplete");
    expect((await rows(id)).jobs.map(job=>job.through_ordinal)).toEqual([1]);
    expect((await rows(id)).items.find(row=>row.provider_item_id==="u2")?.state).toBe("excluded");
  });
  test("clean close remains draining while a known turn is pending before its deadline",async()=>{
    const id=await session();await send(id,item("u1",null));await send(id,final("u1","first"));await send(id,item("u2","u1"));
    await pool.query("UPDATE voice_sessions SET state='draining',close_requested_at=$2,last_sideband_event_at=$2 WHERE id=$1",[id,new Date(now.getTime()-2000)]);
    expect((await ingestor.finishCapture(scope,id,"clean")).state).toBe("draining");
    expect((await rows(id)).jobs.map(job=>job.through_ordinal)).toEqual([1]);
    await send(id,final("u2","second"));now=new Date(now.getTime()+2000);
    expect((await ingestor.finishCapture(scope,id,"clean")).state).toBe("closed");
    expect((await rows(id)).jobs.map(job=>job.through_ordinal)).toEqual([1,2]);
  });
  test("concurrent sealing creates one job and a failed insert rolls back its anchor",async()=>{
    const id=await session();await send(id,item("u1",null));await send(id,provider("input_audio_buffer.committed",{item_id:"u1",previous_item_id:null}));await send(id,final("u1","ready"));
    const otherPool=createPool(process.env.TEST_DATABASE_URL??"",2);
    try{
      const other=new TranscriptIngestor(otherPool,settings,()=>now);
      const results=await Promise.all([ingestor.sealReadyPrefix(scope,id,"timer"),other.sealReadyPrefix(scope,id,"timer")]);
      expect(results.flatMap(result=>result.jobs)).toHaveLength(1);
      expect((await rows(id)).jobs).toHaveLength(1);
    }finally{await otherPool.end();}
    const second=await session(uuidSchema.parse(crypto.randomUUID()));await send(second,item("v1",null));await send(second,provider("input_audio_buffer.committed",{item_id:"v1",previous_item_id:null}));await send(second,final("v1","ready"));
    await pool.query("INSERT INTO reconciliation_jobs(id,user_id,session_id,from_ordinal,through_ordinal,input_hash,model,prompt_version,schema_version) VALUES($1,$2,$3,1,1,$4,'test-model','v1','1')",[crypto.randomUUID(),(await pool.query<{user_id:string}>("SELECT user_id FROM voice_sessions WHERE id=$1",[second])).rows[0]?.user_id,second,"0".repeat(64)]);
    const secondScope={userId:uuidSchema.parse((await pool.query<{user_id:string}>("SELECT user_id FROM voice_sessions WHERE id=$1",[second])).rows[0]?.user_id)};
    await expect(ingestor.sealReadyPrefix(secondScope,second,"timer")).rejects.toThrow();
    const after=await rows(second);
    expect(after.state.sealed_through).toBe(0);expect(after.items[0]?.time_anchor_at).toBeNull();
  });
  test("timer gap and restart recover durable safe prefix once",async()=>{
    const id=await session();await send(id,item("u1",null));await send(id,final("u1","safe"));await send(id,item("u2","u1"));
    await pool.query("UPDATE transcript_items SET first_seen_at=$2 WHERE session_id=$1 AND provider_item_id='u2'",[id,new Date(now.getTime()-31_000)]);
    await ingestor.scanReadySessions();
    expect((await rows(id)).state.state).toBe("incomplete");
    expect((await rows(id)).jobs.map(job=>job.through_ordinal)).toEqual([1]);
    expect(await ingestor.recoverOpenCaptures()).toEqual([]);
    const next=await session(uuidSchema.parse(crypto.randomUUID()));await send(next,item("r1",null));await send(next,final("r1","recover"));
    expect((await ingestor.recoverOpenCaptures()).map(result=>result.state)).toEqual(["incomplete"]);
    expect((await rows(next)).jobs.map(job=>job.through_ordinal)).toEqual([1]);
    expect(await ingestor.recoverOpenCaptures()).toEqual([]);
    expect((await ingestor.finishCapture({userId:uuidSchema.parse((await pool.query<{user_id:string}>("SELECT user_id FROM voice_sessions WHERE id=$1",[next])).rows[0]?.user_id)},next,"clean")).reason).toBe("restart");
  });
  test("an orphan assistant ordering node also times out as a capture gap",async()=>{
    const id=await session();await send(id,item("a1","missing","assistant",[{type:"output_audio"}]));
    await pool.query("UPDATE transcript_items SET first_seen_at=$2 WHERE session_id=$1",[id,new Date(now.getTime()-31_000)]);
    await ingestor.scanReadySessions();
    expect((await rows(id)).state).toMatchObject({state:"incomplete",sealed_through:0});
  });
  test("queue ignores deltas and serially persists accepted events",async()=>{
    const id=await session();const queue=new SerialTranscriptProcessor(ingestor,scope,id,epoch,2);
    expect(await queue.push(provider("conversation.item.input_audio_transcription.delta",{item_id:"u1",delta:"untrusted"}))).toBeNull();
    const first=queue.push(final("u1","hello"));const second=queue.push(item("u1",null));
    await Promise.all([first,second]);await queue.drain();
    expect((await rows(id)).items[0]?.state).toBe("complete");
  });
  test("queue overflow fences capture after accepted writes drain",async()=>{
    const id=await session();const queue=new SerialTranscriptProcessor(ingestor,scope,id,epoch,1);
    const accepted=queue.push(item("u1",null));
    await expect(queue.push(final("u1","too late"))).rejects.toMatchObject({code:"capture_closed"});
    expect(await accepted).toMatchObject({status:"stored"});
    expect((await rows(id)).state.state).toBe("incomplete");
    await expect(queue.drain()).rejects.toMatchObject({code:"capture_closed"});
    await expect(queue.push(final("u1","still too late"))).rejects.toMatchObject({code:"capture_closed"});
  });
  test("malformed relevant events stop the queue without storing private text",async()=>{
    const id=await session();const queue=new SerialTranscriptProcessor(ingestor,scope,id,epoch,2);
    await expect(queue.push(provider("conversation.item.input_audio_transcription.completed",{item_id:"u1",content_index:-1,transcript:"private words"}))).rejects.toThrow("Malformed Realtime event");
    expect((await rows(id)).state.state).toBe("incomplete");
    expect((await pool.query("SELECT count(*) AS count FROM transcript_parts")).rows[0]?.count).toBe("0");
  });
});
