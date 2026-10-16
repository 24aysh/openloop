import { useEffect, useRef, useState } from "react";
import { MindApi, type Transcript } from "../mind/api";
import { errorMessage } from "../error-message";

const api=new MindApi();
export function TranscriptView({sessionId}:{sessionId:string}){
  const [page,setPage]=useState<Transcript|null>(null);const [error,setError]=useState<string|null>(null);const [loading,setLoading]=useState(true);
  const [revision,setRevision]=useState(0);
  const ongoing=useRef<AbortController|null>(null);
  useEffect(()=>{
    ongoing.current?.abort();const controller=new AbortController();ongoing.current=controller;setLoading(true);setError(null);setPage(null);
    void api.transcript(sessionId,null,controller.signal).then(setPage).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"request_failed");})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>ongoing.current?.abort();
  },[sessionId,revision]);
  async function more(){if(page?.nextCursor===null||page===null)return;const controller=new AbortController();ongoing.current=controller;setLoading(true);
    try{const next=await api.transcript(sessionId,page.nextCursor,controller.signal);if(!controller.signal.aborted)setPage({...next,items:[...page.items,...next.items]});}
    catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"request_failed");}
    finally{if(!controller.signal.aborted)setLoading(false);}
  }
  return <section aria-label="Transcript" className="detail transcript-panel"><div className="panel-heading"><div><span className="eyebrow">Captured turns</span><h3>Transcript</h3></div><button className="text-action" type="button" onClick={()=>setRevision(value=>value+1)}>Refresh</button></div>
    {error?<p className="callout callout-error" role="alert">{errorMessage(error)}</p>:null}{loading&&page===null?<div className="empty-state compact"><span className="loading-dot"/>Loading transcript…</div>:null}
    {page?<><ol className="transcript-list">{page.items.map(turn=><li key={turn.item.id}>
      <div className="turn-meta"><span className="type-pill">{turn.item.role}</span><span>Turn {turn.item.ordinal??"unplaced"}</span><span>{turn.item.state}</span></div>
      {turn.item.errorCode?<p className="callout callout-error" role="alert">{turn.item.errorCode}</p>:null}
      {turn.parts.map(part=><p className="turn-text" key={part.contentIndex}>{part.finalText??`[${part.state}${part.errorCode?`: ${part.errorCode}`:""}]`}</p>)}
    </li>)}</ol>
    {page.gaps.length>0?<div className="gap-list"><h4>Ordering gaps and excluded turns</h4><ul>{page.gaps.map(gap=><li key={gap.item.id}>{gap.reason} · {gap.item.id}{gap.item.errorCode?` · ${gap.item.errorCode}`:""}</li>)}</ul></div>:null}
    {page.nextCursor!==null?<button className="secondary-action" type="button" disabled={loading} onClick={()=>{void more();}}>Load more turns</button>:null}</>:null}
  </section>;
}
