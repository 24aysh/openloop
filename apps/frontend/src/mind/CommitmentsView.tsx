import { useEffect, useRef, useState } from "react";
import { ApiError, MindApi, type Commitment } from "./api";
import { Provenance } from "./Provenance";
import { errorMessage } from "../error-message";

const api=new MindApi();
function due(item:Commitment):string{
  if(item.dueAt===null)return item.dueText===null?"No due time":`Due time unresolved: ${item.dueText}`;
  try{return `${new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short",timeZone:item.dueTimezone??undefined}).format(new Date(item.dueAt))}${item.dueTimezone?` (${item.dueTimezone})`:""}`;}
  catch{return item.dueText??item.dueAt;}
}
function logged(item:Commitment):string|null{
  if(item.loggedAt===null)return null;
  try{return new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short",timeZone:item.dueTimezone??undefined}).format(new Date(item.loggedAt));}
  catch{return item.loggedAt;}
}
export function CommitmentsView(){
  const [status,setStatus]=useState<"all"|Commitment["status"]>("all");const [revision,setRevision]=useState(0);
  const [items,setItems]=useState<readonly Commitment[]>([]);const [cursor,setCursor]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);const [moreLoading,setMoreLoading]=useState(false);const [error,setError]=useState<string|null>(null);
  const [actionError,setActionError]=useState<string|null>(null);
  const [selected,setSelected]=useState<string|null>(null);const [busy,setBusy]=useState(false);
  const ongoing=useRef<AbortController|null>(null);const action=useRef<AbortController|null>(null);
  useEffect(()=>()=>action.current?.abort(),[]);
  useEffect(()=>{const timer=setInterval(()=>setRevision(value=>value+1),2000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    ongoing.current?.abort();const controller=new AbortController();ongoing.current=controller;
    setLoading(true);setMoreLoading(false);setCursor(null);setError(null);
    void api.commitments(status,null,controller.signal).then(page=>{if(!controller.signal.aborted){setItems(page.items);setCursor(page.nextCursor);}})
      .catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"request_failed");})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>ongoing.current?.abort();
  },[status,revision]);
  async function loadMore(){if(cursor===null||moreLoading)return;const controller=new AbortController();ongoing.current=controller;setMoreLoading(true);setError(null);
    try{const page=await api.commitments(status,cursor,controller.signal);if(!controller.signal.aborted){setItems(old=>[...old,...page.items]);setCursor(page.nextCursor);}}
    catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"request_failed");}
    finally{if(!controller.signal.aborted)setMoreLoading(false);}
  }
  async function update(item:Commitment,next:Commitment["status"]){if(busy)return;const controller=new AbortController();action.current=controller;setBusy(true);setActionError(null);
    try{await api.setCommitmentStatus(item,next,controller.signal);if(!controller.signal.aborted)setRevision(value=>value+1);}
    catch(reason){if(!controller.signal.aborted){if(reason instanceof ApiError&&reason.code==="version_conflict")setRevision(value=>value+1);
      setActionError(reason instanceof Error?reason.message:"request_failed");}}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }
  return <section aria-label="Commitments">
    <h2>Commitments</h2><p>Open promises are logged in the backend terminal when their resolved due time arrives.</p>
    <div className="row"><label>Status <select value={status} onChange={event=>setStatus(event.target.value as typeof status)}>
      <option value="all">All</option><option value="open">Open</option><option value="completed">Completed</option><option value="dismissed">Dismissed</option>
    </select></label><button type="button" onClick={()=>setRevision(value=>value+1)}>Refresh</button></div>
    {error?<p role="alert">{errorMessage(error)}</p>:null}
    {actionError?<p role="alert">{errorMessage(actionError)}</p>:null}
    {loading&&items.length===0?<p>Loading commitments…</p>:error!==null&&items.length===0?null:items.length===0?<p>No commitments found.</p>:
      <ul className="cards">{items.map(item=><li key={item.id}>
        <strong>{item.title}</strong><p>{item.status} · priority {item.priority} · {due(item)}</p>
        {logged(item)?<p><strong>Logged by backend:</strong> {logged(item)}</p>:null}
        <div className="row">{item.status==="open"?<><button type="button" disabled={busy} onClick={()=>{void update(item,"completed");}}>Mark completed</button>
          <button type="button" disabled={busy} onClick={()=>{void update(item,"dismissed");}}>Dismiss</button></>:null}
          <button type="button" onClick={()=>setSelected(selected===item.id?null:item.id)}>Sources</button></div>
        {selected===item.id?<Provenance type="commitment" id={item.id} onClose={()=>setSelected(null)}/>:null}
      </li>)}</ul>}
    {cursor!==null?<button type="button" disabled={moreLoading} onClick={()=>{void loadMore();}}>{moreLoading?"Loading…":"Load more"}</button>:null}
  </section>;
}
