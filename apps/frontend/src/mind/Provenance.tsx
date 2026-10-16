import { useEffect, useState } from "react";
import { MindApi, type Change } from "./api";
import { errorMessage } from "../error-message";

const api=new MindApi();

export function Provenance({type,id,onClose}:{type:"memory"|"commitment";id:string;onClose:()=>void}){
  const [changes,setChanges]=useState<readonly Change[]|null>(null);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{
    const controller=new AbortController();setChanges(null);setError(null);
    void api.provenance(type,id,controller.signal).then(setChanges).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"request_failed");});
    return()=>controller.abort();
  },[type,id]);
  return <section aria-label="Source history" className="detail provenance-panel">
    <div className="panel-heading"><div><span className="eyebrow">Audit trail</span><h3>Source history</h3></div><button className="text-action" type="button" onClick={onClose}>Close</button></div>
    {error?<p className="callout callout-error" role="alert">{errorMessage(error)}</p>:changes===null?<div className="empty-state compact"><span className="loading-dot"/>Loading source history…</div>:changes.length===0?<p className="muted">No changes recorded.</p>:
      <ol className="history-list">{changes.map(change=><li key={change.id}>
        <div className="history-meta"><span className="type-pill">{change.operation}</span><span>by {change.actor}</span><span>version {change.entityVersion}</span><time>{new Date(change.createdAt).toLocaleString()}</time></div>
        {change.sources.length>0?<ul>{change.sources.map(source=><li key={`${source.itemId}:${source.contentIndex}`}>
          <span>Session {source.sessionId.slice(0,8)}, turn {source.itemOrdinal}</span><q>{source.evidenceText}</q>
        </li>)}</ul>:<p className="muted">No transcript source (manual change).</p>}
      </li>)}</ol>}
  </section>;
}
