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
  return <section aria-label="Voice conversation" className="view">
    <div className="page-heading"><div><h2>Voice</h2>
      </div></div>
    <div className="voice-card">
      <div className="voice-orb" data-active={running} aria-hidden="true"><span/><span/><i/></div>
      <div className="voice-copy">
        <span className="status-badge" data-phase={state.phase} aria-live="polite"><i/>{state.phase.replaceAll("_"," ")}</span>
        <h3>{running?"Openloop is listening":"Start a new conversation"}</h3>
        <p>{running?"Speak as you normally would. Stop when you are ready to save the completed turns.":"Your microphone stays off until you start."}</p>
        <div className="voice-actions">
          <button className="primary-action" type="button" disabled={running} onClick={()=>{void start().catch(()=>undefined);}}>Start conversation</button>
          <button className="secondary-action" type="button" disabled={!running||state.phase==="draining"} onClick={()=>{void stop().catch(()=>undefined);}}>Stop</button>
          {state.phase==="uncertain"?<button className="secondary-action" type="button" onClick={()=>{void stop().catch(()=>undefined);}}>Try to close</button>:null}
        </div>
      </div>
    </div>
    {state.errorCode!==null?<p className="callout callout-error" role="alert">{errorMessage(state.errorCode)}</p>:null}
    {state.sessionId!==null?<><div className="session-panel">
      <div className="panel-heading"><div><span className="eyebrow">Current session</span><h3>Capture details</h3></div>
        <span className="session-id" title={state.sessionId}>{state.sessionId.slice(0,8)}</span></div>
      {status?<><div className="stat-grid">
        <div><span>Captured through</span><strong>Turn {status.sealedThrough}</strong></div>
        <div><span>Mind applied through</span><strong>Turn {status.appliedThrough}</strong></div>
        <div><span>Extraction backlog</span><strong>{status.reconciliationBacklog}</strong></div>
        <div><span>Blocked jobs</span><strong>{status.blockedReconciliationJobs}</strong></div>
      </div>
        {status.transcriptGapCount>0?<p className="callout callout-error" role="alert">{status.transcriptGapCount} transcript turn(s) have gaps or incomplete capture. Inspect the transcript.</p>:null}
        {status.blockedReconciliationJobs>0?<p className="callout callout-error" role="alert">Mind extraction is blocked. Transcript remains available.</p>:null}
        {status.state==="closed"&&!mindCurrent&&status.blockedReconciliationJobs===0?<p className="callout">Capture is complete. Mind extraction is still processing.</p>:null}
        {mindCurrent?<p className="callout callout-success">Mind is up to date for this conversation.</p>:null}
        {status.state==="incomplete"||status.state==="failed"?<p className="callout callout-error" role="alert">Capture did not finish cleanly. Some speech may be missing.</p>:null}
      </>:null}
      <div className="panel-actions"><button className="text-action" type="button" onClick={()=>{void refreshStatus();}}>Refresh status</button>
        <button className="secondary-action" type="button" onClick={()=>setShowTranscript(value=>!value)}>{showTranscript?"Hide transcript":"Inspect transcript"}</button></div>
    </div>{showTranscript?<TranscriptView sessionId={state.sessionId}/>:null}</>:null}
  </section>;
}
