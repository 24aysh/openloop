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
  return <section aria-label="Transcript" className="detail"><div className="row"><h3>Transcript</h3><button type="button" onClick={()=>setRevision(value=>value+1)}>Refresh</button></div>
    {error?<p role="alert">{errorMessage(error)}</p>:null}{loading&&page===null?<p>Loading transcript…</p>:null}
    {page?<><ol>{page.items.map(turn=><li key={turn.item.id}>
      <strong>{turn.item.role} · turn {turn.item.ordinal??"unplaced"} · {turn.item.state}</strong>
      {turn.item.errorCode?<p role="alert">{turn.item.errorCode}</p>:null}
      {turn.parts.map(part=><p key={part.contentIndex}>{part.finalText??`[${part.state}${part.errorCode?`: ${part.errorCode}`:""}]`}</p>)}
    </li>)}</ol>
    {page.gaps.length>0?<><h4>Ordering gaps / excluded turns</h4><ul>{page.gaps.map(gap=><li key={gap.item.id}>{gap.reason} · {gap.item.id}{gap.item.errorCode?` · ${gap.item.errorCode}`:""}</li>)}</ul></>:null}
    {page.nextCursor!==null?<button type="button" disabled={loading} onClick={()=>{void more();}}>Load more</button>:null}</>:null}
  </section>;
}
