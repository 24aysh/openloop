import { useEffect, useRef, useState } from "react";
import { ApiError, MindApi, type Memory } from "./api";
import { Provenance } from "./Provenance";
import { errorMessage } from "../error-message";

const api=new MindApi();
type Filters={text:string;kind:"all"|"semantic"|"episodic"};

export function MindView(){
  const [draftSearch,setDraftSearch]=useState("");const [draftKind,setDraftKind]=useState<Filters["kind"]>("all");
  const [filters,setFilters]=useState<Filters>({text:"",kind:"all"});const [revision,setRevision]=useState(0);
  const [items,setItems]=useState<readonly Memory[]>([]);const [cursor,setCursor]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);const [moreLoading,setMoreLoading]=useState(false);const [error,setError]=useState<string|null>(null);
  const [actionError,setActionError]=useState<string|null>(null);
  const [selected,setSelected]=useState<string|null>(null);const [editing,setEditing]=useState<string|null>(null);const [content,setContent]=useState("");
  const [busy,setBusy]=useState(false);const ongoing=useRef<AbortController|null>(null);const action=useRef<AbortController|null>(null);
  useEffect(()=>()=>action.current?.abort(),[]);
  useEffect(()=>{
    ongoing.current?.abort();const controller=new AbortController();ongoing.current=controller;
    setLoading(true);setMoreLoading(false);setItems([]);setCursor(null);setError(null);
    void api.memories({text:filters.text||undefined,kind:filters.kind==="all"?undefined:filters.kind},null,controller.signal)
      .then(page=>{if(!controller.signal.aborted){setItems(page.items);setCursor(page.nextCursor);}})
      .catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"request_failed");})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>ongoing.current?.abort();
  },[filters,revision]);
  async function loadMore(){if(cursor===null||moreLoading)return;const controller=new AbortController();ongoing.current=controller;setMoreLoading(true);setError(null);
    try{const page=await api.memories({text:filters.text||undefined,kind:filters.kind==="all"?undefined:filters.kind},cursor,controller.signal);
      if(!controller.signal.aborted){setItems(old=>[...old,...page.items]);setCursor(page.nextCursor);}}
    catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"request_failed");}
    finally{if(!controller.signal.aborted)setMoreLoading(false);}
  }
  async function save(item:Memory){if(busy)return;const controller=new AbortController();action.current=controller;setBusy(true);setActionError(null);
    try{await api.editMemory(item,content,controller.signal);if(!controller.signal.aborted){setEditing(null);setRevision(value=>value+1);}}
    catch(reason){if(!controller.signal.aborted){if(reason instanceof ApiError&&reason.code==="version_conflict")setRevision(value=>value+1);
      setActionError(reason instanceof Error?reason.message:"request_failed");}}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }
  async function remove(item:Memory){if(busy)return;const controller=new AbortController();action.current=controller;setBusy(true);setActionError(null);
    try{await api.deleteMemory(item,controller.signal);if(!controller.signal.aborted){setEditing(null);setRevision(value=>value+1);}}
    catch(reason){if(!controller.signal.aborted){if(reason instanceof ApiError&&reason.code==="version_conflict")setRevision(value=>value+1);
      setActionError(reason instanceof Error?reason.message:"request_failed");}}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }
  return <section aria-label="Mind">
    <h2>Mind</h2><p>Facts and events extracted from completed conversation turns.</p>
    <form className="row" onSubmit={event=>{event.preventDefault();setFilters({text:draftSearch.trim(),kind:draftKind});}}>
      <label>Search <input value={draftSearch} onChange={event=>setDraftSearch(event.target.value)} maxLength={500}/></label>
      <label>Kind <select value={draftKind} onChange={event=>setDraftKind(event.target.value as Filters["kind"])}>
        <option value="all">All</option><option value="semantic">Facts</option><option value="episodic">Events</option>
      </select></label><button type="submit">Search</button><button type="button" onClick={()=>setRevision(value=>value+1)}>Refresh</button>
    </form>
    {error?<p role="alert">{errorMessage(error)}</p>:null}
    {actionError?<p role="alert">{errorMessage(actionError)}</p>:null}
    {loading?<p>Loading memories…</p>:error!==null&&items.length===0?null:items.length===0?<p>No memories found.</p>:
      <ul className="cards">{items.map(item=><li key={item.id}>
        <small>{item.kind} · {item.subject}{item.timeText?` · ${item.timeText}`:""}</small>
        <p>{item.content}</p>
        {editing===item.id?<form onSubmit={event=>{event.preventDefault();void save(item);}}>
          <label>Correction <textarea value={content} onChange={event=>setContent(event.target.value)} maxLength={4000} required/></label>
          <div className="row"><button type="submit" disabled={busy}>Save correction</button><button type="button" disabled={busy} onClick={()=>setEditing(null)}>Cancel</button></div>
        </form>:<div className="row"><button type="button" onClick={()=>{setEditing(item.id);setContent(item.content);}}>Correct</button>
          <button type="button" disabled={busy} onClick={()=>{void remove(item);}}>Delete</button>
          <button type="button" onClick={()=>setSelected(selected===item.id?null:item.id)}>Sources</button></div>}
        {selected===item.id?<Provenance type="memory" id={item.id} onClose={()=>setSelected(null)}/>:null}
      </li>)}</ul>}
    {cursor!==null?<button type="button" disabled={moreLoading} onClick={()=>{void loadMore();}}>{moreLoading?"Loading…":"Load more"}</button>:null}
  </section>;
}
