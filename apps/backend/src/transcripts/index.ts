import type pg from "pg";
import { jobSettingsSchema, type BatchResult, type CaptureSummary, type CloseReason, type Clock, type Counter,
  type IngestResult, type JobSettings, type NormalizedEvent, type UserScope, type UUID } from "../contracts";
import { ingest } from "./ingest";
import { sealReadyPrefix } from "./batch";
import { finishCapture, recoverOpenCaptures, scanReadySessions } from "./capture";

export { normalizeServerEvent } from "./normalize";
export { SerialTranscriptProcessor } from "./queue";

export class TranscriptIngestor {
  readonly settings:JobSettings;
  constructor(private readonly pool:pg.Pool,settings:JobSettings,readonly clock:Clock=()=>new Date()) {
    this.settings=jobSettingsSchema.parse(settings);
  }
  ingest(sessionId:UUID,epoch:Counter,event:NormalizedEvent):Promise<IngestResult> {return ingest(this.pool,sessionId,epoch,event,this.settings,this.clock);}
  sealReadyPrefix(scope:UserScope,sessionId:UUID,cause:"timer"|"close"):Promise<BatchResult> {return sealReadyPrefix(this.pool,scope,sessionId,cause,this.settings);}
  finishCapture(scope:UserScope,sessionId:UUID,reason:CloseReason):Promise<CaptureSummary> {return finishCapture(this.pool,scope,sessionId,reason,this.settings,this.clock);}
  recoverOpenCaptures():Promise<readonly CaptureSummary[]> {return recoverOpenCaptures(this.pool,this.settings,this.clock);}
  scanReadySessions():Promise<void> {return scanReadySessions(this.pool,this.settings,this.clock);}
}

export function startTranscriptScanLoop(ingestor:TranscriptIngestor,onError:(error:unknown)=>void):{stop:()=>Promise<void>} {
  let stopped=false;
  let running:Promise<void>|null=null;
  let failure:unknown=null;
  const timer=setInterval(()=>{
    if(stopped || running!==null) return;
    running=ingestor.scanReadySessions().catch(error=>{
      stopped=true;clearInterval(timer);failure=error;
      try{onError(error);}catch(callbackError){failure=callbackError;}
    }).finally(()=>{running=null;});
  },2000);
  return {stop:async()=>{stopped=true;clearInterval(timer);await running;if(failure!==null) throw failure;}};
}
