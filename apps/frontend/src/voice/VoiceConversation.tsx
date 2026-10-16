import { useEffect, useState } from "react";
import { useVoiceSession } from "./use-voice-session";
import { TranscriptView } from "./TranscriptView";
import { errorMessage } from "../error-message";

export function VoiceConversation() {
  const {state,start,stop,refreshStatus}=useVoiceSession();
  const [showTranscript,setShowTranscript]=useState(false);
  const running=["requesting_permission","negotiating","waiting_for_capture","active","draining"].includes(state.phase);
  const needsRefresh=state.phase==="uncertain"||state.phase==="draining"||
    (state.phase==="closed"&&state.status!==null&&state.status.reconciliationBacklog>0&&state.status.blockedReconciliationJobs===0);
  useEffect(()=>{
    if(state.sessionId===null||!needsRefresh)return;
    const timer=setInterval(()=>{void refreshStatus();},2000);return()=>clearInterval(timer);
  },[state.sessionId,needsRefresh,refreshStatus]);
  const status=state.status;
  const mindCurrent=state.phase==="closed"&&status!==null&&status.errorCode===null&&status.closeReason==="clean"&&status.transcriptGapCount===0&&
    status.appliedThrough>=status.sealedThrough&&status.reconciliationBacklog===0;
  return <section aria-label="Voice conversation">
    <h2>Voice conversation</h2>
    <p aria-live="polite">{state.phase.replaceAll("_"," ")}</p>
    {state.errorCode!==null?<p role="alert">{errorMessage(state.errorCode)}</p>:null}
    <button type="button" disabled={running} onClick={()=>{void start().catch(()=>undefined);}}>Start conversation</button>
    <button type="button" disabled={!running||state.phase==="draining"} onClick={()=>{void stop().catch(()=>undefined);}}>Stop</button>
    {state.phase==="uncertain"?<button type="button" onClick={()=>{void stop().catch(()=>undefined);}}>Try to close</button>:null}
    {state.sessionId!==null?<><div className="detail">
      <p>Session {state.sessionId}</p>
      {status?<><p>Captured through turn {status.sealedThrough}; Mind applied through turn {status.appliedThrough}.</p>
        <p>Extraction backlog: {status.reconciliationBacklog}; blocked: {status.blockedReconciliationJobs}.</p>
        {status.transcriptGapCount>0?<p role="alert">{status.transcriptGapCount} transcript turn(s) have gaps or incomplete capture. Inspect the transcript.</p>:null}
        {status.blockedReconciliationJobs>0?<p role="alert">Mind extraction is blocked. Transcript remains available.</p>:null}
        {status.state==="closed"&&!mindCurrent?<p>Capture ended. Mind processing may still be pending or incomplete.</p>:null}
        {mindCurrent?<p>Mind is up to date for the sealed transcript prefix.</p>:null}
        {status.state==="incomplete"||status.state==="failed"?<p role="alert">Capture did not finish cleanly. Some speech may be missing.</p>:null}
      </>:null}
      <div className="row"><button type="button" onClick={()=>{void refreshStatus();}}>Refresh status</button>
        <button type="button" onClick={()=>setShowTranscript(value=>!value)}>{showTranscript?"Hide transcript":"Inspect transcript"}</button></div>
    </div>{showTranscript?<TranscriptView sessionId={state.sessionId}/>:null}</>:null}
  </section>;
}
