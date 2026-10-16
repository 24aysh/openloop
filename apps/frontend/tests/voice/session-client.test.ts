import { describe, expect, test } from "bun:test";
import {
  VoiceSessionClient,
  type DataChannelLike,
  type MediaStreamLike,
  type MediaTrackLike,
  type PeerConnectionLike,
  type VoiceEnvironment,
} from "../../src/voice/session-client";

const sessionId="00000000-0000-4000-8000-000000000123";
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
const status=(state:"connecting"|"active"|"draining"|"closed"|"incomplete"|"failed",captureReady=false,errorCode:string|null=null)=>({
  sessionId,state,captureReady,orderedThrough:0,sealedThrough:0,appliedThrough:0,reconciliationBacklog:0,closeReason:null,errorCode,
});

class FakeTrack implements MediaTrackLike {enabled=true;stops=0;stop():void{this.stops++;}}
class FakeStream implements MediaStreamLike {constructor(readonly track:FakeTrack){}getTracks():MediaTrackLike[]{return [this.track];}}
class FakeChannel implements DataChannelLike {readyState="open";closes=0;close():void{this.closes++;}}
class FakePeer implements PeerConnectionLike {
  connectionState="connected";ontrack:((_event:{streams:unknown[]})=>void)|null=null;
  readonly channel=new FakeChannel();closes=0;localDescriptions=0;remoteDescriptions=0;
  createDataChannel():DataChannelLike{return this.channel;}
  addTrack():void{}
  async createOffer():Promise<{type:string;sdp:string}>{return {type:"offer",sdp:"v=0\r\ns=test-offer\r\n"};}
  async setLocalDescription():Promise<void>{this.localDescriptions++;}
  async setRemoteDescription():Promise<void>{this.remoteDescriptions++;}
  close():void{this.closes++;}
}

class FakeEnvironment implements VoiceEnvironment {
  readonly track=new FakeTrack();readonly stream=new FakeStream(this.track);readonly peer=new FakePeer();
  requests:string[]=[];clock=0;permissionError:Error|null=null;serverState:"connecting"|"active"|"draining"|"closed"|"incomplete"|"failed"="connecting";
  captureReady=true;activationStarted=false;activationRelease:(()=>void)|null=null;permissionRelease:(()=>void)|null=null;holdPermission=false;detachCalls=0;

  async getUserMedia():Promise<MediaStreamLike>{
    if(this.permissionError!==null)throw this.permissionError;
    if(this.holdPermission)await new Promise<void>(resolve=>{this.permissionRelease=resolve;});
    return this.stream;
  }
  createPeerConnection():PeerConnectionLike{return this.peer;}
  attachRemoteStream():()=>void{return()=>{this.detachCalls++;};}
  async request(path:string,init?:RequestInit):Promise<Response>{
    this.requests.push(`${init?.method??"GET"} ${path}`);
    if(path==="/api/sessions") return response({sessionId,sdpAnswer:"v=0\r\ns=test-answer\r\n",state:"connecting"},201);
    if(path.endsWith("/activate")){
      this.activationStarted=true;
      await new Promise<void>(resolve=>{this.activationRelease=resolve;});
      this.serverState="active";
      return response(status("active",true));
    }
    if(path.endsWith("/heartbeat")) return response(status(this.serverState,this.captureReady));
    if(path.endsWith("/close")){this.serverState="draining";return response(status("draining"),202);}
    if(path===`/api/sessions/${sessionId}`){
      if(this.serverState==="draining")this.serverState="closed";
      return response(status(this.serverState,this.captureReady));
    }
    return response({error:{code:"not_found",message:"not found"}},404);
  }
  delay(milliseconds:number,signal?:AbortSignal):Promise<void>{
    if(milliseconds<5000){this.clock+=milliseconds;return Promise.resolve();}
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(new DOMException("Aborted","AbortError"));return;}
      signal?.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true});
      void resolve;
    });
  }
  randomUUID():string{return "00000000-0000-4000-8000-000000000456";}
  timezone():string{return "Asia/Kolkata";}
  now():number{return this.clock;}
}

const waitFor=async(check:()=>boolean):Promise<void>=>{for(let attempt=0;attempt<100;attempt++){if(check())return;await Bun.sleep(1);}throw new Error("Timed out waiting for client state");};

describe("VoiceSessionClient",()=>{
  test("keeps the microphone disabled until backend activation succeeds",async()=>{
    const environment=new FakeEnvironment();const client=new VoiceSessionClient(environment);
    const start=client.start();
    await waitFor(()=>environment.activationStarted);
    expect(environment.track.enabled).toBe(false);
    expect(client.state.phase).toBe("waiting_for_capture");
    expect(environment.requests).toEqual([
      "POST /api/sessions",
      `GET /api/sessions/${sessionId}`,
      `POST /api/sessions/${sessionId}/activate`,
    ]);
    environment.activationRelease?.();await start;
    expect(environment.track.enabled).toBe(true);expect(client.state.phase).toBe("active");

    await client.stop();
    expect(environment.track.enabled).toBe(false);expect(environment.track.stops).toBe(1);
    expect(environment.peer.channel.closes).toBe(1);expect(environment.peer.closes).toBe(1);expect(client.state.phase).toBe("closed");
  });

  test("permission failure creates no backend session",async()=>{
    const environment=new FakeEnvironment();environment.permissionError=new Error("permission_denied");const client=new VoiceSessionClient(environment);
    await expect(client.start()).rejects.toThrow("permission_denied");
    expect(environment.requests).toEqual([]);expect(client.state).toMatchObject({phase:"error",sessionId:null,errorCode:"permission_denied"});
  });

  test("terminal backend state stops local media without activating",async()=>{
    const environment=new FakeEnvironment();environment.serverState="incomplete";environment.captureReady=false;const client=new VoiceSessionClient(environment);
    await expect(client.start()).rejects.toThrow("incomplete");
    expect(environment.track.enabled).toBe(false);expect(environment.track.stops).toBe(1);
    expect(environment.requests.some(request=>request.endsWith("/activate"))).toBe(false);
    expect(client.state).toMatchObject({phase:"error",errorCode:"incomplete"});
  });

  test("stop during microphone permission cannot create a backend session",async()=>{
    const environment=new FakeEnvironment();environment.holdPermission=true;const client=new VoiceSessionClient(environment);
    const start=client.start();await waitFor(()=>client.state.phase==="requesting_permission");
    await client.stop();environment.permissionRelease?.();await start;
    expect(environment.requests).toEqual([]);expect(environment.track.enabled).toBe(false);expect(environment.track.stops).toBe(1);
    expect(client.state.phase).toBe("closed");
  });

  test("dispose disables audio and sends a best-effort keepalive close",async()=>{
    const environment=new FakeEnvironment();const client=new VoiceSessionClient(environment);const start=client.start();
    await waitFor(()=>environment.activationStarted);environment.activationRelease?.();await start;
    client.dispose();
    await waitFor(()=>environment.requests.includes(`POST /api/sessions/${sessionId}/close`));
    expect(environment.track.enabled).toBe(false);expect(environment.track.stops).toBe(1);
    expect(environment.peer.channel.closes).toBe(1);expect(environment.peer.closes).toBe(1);
  });
});
