export type VoicePhase="idle"|"requesting_permission"|"negotiating"|"waiting_for_capture"|"active"|"draining"|"closed"|"error";
export type VoiceSnapshot=Readonly<{phase:VoicePhase;sessionId:string|null;errorCode:string|null}>;
type SessionStatus=Readonly<{sessionId:string;state:"initializing"|"connecting"|"active"|"draining"|"closed"|"incomplete"|"failed";captureReady:boolean;errorCode:string|null}>;
type StartResponse=Readonly<{sessionId:string;sdpAnswer:string;state:"connecting"}>;

export interface MediaTrackLike {enabled:boolean;stop():void;}
export interface MediaStreamLike {getTracks():MediaTrackLike[];}
export interface DataChannelLike {readonly readyState:string;close():void;}
export interface PeerConnectionLike {
  connectionState:string;
  ontrack:((event:{streams:unknown[]})=>void)|null;
  createDataChannel(label:string):DataChannelLike;
  addTrack(track:MediaTrackLike,stream:MediaStreamLike):void;
  createOffer():Promise<{type:string;sdp?:string}>;
  setLocalDescription(description:{type:string;sdp?:string}):Promise<void>;
  setRemoteDescription(description:{type:"answer";sdp:string}):Promise<void>;
  close():void;
}
export interface VoiceEnvironment {
  getUserMedia():Promise<MediaStreamLike>;
  createPeerConnection():PeerConnectionLike;
  attachRemoteStream(stream:unknown):()=>void;
  request(path:string,init?:RequestInit):Promise<Response>;
  delay(milliseconds:number,signal?:AbortSignal):Promise<void>;
  randomUUID():string;
  timezone():string;
  now():number;
}

const terminal=(state:SessionStatus["state"])=>state==="closed"||state==="incomplete"||state==="failed";
const object=(value:unknown):Record<string,unknown>=>{if(typeof value!=="object"||value===null||Array.isArray(value)) throw new Error("invalid_server_response");return value as Record<string,unknown>;};
function parseStart(value:unknown):StartResponse {const row=object(value);if(typeof row.sessionId!=="string"||typeof row.sdpAnswer!=="string"||row.state!=="connecting") throw new Error("invalid_server_response");return {sessionId:row.sessionId,sdpAnswer:row.sdpAnswer,state:row.state};}
function parseStatus(value:unknown):SessionStatus {const row=object(value);const states=["initializing","connecting","active","draining","closed","incomplete","failed"] as const;
  if(typeof row.sessionId!=="string"||!states.some(state=>state===row.state)||typeof row.captureReady!=="boolean"||!(row.errorCode===null||typeof row.errorCode==="string")) throw new Error("invalid_server_response");
  return {sessionId:row.sessionId,state:row.state as SessionStatus["state"],captureReady:row.captureReady,errorCode:row.errorCode};}

async function json(response:Response):Promise<unknown> {const body=await response.json();if(!response.ok){const error=object(body).error;const code=typeof error==="object"&&error!==null&&"code" in error&&typeof error.code==="string"?error.code:"request_failed";throw new Error(code);}return body;}

export class VoiceSessionClient {
  private snapshot:VoiceSnapshot={phase:"idle",sessionId:null,errorCode:null};
  private listeners=new Set<(state:VoiceSnapshot)=>void>();
  private peer:PeerConnectionLike|null=null;private channel:DataChannelLike|null=null;private stream:MediaStreamLike|null=null;private microphone:MediaTrackLike|null=null;
  private detachAudio:(()=>void)|null=null;private sessionId:string|null=null;private lifecycle:AbortController|null=null;private heartbeat:AbortController|null=null;private startWork:Promise<void>|null=null;private stopWork:Promise<void>|null=null;private stopping=false;
  constructor(private readonly environment:VoiceEnvironment) {}
  get state():VoiceSnapshot{return this.snapshot;}
  subscribe(listener:(state:VoiceSnapshot)=>void):()=>void {this.listeners.add(listener);listener(this.snapshot);return()=>this.listeners.delete(listener);}
  private emit(phase:VoicePhase,errorCode:string|null=null):void {this.snapshot={phase,sessionId:this.sessionId,errorCode};for(const listener of this.listeners) listener(this.snapshot);}

  start():Promise<void> {
    if(this.startWork!==null) return this.startWork;
    if(!["idle","closed","error"].includes(this.snapshot.phase)) return Promise.reject(new Error("session_already_started"));
    this.startWork=this.startInternal().finally(()=>{this.startWork=null;});
    return this.startWork;
  }

  private async startInternal():Promise<void> {
    this.stopping=false;
    this.sessionId=null;
    const lifecycle=new AbortController();this.lifecycle=lifecycle;
    try {
      this.emit("requesting_permission");
      this.stream=await this.environment.getUserMedia();
      const track=this.stream.getTracks()[0];
      if(track===undefined) throw new Error("microphone_unavailable");
      this.microphone=track;track.enabled=false;
      lifecycle.signal.throwIfAborted();
      this.emit("negotiating");
      const peer=this.environment.createPeerConnection();this.peer=peer;
      peer.ontrack=event=>{this.detachAudio?.();this.detachAudio=this.environment.attachRemoteStream(event.streams[0]);};
      this.channel=peer.createDataChannel("oai-events");
      peer.addTrack(track,this.stream);
      const offer=await peer.createOffer();
      lifecycle.signal.throwIfAborted();
      if(typeof offer.sdp!=="string"||offer.sdp.length===0) throw new Error("invalid_local_offer");
      await peer.setLocalDescription(offer);
      lifecycle.signal.throwIfAborted();
      const response=await this.environment.request("/api/sessions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({startRequestId:this.environment.randomUUID(),sdpOffer:offer.sdp,timezone:this.environment.timezone()}),signal:this.lifecycle.signal});
      const started=parseStart(await json(response));this.sessionId=started.sessionId;this.emit("waiting_for_capture");
      await peer.setRemoteDescription({type:"answer",sdp:started.sdpAnswer});
      lifecycle.signal.throwIfAborted();
      const deadline=this.environment.now()+20_000;
      while(true){
        const status=await this.getStatus();
        if(terminal(status.state)) throw new Error(status.errorCode??status.state);
        if(status.captureReady&&peer.connectionState==="connected"&&this.channel.readyState==="open") break;
        if(this.environment.now()>=deadline) throw new Error("setup_timeout");
        await this.environment.delay(500,this.lifecycle.signal);
      }
      const active=parseStatus(await json(await this.environment.request(`/api/sessions/${this.sessionId}/activate`,{method:"POST",signal:this.lifecycle.signal})));
      lifecycle.signal.throwIfAborted();
      if(active.state!=="active") throw new Error("session_not_ready");
      track.enabled=true;this.emit("active");this.startHeartbeat();
    } catch(error) {
      const cancelled=this.stopping || lifecycle.signal.aborted;
      this.disableMicrophone();this.cleanupLocal();
      if(cancelled) return;
      this.emit("error",error instanceof Error?error.message:"session_failed");throw error;
    }
  }

  private async getStatus():Promise<SessionStatus> {if(this.sessionId===null) throw new Error("session_missing");return parseStatus(await json(await this.environment.request(`/api/sessions/${this.sessionId}`,{signal:this.lifecycle?.signal})));}
  private startHeartbeat():void {
    this.heartbeat=new AbortController();const signal=this.heartbeat.signal;
    void (async()=>{let failures=0;while(!signal.aborted){
      try {await this.environment.delay(5000,signal);if(signal.aborted) return;const status=parseStatus(await json(await this.environment.request(`/api/sessions/${this.sessionId}/heartbeat`,{method:"POST",signal})));
        failures=0;if(terminal(status.state)){this.disableMicrophone();this.cleanupLocal();this.emit("closed",status.errorCode);return;}}
      catch{if(signal.aborted)return;failures++;if(failures>=3){this.disableMicrophone();this.cleanupLocal();this.emit("error","backend_unreachable");return;}}
    }})();
  }

  stop():Promise<void> {
    if(this.stopWork!==null) return this.stopWork;
    this.stopping=true;this.lifecycle?.abort();
    this.stopWork=this.stopInternal().finally(()=>{this.stopWork=null;this.stopping=false;});return this.stopWork;
  }
  private async stopInternal():Promise<void> {
    this.disableMicrophone();this.heartbeat?.abort();this.emit("draining");
    const id=this.sessionId;
    if(id===null){this.lifecycle?.abort();this.cleanupLocal();this.emit("closed");return;}
    try {
      let status=parseStatus(await json(await this.environment.request(`/api/sessions/${id}/close`,{method:"POST"})));
      const deadline=this.environment.now()+12_000;
      while(!terminal(status.state)&&this.environment.now()<deadline){await this.environment.delay(500);status=parseStatus(await json(await this.environment.request(`/api/sessions/${id}`)));}
      this.cleanupLocal();this.emit("closed",status.errorCode);
    } catch(error){this.cleanupLocal();this.emit("error",error instanceof Error?error.message:"close_failed");throw error;}
  }
  dispose():void {
    this.stopping=true;this.disableMicrophone();this.lifecycle?.abort();this.heartbeat?.abort();
    if(this.sessionId!==null) void this.environment.request(`/api/sessions/${this.sessionId}/close`,{method:"POST",keepalive:true}).catch(()=>undefined);
    this.cleanupLocal();
  }
  private disableMicrophone():void {if(this.microphone!==null)this.microphone.enabled=false;}
  private cleanupLocal():void {this.lifecycle?.abort();this.heartbeat?.abort();this.detachAudio?.();this.detachAudio=null;this.stream?.getTracks().forEach(track=>track.stop());this.channel?.close();this.peer?.close();
    this.stream=null;this.microphone=null;this.channel=null;this.peer=null;}
}

export function createBrowserVoiceEnvironment():VoiceEnvironment {
  return {
    async getUserMedia(){return navigator.mediaDevices.getUserMedia({audio:true}) as unknown as MediaStreamLike;},
    createPeerConnection(){return new RTCPeerConnection() as unknown as PeerConnectionLike;},
    attachRemoteStream(stream){const audio=new Audio();audio.autoplay=true;if(stream!==undefined)audio.srcObject=stream as MediaStream;void audio.play().catch(()=>undefined);return()=>{audio.pause();audio.srcObject=null;};},
    request(path,init){return fetch(path,init);},
    delay(milliseconds,signal){return new Promise((resolve,reject)=>{
      const onAbort=()=>{clearTimeout(timer);reject(new DOMException("Aborted","AbortError"));};
      const timer=setTimeout(()=>{signal?.removeEventListener("abort",onAbort);resolve();},milliseconds);
      if(signal?.aborted)onAbort();else signal?.addEventListener("abort",onAbort,{once:true});
    });},
    randomUUID(){return crypto.randomUUID();},timezone(){return Intl.DateTimeFormat().resolvedOptions().timeZone;},now(){return Date.now();},
  };
}
