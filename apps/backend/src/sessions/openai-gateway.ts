import WebSocket, { type RawData } from "ws";
import { DomainError, providerIdentifierSchema, sdpSchema, type CreateCallInput, type RealtimeGateway, type SidebandConnection, type SidebandHandlers } from "../contracts";

type FetchLike=(input:string|URL,init?:RequestInit)=>Promise<Response>;
const CALLS_URL="https://api.openai.com/v1/realtime/calls";

function upstream(message:string,cause?:unknown):DomainError {return new DomainError("upstream_failure",message,undefined,cause===undefined?undefined:{cause});}

export class OpenAIRealtimeGateway implements RealtimeGateway {
  constructor(private readonly apiKey:string,private readonly fetchImpl:FetchLike=fetch,private readonly callsUrl=CALLS_URL) {}

  async createCall(input:CreateCallInput,signal:AbortSignal):Promise<Readonly<{callId:string;sdpAnswer:string}>> {
    const form=new FormData();
    form.set("sdp",sdpSchema.parse(input.sdpOffer));
    form.set("session",JSON.stringify(input.session));
    let response:Response;
    try { response=await this.fetchImpl(this.callsUrl,{method:"POST",headers:{Authorization:`Bearer ${this.apiKey}`},body:form,signal}); }
    catch(error){if(signal.aborted) throw new DomainError("setup_timeout","Realtime call setup timed out",undefined,{cause:error});throw upstream("Realtime call creation failed",error);}
    if(!response.ok) throw upstream("Realtime call creation was rejected");
    const answer=await response.text();
    if(!sdpSchema.safeParse(answer).success) throw upstream("Realtime returned invalid SDP");
    const rawLocation=response.headers.get("location");
    if(rawLocation===null) throw upstream("Realtime response omitted call location");
    let location:URL;
    try {location=new URL(rawLocation,CALLS_URL);} catch(error){throw upstream("Realtime returned invalid call location",error);}
    if(location.origin!==new URL(CALLS_URL).origin || location.search!=="" || location.hash!=="") throw upstream("Realtime returned invalid call location");
    const match=/^\/v1\/realtime\/calls\/([^/]+)$/.exec(location.pathname);
    const callId=match?.[1];
    if(callId===undefined || !providerIdentifierSchema.safeParse(callId).success) throw upstream("Realtime returned invalid call location");
    return {callId,sdpAnswer:answer};
  }

  connectSideband(callId:string,handlers:SidebandHandlers):SidebandConnection {
    providerIdentifierSchema.parse(callId);
    let resolveClosed!:()=>void;
    const closed=new Promise<void>(resolve=>{resolveClosed=resolve;});
    const socket=new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,{headers:{Authorization:`Bearer ${this.apiKey}`},maxPayload:1_048_576,handshakeTimeout:15_000});
    socket.on("open",handlers.onOpen);
    socket.on("message",(data:RawData,isBinary:boolean)=>{
      const bytes=Array.isArray(data)?Buffer.concat(data):Buffer.isBuffer(data)?data:Buffer.from(data as ArrayBuffer);
      handlers.onMessage(bytes.toString("utf8"),isBinary);
    });
    socket.on("error",handlers.onError);
    socket.on("close",(code:number)=>{resolveClosed();handlers.onClose(code);});
    return {send(payload:unknown){if(socket.readyState!==WebSocket.OPEN) throw upstream("Realtime sideband is not open");socket.send(JSON.stringify(payload));},
      close(){if(socket.readyState===WebSocket.OPEN || socket.readyState===WebSocket.CONNECTING) socket.close();},closed};
  }

  async hangup(callId:string,signal:AbortSignal):Promise<void> {
    providerIdentifierSchema.parse(callId);
    const response=await this.fetchImpl(`${CALLS_URL}/${encodeURIComponent(callId)}/hangup`,{method:"POST",headers:{Authorization:`Bearer ${this.apiKey}`},signal});
    if(!response.ok && response.status!==404) throw upstream("Realtime hangup failed");
  }
}
