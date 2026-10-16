import { DomainError, nowTimestamp, type Counter, type IngestResult, type UserScope, type UUID } from "../contracts";
import { normalizeServerEvent } from "./normalize";
import type { TranscriptIngestor } from "./index";
import { logOperational, safeErrorCode } from "../operational-log";

function eventField(payload:unknown,name:"type"|"event_id"):string {
  if(typeof payload!=="object"||payload===null||!(name in payload))return "unknown";
  const value=(payload as Record<string,unknown>)[name];
  return typeof value==="string"&&/^[a-zA-Z0-9_.-]{1,100}$/.test(value)?value:"unknown";
}

export class SerialTranscriptProcessor {
  private tail:Promise<void>=Promise.resolve();
  private pending=0;
  private stopped=false;
  private failure:unknown=null;
  constructor(private readonly ingestor:TranscriptIngestor,private readonly scope:UserScope,
    private readonly sessionId:UUID,private readonly epoch:Counter,private readonly capacity=1000) {
    if(!Number.isInteger(capacity) || capacity<1) throw new DomainError("invalid_input","Invalid queue capacity");
  }
  async push(payload:unknown):Promise<IngestResult|null> {
    if(this.stopped) throw new DomainError("capture_closed","Capture queue stopped");
    let normalized;
    try{normalized=normalizeServerEvent(payload,nowTimestamp(this.ingestor.clock()));}
    catch(error){
      logOperational("transcript","normalization_failed",{sessionId:this.sessionId,providerEventType:eventField(payload,"type"),eventId:eventField(payload,"event_id"),code:safeErrorCode(error)});
      this.stopped=true;
      this.failure=error;
      await this.tail;
      await this.ingestor.finishCapture(this.scope,this.sessionId,"integrity_error");
      throw error;
    }
    if(normalized.kind==="ignored") return null;
    if(this.pending>=this.capacity){
      logOperational("transcript","queue_overflow",{sessionId:this.sessionId,capacity:this.capacity});
      this.stopped=true;
      const error=new DomainError("capture_closed","Transcript queue overflow");
      this.failure=error;
      await this.tail;
      await this.ingestor.finishCapture(this.scope,this.sessionId,"queue_overflow");
      throw error;
    }
    this.pending++;
    const task=this.tail.then(()=>this.ingestor.ingest(this.sessionId,this.epoch,normalized.event));
    this.tail=task.then(()=>{this.pending--;},async error=>{
      this.pending--;this.stopped=true;this.failure=error;
      try{await this.ingestor.finishCapture(this.scope,this.sessionId,"sideband_lost");}
      catch(closeError){this.failure=closeError;}
    });
    return task;
  }
  async drain():Promise<void> {
    await this.tail;
    if(this.failure!==null) throw this.failure;
  }
}
