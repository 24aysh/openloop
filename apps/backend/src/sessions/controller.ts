import { createHash } from "node:crypto";
import { DomainError, startSessionRequestSchema, type CloseReason, type RealtimeGateway, type RealtimeSettings,
  type SessionControllerContract, type SessionStateRecord, type SessionStatus, type SidebandConnection, type StartSessionRequest,
  type StartSessionResponse, type UserScope, type UUID } from "../contracts";
import { SerialTranscriptProcessor, TranscriptIngestor } from "../transcripts";
import { SessionRepository } from "./repository";
import { buildRealtimeSessionConfig, buildSidebandUpdate, parseEffectiveSession } from "./realtime-config";
import { parseSidebandMessage } from "./sideband";
import { logOperational, safeErrorCode } from "../operational-log";

type Runtime={session:SessionStateRecord;scope:UserScope;connection:SidebandConnection|null;processor:SerialTranscriptProcessor;opened:boolean;providerSaved:boolean;configAcknowledged:boolean;
  ready:boolean;intentionalClose:boolean;setupTimer:ReturnType<typeof setTimeout>|null;pending:Set<Promise<unknown>>;finalizing:Promise<void>|null;
  fatal:Readonly<{errorCode:string;reason:CloseReason}>|null};
type StartEntry={offerHash:string;promise:Promise<StartSessionResponse>;response:StartSessionResponse|null;expiresAt:number};

const terminal=(state:string)=>["closed","incomplete","failed"].includes(state);
const hashOffer=(offer:string)=>createHash("sha256").update(offer).digest("hex");
function sidebandEventMetadata(text:string,isBinary:boolean):Readonly<{providerEventType:string;eventId:string}> {
  if(isBinary)return {providerEventType:"binary",eventId:"unknown"};
  try{
    const value:unknown=JSON.parse(text);
    if(typeof value==="object"&&value!==null){
      const providerEventType="type" in value&&typeof value.type==="string"&&/^[a-z][a-z0-9_.]{0,79}$/.test(value.type)?value.type:"malformed";
      const eventId="event_id" in value&&typeof value.event_id==="string"&&/^[a-zA-Z0-9_.-]{1,100}$/.test(value.event_id)?value.event_id:"unknown";
      return {providerEventType,eventId};
    }
  }catch{}
  return {providerEventType:"malformed",eventId:"unknown"};
}

export class SessionController implements SessionControllerContract {
  private readonly runtimes=new Map<UUID,Runtime>();
  private readonly starts=new Map<string,StartEntry>();
  private shuttingDown=false;
  constructor(private readonly repository:SessionRepository,private readonly gateway:RealtimeGateway,private readonly ingestor:TranscriptIngestor,
    private readonly realtimeSettings:RealtimeSettings,private readonly clock:()=>Date=()=>new Date()) {}

  async start(scope:UserScope,rawRequest:StartSessionRequest):Promise<Readonly<{response:StartSessionResponse;replayed:boolean}>> {
    if(this.shuttingDown) throw new DomainError("service_unavailable","Backend is shutting down");
    const request=startSessionRequestSchema.parse(rawRequest);
    const offerHash=hashOffer(request.sdpOffer);
    const key=`${scope.userId}:${request.startRequestId}`;
    const existing=this.starts.get(key);
    if(existing){
      if(existing.offerHash!==offerHash) throw new DomainError("start_request_conflict","Start request was already used with another offer");
      if(existing.expiresAt===0 || this.clock().getTime()<=existing.expiresAt) return {response:await existing.promise,replayed:true};
      this.starts.delete(key);
    }
    const entry:StartEntry={offerHash,promise:Promise.resolve(null as never),response:null,expiresAt:0};
    entry.promise=this.startFresh(scope,request,offerHash).then(response=>{entry.response=response;entry.expiresAt=this.clock().getTime()+30_000;return response;});
    this.starts.set(key,entry);
    try{return {response:await entry.promise,replayed:false};}
    catch(error){this.starts.delete(key);throw error;}
  }

  private async startFresh(scope:UserScope,request:StartSessionRequest,offerHash:string):Promise<StartSessionResponse> {
    const reservation=await this.repository.reserve(scope,{startRequestId:request.startRequestId,offerHash,timezone:request.timezone});
    if(this.shuttingDown){if(reservation.created)await this.repository.failSetup(scope,reservation.session.id,"server_shutdown");throw new DomainError("service_unavailable","Backend is shutting down");}
    if(!reservation.created){
      if(reservation.offerHash!==offerHash) throw new DomainError("start_request_conflict","Start request was already used with another offer");
      await this.terminateExisting(reservation.session,"restart");
      throw new DomainError("restart_required","The previous SDP answer is no longer available");
    }
    let callId:string|null=null;
    try {
      const created=await this.gateway.createCall({sdpOffer:request.sdpOffer,session:buildRealtimeSessionConfig(this.realtimeSettings)},AbortSignal.timeout(10_000));
      callId=created.callId;
      if(this.shuttingDown) throw new DomainError("service_unavailable","Backend is shutting down");
      const bound=await this.repository.bindCall(scope,reservation.session.id,callId);
      if(this.shuttingDown) throw new DomainError("service_unavailable","Backend is shutting down");
      logOperational("session","started",{sessionId:bound.id});
      this.attachRuntime(scope,bound);
      return {sessionId:bound.id,sdpAnswer:created.sdpAnswer,state:"connecting"};
    } catch(error) {
      logOperational("session","setup_failed",{sessionId:reservation.session.id,code:safeErrorCode(error)});
      await this.repository.failSetup(scope,reservation.session.id,error instanceof DomainError && error.code==="setup_timeout"?"setup_timeout":"upstream_failure").catch(()=>undefined);
      if(callId!==null) await this.bestEffortHangup(callId);
      throw error;
    }
  }

  private attachRuntime(scope:UserScope,session:SessionStateRecord):void {
    const processor=new SerialTranscriptProcessor(this.ingestor,scope,session.id,session.captureEpoch,1000);
    const runtime:Runtime={session,scope,connection:null,processor,opened:false,providerSaved:false,configAcknowledged:false,ready:false,intentionalClose:false,setupTimer:null,pending:new Set(),finalizing:null,fatal:null};
    this.runtimes.set(session.id,runtime);
    logOperational("session","sideband_connecting",{sessionId:session.id});
    const remaining=Math.max(1,15_000-(this.clock().getTime()-session.createdAt.getTime()));
    runtime.setupTimer=setTimeout(()=>{void this.failRuntime(runtime,"setup_timeout","sideband_lost");},remaining);
    try {
      runtime.connection=this.gateway.connectSideband(session.callId!,{
        onOpen:()=>{runtime.opened=true;queueMicrotask(()=>{try{runtime.connection?.send(buildSidebandUpdate(this.realtimeSettings));}catch{void this.failRuntime(runtime,"sideband_protocol","sideband_lost");}});},
        onMessage:(text,isBinary)=>this.acceptMessage(runtime,text,isBinary),
        onError:error=>{logOperational("session","sideband_error",{sessionId:session.id,code:safeErrorCode(error)});
          void this.failRuntime(runtime,"sideband_closed","sideband_lost");},
        onClose:code=>{if(!runtime.intentionalClose){logOperational("session","sideband_closed",{sessionId:session.id,closeCode:code});
          void this.failRuntime(runtime,"sideband_closed","sideband_lost");}},
      });
    } catch {void this.failRuntime(runtime,"sideband_open_failed","sideband_lost");}
  }

  private acceptMessage(runtime:Runtime,text:string,isBinary:boolean):void {
    if(runtime.pending.size>=1000){void this.failRuntime(runtime,"queue_overflow","queue_overflow");return;}
    let work!:Promise<void>;
    work=this.handleMessage(runtime,text,isBinary).catch(error=>{
      logOperational("session","sideband_event_failed",{sessionId:runtime.session.id,...sidebandEventMetadata(text,isBinary),code:safeErrorCode(error)});
      void this.failRuntime(runtime,"sideband_protocol","sideband_lost");
    }).finally(()=>runtime.pending.delete(work));
    runtime.pending.add(work);
  }

  private async handleMessage(runtime:Runtime,text:string,isBinary:boolean):Promise<void> {
    const message=parseSidebandMessage(text,isBinary);
    if(message.kind==="provider_error") throw new DomainError("upstream_failure","Realtime sideband rejected an event");
    if(message.kind==="session_created" || message.kind==="session_updated"){
      const effective=parseEffectiveSession(message.session,this.realtimeSettings);
      await this.repository.saveProviderSession(runtime.scope,runtime.session.id,effective.id);
      runtime.providerSaved=true;
      if(message.kind==="session_updated"){
        if(!effective.matches) throw new DomainError("upstream_failure","Realtime effective configuration does not match");
        runtime.configAcknowledged=true;
      }
      if(runtime.opened && runtime.providerSaved && runtime.configAcknowledged){
        if(!runtime.ready)logOperational("session","sideband_ready",{sessionId:runtime.session.id});
        runtime.ready=true;
        if(runtime.setupTimer!==null){clearTimeout(runtime.setupTimer);runtime.setupTimer=null;}
      }
      return;
    }
    if(message.kind!=="event") return;
    const result=await runtime.processor.push(message.payload);
    if(result?.status==="capture_closed"){
      const current=await this.repository.getRecord(runtime.scope,runtime.session.id);
      if(!terminal(current.state)) throw new DomainError("capture_closed","Realtime event arrived before activation");
    }
  }

  async status(scope:UserScope,sessionId:UUID):Promise<SessionStatus> {
    const runtime=this.runtimes.get(sessionId);
    return this.repository.status(scope,sessionId,runtime?.ready===true && runtime.finalizing===null);
  }

  async activate(scope:UserScope,sessionId:UUID):Promise<SessionStatus> {
    const runtime=this.runtimes.get(sessionId);
    if(!runtime?.ready || runtime.finalizing!==null) throw new DomainError("session_not_ready","Capture is not ready");
    await this.repository.activate(scope,sessionId);
    runtime.session=await this.repository.getRecord(scope,sessionId);
    logOperational("session","active",{sessionId});
    return this.status(scope,sessionId);
  }

  async heartbeat(scope:UserScope,sessionId:UUID):Promise<SessionStatus> {
    await this.repository.heartbeat(scope,sessionId);
    return this.status(scope,sessionId);
  }

  async close(scope:UserScope,sessionId:UUID):Promise<SessionStatus> {
    const state=await this.repository.beginClose(scope,sessionId);
    logOperational("session","close_requested",{sessionId,state:state.state});
    const runtime=this.runtimes.get(sessionId);
    if(runtime) runtime.ready=false;
    if(state.state==="draining" && runtime) void this.progressClose(runtime);
    if(state.state==="failed" && runtime) void this.cleanupRuntime(runtime);
    return this.status(scope,sessionId);
  }

  private async progressClose(runtime:Runtime):Promise<void> {
    if(runtime.finalizing!==null) return runtime.finalizing;
    runtime.finalizing=(async()=>{
      await Promise.allSettled(runtime.pending);
      try {await runtime.processor.drain();} catch {runtime.fatal={errorCode:"sideband_closed",reason:"sideband_lost"};}
      if(runtime.fatal!==null){
        const result=await this.ingestor.finishCapture(runtime.scope,runtime.session.id,runtime.fatal.reason);
        const status=await this.repository.status(runtime.scope,runtime.session.id,false);
        logOperational("session","capture_ended",{sessionId:runtime.session.id,state:result.state,reason:result.reason,errorCode:status.errorCode,triggerCode:runtime.fatal.errorCode});
        await this.cleanupRuntime(runtime);return;
      }
      const result=await this.ingestor.finishCapture(runtime.scope,runtime.session.id,"clean");
      logOperational("session",result.state==="draining"?"capture_draining":"capture_ended",{sessionId:runtime.session.id,state:result.state,reason:result.reason});
      if(result.state!=="draining") await this.cleanupRuntime(runtime);
    })().finally(()=>{runtime.finalizing=null;});
    return runtime.finalizing;
  }

  private async failRuntime(runtime:Runtime,errorCode:string,reason:CloseReason):Promise<void> {
    runtime.fatal??={errorCode,reason};
    if(runtime.finalizing!==null) return runtime.finalizing;
    runtime.ready=false;
    runtime.finalizing=(async()=>{
      const current=await this.repository.getRecord(runtime.scope,runtime.session.id);
      if(["initializing","connecting"].includes(current.state)){
        await this.repository.failSetup(runtime.scope,runtime.session.id,runtime.fatal!.errorCode);
        logOperational("session","capture_ended",{sessionId:runtime.session.id,state:"failed",errorCode:runtime.fatal!.errorCode});
      }
      else if(["active","draining"].includes(current.state)){
        await Promise.allSettled(runtime.pending);
        try{await runtime.processor.drain();}catch{}
        const result=await this.ingestor.finishCapture(runtime.scope,runtime.session.id,runtime.fatal!.reason);
        const status=await this.repository.status(runtime.scope,runtime.session.id,false);
        logOperational("session","capture_ended",{sessionId:runtime.session.id,state:result.state,reason:result.reason,errorCode:status.errorCode,triggerCode:runtime.fatal!.errorCode});
      }
      else {
        const status=await this.repository.status(runtime.scope,runtime.session.id,false);
        logOperational("session","capture_ended",{sessionId:runtime.session.id,state:current.state,reason:status.closeReason,errorCode:status.errorCode,triggerCode:runtime.fatal!.errorCode});
      }
      await this.cleanupRuntime(runtime);
    })();
    return runtime.finalizing;
  }

  private async cleanupRuntime(runtime:Runtime):Promise<void> {
    runtime.intentionalClose=true;runtime.ready=false;
    if(runtime.setupTimer!==null){clearTimeout(runtime.setupTimer);runtime.setupTimer=null;}
    runtime.connection?.close();
    this.runtimes.delete(runtime.session.id);
    if(runtime.session.callId!==null) await this.bestEffortHangup(runtime.session.callId);
  }

  private async terminateExisting(session:SessionStateRecord,reason:CloseReason):Promise<void> {
    const runtime=this.runtimes.get(session.id);
    if(runtime){await this.failRuntime(runtime,"restart_required",reason);return;}
    if(["initializing","connecting"].includes(session.state)) await this.repository.failSetup({userId:session.userId},session.id,"restart_required");
    else if(["active","draining"].includes(session.state)) await this.ingestor.finishCapture({userId:session.userId},session.id,reason);
    if(session.callId!==null) await this.bestEffortHangup(session.callId);
  }

  private async bestEffortHangup(callId:string):Promise<void> {try{await this.gateway.hangup(callId,AbortSignal.timeout(5000));}catch{}}

  async tick():Promise<void> {
    const now=this.clock().getTime();
    for(const session of await this.repository.listOpen()){
      const runtime=this.runtimes.get(session.id);
      if(["initializing","connecting"].includes(session.state) && now-session.createdAt.getTime()>=15_000){
        if(runtime) await this.failRuntime(runtime,"setup_timeout","sideband_lost");else await this.repository.failSetup({userId:session.userId},session.id,"setup_timeout");
        continue;
      }
      if(session.state==="active"){
        if(session.lastClientHeartbeatAt===null || now-session.lastClientHeartbeatAt.getTime()>=15_000){if(runtime) await this.failRuntime(runtime,"browser_lost","browser_lost");continue;}
        if(session.activatedAt!==null && now-session.activatedAt.getTime()>=900_000){
          await this.repository.beginClose({userId:session.userId},session.id,"session_limit");if(runtime){runtime.ready=false;await this.progressClose(runtime);}continue;
        }
      }
      if(session.state==="draining"){
        if(session.lastClientHeartbeatAt!==null && now-session.lastClientHeartbeatAt.getTime()>=15_000){if(runtime) await this.failRuntime(runtime,"browser_lost","browser_lost");continue;}
        if(runtime) await this.progressClose(runtime);
      }
    }
  }

  async recoverAtStartup():Promise<void> {
    const open=await this.repository.listOpen();
    await this.ingestor.recoverOpenCaptures();
    await Promise.all(open.flatMap(session=>session.callId===null?[]:[this.bestEffortHangup(session.callId)]));
  }

  async drainForShutdown(timeoutMs=10_000):Promise<void> {
    this.shuttingDown=true;
    const open=await this.repository.listOpen();
    for(const session of open){
      const scope={userId:session.userId};
      if(["initializing","connecting"].includes(session.state)) await this.repository.failSetup(scope,session.id,"server_shutdown");
      else await this.repository.beginClose(scope,session.id,"server_shutdown");
      const runtime=this.runtimes.get(session.id);if(runtime)runtime.ready=false;
    }
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      await this.tick();
      if((await this.repository.listOpen()).length===0)break;
      await new Promise<void>(resolve=>setTimeout(resolve,Math.min(250,Math.max(1,deadline-Date.now()))));
    }
    for(const session of await this.repository.listOpen()){
      if(["active","draining"].includes(session.state)) await this.ingestor.finishCapture({userId:session.userId},session.id,"restart");
      else await this.repository.failSetup({userId:session.userId},session.id,"server_shutdown");
    }
    await this.shutdown();
  }

  async shutdown():Promise<void> {
    this.shuttingDown=true;
    for(const runtime of this.runtimes.values()) await this.failRuntime(runtime,"restart","restart");
  }
}
