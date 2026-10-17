import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import type pg from "pg";
import type { AddressInfo } from "node:net";
import { DomainError, type RealtimeGateway, type SidebandConnection, type SidebandHandlers, type UUID } from "../../src/contracts";
import { errorResponse } from "../../src/http/error-response";
import { OpenAIRealtimeGateway, REALTIME_INSTRUCTIONS, SessionController, SessionRepository, buildRealtimeSessionConfig, createSessionRouter } from "../../src/sessions";
import { TranscriptIngestor } from "../../src/transcripts";
import { clearTestDatabase, createTestPool, prepareTestDatabase } from "../helpers/database";
import { seedUser, userId } from "../helpers/factories";

const settings={model:"gpt-realtime-test",transcriptionModel:"transcribe-test",voice:"marin",instructions:REALTIME_INSTRUCTIONS};
const jobSettings={model:"extract-test",promptVersion:"v1",schemaVersion:"1"};
const scope={userId};
const startRequest=(id=crypto.randomUUID(),offer="v=0\r\ns=openloop\r\n")=>({startRequestId:id as UUID,sdpOffer:offer,timezone:"Asia/Kolkata"});

class FakeGateway implements RealtimeGateway {
  createCount=0;hangups:string[]=[];handlers:SidebandHandlers|null=null;sent:unknown[]=[];callId="rtc_test";
  async createCall():Promise<{callId:string;sdpAnswer:string}>{this.createCount++;return {callId:this.callId,sdpAnswer:"v=0\r\ns=answer\r\n"};}
  connectSideband(_callId:string,handlers:SidebandHandlers):SidebandConnection {
    this.handlers=handlers;let resolve!:()=>void;const closed=new Promise<void>(done=>{resolve=done;});
    return {send:payload=>{this.sent.push(payload);},close:()=>{resolve();handlers.onClose(1000);},closed};
  }
  async hangup(callId:string):Promise<void>{this.hangups.push(callId);}
  open():void{this.handlers?.onOpen();}
  message(payload:unknown):void{this.handlers?.onMessage(JSON.stringify(payload),false);}
  disconnect():void{this.handlers?.onClose(1006);}
}

let pool:pg.Pool;let now:Date;const controllers:SessionController[]=[];
beforeAll(async()=>{pool=createTestPool();await prepareTestDatabase(pool);});
beforeEach(async()=>{await clearTestDatabase(pool);await seedUser(pool);now=new Date();});
afterEach(async()=>{for(const controller of controllers.splice(0)) await controller.shutdown();});
afterAll(async()=>{await pool.end();});

function setup(gateway=new FakeGateway()){
  const ingestor=new TranscriptIngestor(pool,jobSettings,()=>now);
  const repository=new SessionRepository(pool);
  const controller=new SessionController(repository,gateway,ingestor,settings,()=>now);controllers.push(controller);
  return {controller,gateway,repository,ingestor};
}
async function waitFor(check:()=>Promise<boolean>):Promise<void>{for(let index=0;index<100;index++){if(await check())return;await Bun.sleep(5);}throw new Error("Timed out waiting for state");}
async function ready(controller:SessionController,gateway:FakeGateway,request=startRequest()){
  const result=await controller.start(scope,request);gateway.open();await Bun.sleep(0);
  const effective={id:"sess_test",...buildRealtimeSessionConfig(settings)};
  gateway.message({type:"session.created",event_id:"event_created",session:effective});
  gateway.message({type:"session.updated",event_id:"event_updated",session:effective});
  await waitFor(async()=>(await controller.status(scope,result.response.sessionId)).captureReady);
  return {id:result.response.sessionId,result};
}

describe("session repository and controller",()=>{
  test("concurrent identical starts create one provider call and replay the answer",async()=>{
    const {controller,gateway}=setup();const request=startRequest();
    const [first,second]=await Promise.all([controller.start(scope,request),controller.start(scope,request)]);
    expect(gateway.createCount).toBe(1);expect(first.response).toEqual(second.response);expect([first.replayed,second.replayed]).toEqual([false,true]);
    await expect(controller.start(scope,{...request,sdpOffer:"v=0\r\ns=different\r\n"})).rejects.toMatchObject({code:"start_request_conflict"});
  });

  test("readiness requires the sideband configuration, then activation enables ingestion",async()=>{
    const {controller,gateway,ingestor}=setup();const request=startRequest();const started=await controller.start(scope,request);
    expect((await controller.status(scope,started.response.sessionId)).captureReady).toBe(false);
    gateway.open();await Bun.sleep(0);expect(gateway.sent).toHaveLength(1);
    const effective={id:"sess_test",...buildRealtimeSessionConfig(settings)};
    gateway.message({type:"session.created",session:effective});
    await Bun.sleep(5);expect((await controller.status(scope,started.response.sessionId)).captureReady).toBe(false);
    gateway.message({type:"session.updated",session:effective});
    await waitFor(async()=>(await controller.status(scope,started.response.sessionId)).captureReady);
    expect((await controller.activate(scope,started.response.sessionId)).state).toBe("active");
    gateway.message({type:"conversation.item.created",event_id:"e1",previous_item_id:null,item:{id:"u1",type:"message",role:"user",status:"completed",content:[{type:"input_audio"}]}});
    gateway.message({type:"conversation.item.input_audio_transcription.completed",event_id:"e2",item_id:"u1",content_index:0,transcript:"I will send it Friday"});
    await waitFor(async()=>Number((await pool.query<{count:string}>("SELECT count(*) AS count FROM transcript_parts WHERE state='complete'")).rows[0]?.count)===1);
    await ingestor.scanReadySessions();
    expect((await controller.status(scope,started.response.sessionId)).reconciliationBacklog).toBe(1);
    expect((await controller.status(scope,started.response.sessionId)).blockedReconciliationJobs).toBe(0);
    await pool.query("UPDATE reconciliation_jobs SET state='blocked',finished_at=now(),last_error_code='test_block' WHERE session_id=$1",[started.response.sessionId]);
    expect((await controller.status(scope,started.response.sessionId)).blockedReconciliationJobs).toBe(1);
  });

  test("clean close drains final text while a sideband loss is incomplete",async()=>{
    const first=setup();const {id}=await ready(first.controller,first.gateway);await first.controller.activate(scope,id);
    first.gateway.message({type:"conversation.item.created",event_id:"a1",previous_item_id:null,item:{id:"u1",type:"message",role:"user",status:"completed",content:[{type:"input_audio"}]}});
    first.gateway.message({type:"conversation.item.input_audio_transcription.completed",event_id:"a2",item_id:"u1",content_index:0,transcript:"remember this"});
    await waitFor(async()=>Number((await pool.query<{count:string}>("SELECT count(*) AS count FROM transcript_parts")).rows[0]?.count)===1);
    expect((await first.controller.close(scope,id)).state).toBe("draining");now=new Date(now.getTime()+2000);await first.controller.tick();
    expect((await first.controller.status(scope,id)).state).toBe("closed");

    await clearTestDatabase(pool);await seedUser(pool);now=new Date();
    const second=setup();const active=await ready(second.controller,second.gateway);await second.controller.activate(scope,active.id);second.gateway.disconnect();
    await waitFor(async()=>((await second.controller.status(scope,active.id)).state)==="incomplete");
    expect(second.gateway.hangups).toContain("rtc_test");
  });

  test("pre-activation close is failed and does not claim transcript completeness",async()=>{
    const {controller,gateway}=setup();const started=await controller.start(scope,startRequest());
    const status=await controller.close(scope,started.response.sessionId);
    expect(status).toMatchObject({state:"failed",captureReady:false,errorCode:"client_cancelled"});
    await waitFor(async()=>gateway.hangups.length===1);
  });

  test("setup and heartbeat watchdogs persist explicit failure states",async()=>{
    const connecting=setup();const started=await connecting.controller.start(scope,startRequest());
    now=new Date(now.getTime()+16_000);await connecting.controller.tick();
    expect(await connecting.controller.status(scope,started.response.sessionId)).toMatchObject({state:"failed",captureReady:false,errorCode:"setup_timeout"});
    expect(connecting.gateway.hangups).toContain("rtc_test");

    await clearTestDatabase(pool);await seedUser(pool);now=new Date();
    const active=setup();const prepared=await ready(active.controller,active.gateway);await active.controller.activate(scope,prepared.id);
    now=new Date(now.getTime()+16_000);await active.controller.tick();
    expect(await active.controller.status(scope,prepared.id)).toMatchObject({state:"incomplete",captureReady:false,errorCode:"browser_lost"});
  });

  test("the session duration limit performs a clean drain but retains its display code",async()=>{
    const {controller,gateway}=setup();const prepared=await ready(controller,gateway);await controller.activate(scope,prepared.id);
    now=new Date(now.getTime()+901_000);
    await pool.query("UPDATE voice_sessions SET last_client_heartbeat_at=$2 WHERE user_id=$1 AND id=$3",[userId,now,prepared.id]);
    await controller.tick();
    expect(await controller.status(scope,prepared.id)).toMatchObject({state:"closed",captureReady:false,closeReason:"clean",errorCode:"session_limit"});
  });

  test("startup recovery fences an unfinished call and hangs up its saved provider identity",async()=>{
    const repository=new SessionRepository(pool);const reserved=await repository.reserve(scope,{startRequestId:crypto.randomUUID() as UUID,offerHash:"c".repeat(64),timezone:"Asia/Kolkata"});
    await repository.bindCall(scope,reserved.session.id,"rtc_recover");
    const gateway=new FakeGateway();const {controller}=setup(gateway);await controller.recoverAtStartup();
    expect(await controller.status(scope,reserved.session.id)).toMatchObject({state:"incomplete",errorCode:"restart"});
    expect(gateway.hangups).toContain("rtc_recover");
  });

  test("shutdown exposes draining then fences an unfinished capture at its deadline",async()=>{
    const {controller,gateway}=setup();const {id}=await ready(controller,gateway);await controller.activate(scope,id);
    const work=controller.drainForShutdown(50);
    await waitFor(async()=>(await controller.status(scope,id)).state==="draining");
    await work;
    expect(await controller.status(scope,id)).toMatchObject({state:"incomplete",captureReady:false,errorCode:"restart"});
    expect(gateway.hangups).toContain("rtc_test");
    await expect(controller.start(scope,startRequest())).rejects.toMatchObject({code:"service_unavailable"});
  });

  test("status reports transcript gaps without exposing provider identities or text",async()=>{
    const {controller,gateway}=setup();const {id}=await ready(controller,gateway);
    await pool.query("INSERT INTO transcript_items(id,user_id,session_id,provider_item_id,role,state) VALUES($1,$2,$3,'provider_private','user','pending')",
      [crypto.randomUUID(),userId,id]);
    expect((await controller.status(scope,id)).transcriptGapCount).toBe(0);
    await pool.query("UPDATE transcript_items SET first_seen_at=now()-interval '31 seconds' WHERE session_id=$1",[id]);
    const status=await controller.status(scope,id);const serialized=JSON.stringify(status);
    expect(status.transcriptGapCount).toBe(1);
    expect(serialized).not.toContain("rtc_test");expect(serialized).not.toContain("sess_test");expect(Object.keys(status).sort()).toEqual([
      "appliedThrough","blockedReconciliationJobs","captureReady","closeReason","errorCode","orderedThrough","reconciliationBacklog","sealedThrough","sessionId","state","transcriptGapCount",
    ]);
  });

  test("status exposes an earlier blocked job when it stalls this session",async()=>{
    const repository=new SessionRepository(pool);
    const current=await repository.reserve(scope,{startRequestId:crypto.randomUUID() as UUID,offerHash:"b".repeat(64),timezone:"Asia/Kolkata"});
    await pool.query("UPDATE voice_sessions SET session_seq=2 WHERE id=$1",[current.session.id]);
    const earlierSession=crypto.randomUUID();
    await pool.query(`INSERT INTO voice_sessions(id,user_id,session_seq,start_request_id,offer_hash,state,timezone,closed_at)
      VALUES($1,$2,1,$3,$4,'closed','Asia/Kolkata',now())`,[earlierSession,userId,crypto.randomUUID(),"a".repeat(64)]);
    await pool.query(`INSERT INTO reconciliation_jobs(id,user_id,session_id,from_ordinal,through_ordinal,input_hash,state,finished_at,last_error_code,model,prompt_version,schema_version)
      VALUES($1,$2,$3,1,1,$4,'blocked',now(),'model_refusal','test-model','v1','1')`,[crypto.randomUUID(),userId,earlierSession,"a".repeat(64)]);
    await pool.query(`INSERT INTO reconciliation_jobs(id,user_id,session_id,from_ordinal,through_ordinal,input_hash,model,prompt_version,schema_version)
      VALUES($1,$2,$3,1,1,$4,'test-model','v1','1')`,[crypto.randomUUID(),userId,current.session.id,"b".repeat(64)]);
    expect(await repository.status(scope,current.session.id,false)).toMatchObject({reconciliationBacklog:1,blockedReconciliationJobs:1});
  });
});

describe("OpenAI gateway and HTTP routes",()=>{
  test("gateway sends multipart configuration and binds only an official Location",async()=>{
    const observed:{form?:FormData;authorization?:string|null}={};
    const gateway=new OpenAIRealtimeGateway("secret",async(_input,init)=>{observed.form=init?.body as FormData;observed.authorization=new Headers(init?.headers).get("authorization");
      return new Response("v=0\r\ns=answer\r\n",{status:201,headers:{Location:"/v1/realtime/calls/rtc_bound"}});});
    const result=await gateway.createCall({sdpOffer:"v=0\r\ns=offer\r\n",session:buildRealtimeSessionConfig(settings)},new AbortController().signal);
    expect(result.callId).toBe("rtc_bound");expect(observed.authorization).toBe("Bearer secret");expect(observed.form?.get("sdp")).toBe("v=0\r\ns=offer\r\n");
    expect(JSON.parse(String(observed.form?.get("session")))).toMatchObject({model:"gpt-realtime-test",tools:[]});
    const bad=new OpenAIRealtimeGateway("secret",async()=>new Response("v=0\r\n",{status:201,headers:{Location:"https://evil.example/v1/realtime/calls/rtc_bad"}}));
    await expect(bad.createCall({sdpOffer:"v=0\r\n",session:{}},new AbortController().signal)).rejects.toMatchObject({code:"upstream_failure"});
  });

  test("session routes return 201 then 200 for an idempotent replay",async()=>{
    const {controller}=setup();const app=express();app.use(createSessionRouter(controller,()=>scope));app.use(errorResponse);
    const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
    try{
      const port=(server.address() as AddressInfo).port;const request=startRequest();const url=`http://127.0.0.1:${port}/api/sessions`;
      const first=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request)});
      const second=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request)});
      expect(first.status).toBe(201);expect(second.status).toBe(200);expect(await first.json()).toEqual(await second.json());
      const invalid=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...request,callId:"browser_selected"})});
      expect(invalid.status).toBe(400);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });

  test("repository rejects a second live session for the same user",async()=>{
    const repository=new SessionRepository(pool);
    await repository.reserve(scope,{startRequestId:crypto.randomUUID() as UUID,offerHash:"a".repeat(64),timezone:"Asia/Kolkata"});
    await expect(repository.reserve(scope,{startRequestId:crypto.randomUUID() as UUID,offerHash:"b".repeat(64),timezone:"Asia/Kolkata"})).rejects.toBeInstanceOf(DomainError);
  });

  test("shutdown admission rejects new calls before provider setup",async()=>{
    const {controller,gateway}=setup();const app=express();app.use(createSessionRouter(controller,()=>scope,()=>false));app.use(errorResponse);
    const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
    try{
      const port=(server.address() as AddressInfo).port;
      const response=await fetch(`http://127.0.0.1:${port}/api/sessions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(startRequest())});
      expect(response.status).toBe(503);expect(await response.json()).toMatchObject({error:{code:"service_unavailable"}});
      expect(gateway.createCount).toBe(0);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
