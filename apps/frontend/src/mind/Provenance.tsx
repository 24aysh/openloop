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
  return <section aria-label="Source history" className="detail">
    <div className="row"><h3>Source history</h3><button type="button" onClick={onClose}>Close</button></div>
    {error?<p role="alert">{errorMessage(error)}</p>:changes===null?<p>Loading source history…</p>:changes.length===0?<p>No changes recorded.</p>:
      <ol>{changes.map(change=><li key={change.id}>
        <strong>{change.operation}</strong> by {change.actor} · version {change.entityVersion} · {new Date(change.createdAt).toLocaleString()}
        {change.sources.length>0?<ul>{change.sources.map(source=><li key={`${source.itemId}:${source.contentIndex}`}>
          Session {source.sessionId}, turn {source.itemOrdinal}: <q>{source.evidenceText}</q>
        </li>)}</ul>:<p>No transcript source (manual change).</p>}
      </li>)}</ol>}
  </section>;
}
