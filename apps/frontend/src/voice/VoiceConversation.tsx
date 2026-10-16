import { useVoiceSession } from "./use-voice-session";

export function VoiceConversation() {
  const {state,start,stop}=useVoiceSession();
  const running=["requesting_permission","negotiating","waiting_for_capture","active","draining"].includes(state.phase);
  return <main>
    <h1>Openloop voice</h1>
    <p aria-live="polite">{state.phase.replaceAll("_"," ")}</p>
    {state.errorCode!==null?<p role="alert">{state.errorCode}</p>:null}
    <button type="button" disabled={running} onClick={()=>{void start().catch(()=>undefined);}}>Start conversation</button>
    <button type="button" disabled={!running||state.phase==="draining"} onClick={()=>{void stop().catch(()=>undefined);}}>Stop</button>
  </main>;
}
