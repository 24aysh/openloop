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
  return <section aria-label="Commitments" className="view">
    <div className="page-heading"><div><span className="eyebrow">Tasks & reminders</span><h2>Commitments</h2>
      <p>Keep track of promises, deadlines, and the things you intend to do.</p></div>
      <button className="text-action" type="button" onClick={()=>setRevision(value=>value+1)}>Refresh</button></div>
    <div className="toolbar compact-toolbar"><label className="field"><span>Show</span><select value={status} onChange={event=>{setItems([]);setConfirming(null);setStatus(event.target.value as VisibleStatus);}}>
      <option value="all">All commitments</option><option value="open">Open</option><option value="completed">Completed</option><option value="dismissed">Dismissed</option>
    </select></label></div>
    {error?<p className="callout callout-error" role="alert">{errorMessage(error)}</p>:null}
    {actionError?<p className="callout callout-error" role="alert">{errorMessage(actionError)}</p>:null}
    {loading&&items.length===0?<div className="empty-state" aria-live="polite"><span className="loading-dot"/>Loading commitments…</div>:error!==null&&items.length===0?null:items.length===0?<div className="empty-state"><strong>No commitments here</strong><p>New tasks extracted from conversations will appear here.</p></div>:
      <ul className="cards commitment-list">{items.map(item=>{
        const loggedAt=logged(item);
        return <li className="commitment-card" key={item.id} data-status={item.status}>
          <div className="commitment-main"><div className="commitment-title-row"><span className="status-pill" data-status={item.status}>{item.status}</span>
            <span className="priority-pill" data-priority={item.priority}>P{item.priority}</span></div>
            <h3>{item.title}</h3>
            <p className="due-line">{due(item)}</p>
            {loggedAt?<p className="delivered-line">Reminder delivered {loggedAt}</p>:null}
          </div>
          <div className="card-actions">{item.status==="open"?<><button className="primary-action" type="button" disabled={busy} onClick={()=>{void update(item,"completed");}}>Mark completed</button>
            <button className="secondary-action" type="button" disabled={busy} onClick={()=>{void update(item,"dismissed");}}>Dismiss</button></>:null}
            <button className="danger-action" type="button" disabled={busy} onClick={()=>setConfirming(item.id)}>Delete</button>
            <button className="text-action" type="button" onClick={()=>setSelected(selected===item.id?null:item.id)}>Sources</button></div>
          {confirming===item.id?<div className="confirm-panel"><div><strong>Delete this commitment?</strong><p>Future reminders will stop. Source history remains available for audit.</p></div>
            <div className="card-actions"><button type="button" className="danger-solid" disabled={busy} onClick={()=>{void remove(item);}}>Confirm delete</button>
              <button className="secondary-action" type="button" disabled={busy} onClick={()=>setConfirming(null)}>Cancel</button></div></div>:null}
          {selected===item.id?<Provenance type="commitment" id={item.id} onClose={()=>setSelected(null)}/>:null}
        </li>;
      })}</ul>}
    {cursor!==null?<div className="load-more"><button className="secondary-action" type="button" disabled={moreLoading} onClick={()=>{void loadMore();}}>{moreLoading?"Loading…":"Load more commitments"}</button></div>:null}
  </section>;
}
