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
type VisibleStatus="all"|Exclude<Commitment["status"],"deleted">;
export function CommitmentsView({notificationRevision=0}:{notificationRevision?:number}){
  const [status,setStatus]=useState<VisibleStatus>("all");const [revision,setRevision]=useState(0);
  const [items,setItems]=useState<readonly Commitment[]>([]);const [cursor,setCursor]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);const [moreLoading,setMoreLoading]=useState(false);const [error,setError]=useState<string|null>(null);
  const [actionError,setActionError]=useState<string|null>(null);
  const [selected,setSelected]=useState<string|null>(null);const [busy,setBusy]=useState(false);
  const [confirming,setConfirming]=useState<string|null>(null);
  const ongoing=useRef<AbortController|null>(null);const action=useRef<AbortController|null>(null);
  useEffect(()=>()=>action.current?.abort(),[]);
  useEffect(()=>{
    ongoing.current?.abort();const controller=new AbortController();ongoing.current=controller;
    setLoading(true);setMoreLoading(false);setCursor(null);setError(null);
    void api.commitments(status,null,controller.signal).then(page=>{if(!controller.signal.aborted){setItems(page.items);setCursor(page.nextCursor);}})
      .catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"request_failed");})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>ongoing.current?.abort();
  },[status,revision,notificationRevision]);
  async function loadMore(){if(cursor===null||moreLoading)return;const controller=new AbortController();ongoing.current=controller;setMoreLoading(true);setError(null);
    try{const page=await api.commitments(status,cursor,controller.signal);if(!controller.signal.aborted){setItems(old=>[...old,...page.items]);setCursor(page.nextCursor);}}
    catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"request_failed");}
    finally{if(!controller.signal.aborted)setMoreLoading(false);}
  }
  async function update(item:Commitment,next:Exclude<Commitment["status"],"deleted">){if(busy)return;const controller=new AbortController();action.current=controller;setBusy(true);setActionError(null);
    try{await api.setCommitmentStatus(item,next,controller.signal);if(!controller.signal.aborted)setRevision(value=>value+1);}
    catch(reason){if(!controller.signal.aborted){if(reason instanceof ApiError&&reason.code==="version_conflict")setRevision(value=>value+1);
      setActionError(reason instanceof Error?reason.message:"request_failed");}}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }
  async function remove(item:Commitment){if(busy)return;const controller=new AbortController();action.current=controller;setBusy(true);setActionError(null);
    try{await api.deleteCommitment(item,controller.signal);if(!controller.signal.aborted){setItems(old=>old.filter(value=>value.id!==item.id));setConfirming(null);setRevision(value=>value+1);}}
    catch(reason){if(!controller.signal.aborted){if(reason instanceof ApiError&&reason.code==="version_conflict")setRevision(value=>value+1);
      setActionError(reason instanceof Error?reason.message:"request_failed");}}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }
  return <section aria-label="Commitments">
    <h2>Commitments</h2><p>Due reminders appear in the app while it is open. Tasks stay open until you complete, dismiss, or delete them.</p>
    <div className="row"><label>Status <select value={status} onChange={event=>{setItems([]);setConfirming(null);setStatus(event.target.value as VisibleStatus);}}>
      <option value="all">All</option><option value="open">Open</option><option value="completed">Completed</option><option value="dismissed">Dismissed</option>
    </select></label><button type="button" onClick={()=>setRevision(value=>value+1)}>Refresh</button></div>
    {error?<p role="alert">{errorMessage(error)}</p>:null}
    {actionError?<p role="alert">{errorMessage(actionError)}</p>:null}
    {loading&&items.length===0?<p>Loading commitments…</p>:error!==null&&items.length===0?null:items.length===0?<p>No commitments found.</p>:
      <ul className="cards">{items.map(item=>{
        const loggedAt=logged(item);
        return <li key={item.id}>
          <strong>{item.title}</strong>
          <p className="commitment-meta"><span className="status-pill" data-status={item.status}>{item.status}</span>
            <span>Priority {item.priority}</span><span>· {due(item)}</span></p>
          {loggedAt?<p><strong>Reminder delivered:</strong> {loggedAt}</p>:null}
          <div className="row">{item.status==="open"?<><button type="button" disabled={busy} onClick={()=>{void update(item,"completed");}}>Mark completed</button>
            <button type="button" disabled={busy} onClick={()=>{void update(item,"dismissed");}}>Dismiss</button></>:null}
            <button type="button" className="danger" disabled={busy} onClick={()=>setConfirming(item.id)}>Delete</button>
            <button type="button" onClick={()=>setSelected(selected===item.id?null:item.id)}>Sources</button></div>
          {confirming===item.id?<div className="detail"><p>Delete this commitment and stop future reminders? Its source history remains available for audit.</p>
            <div className="row"><button type="button" className="danger" disabled={busy} onClick={()=>{void remove(item);}}>Confirm delete</button>
              <button type="button" disabled={busy} onClick={()=>setConfirming(null)}>Cancel</button></div></div>:null}
          {selected===item.id?<Provenance type="commitment" id={item.id} onClose={()=>setSelected(null)}/>:null}
        </li>;
      })}</ul>}
    {cursor!==null?<button type="button" disabled={moreLoading} onClick={()=>{void loadMore();}}>{moreLoading?"Loading…":"Load more"}</button>:null}
  </section>;
}
