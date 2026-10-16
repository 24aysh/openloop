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
  return <section aria-label="Mind" className="view">
    <div className="page-heading"><div><span className="eyebrow">Personal memory</span><h2>Mind</h2>
      <p>Facts and events gathered from your completed conversations.</p></div>
      <button className="text-action" type="button" onClick={()=>setRevision(value=>value+1)}>Refresh</button></div>
    <form className="toolbar search-toolbar" onSubmit={event=>{event.preventDefault();setFilters({text:draftSearch.trim(),kind:draftKind});}}>
      <label className="field field-grow"><span>Search memories</span><input type="search" placeholder="Search by person, topic, or detail" value={draftSearch} onChange={event=>setDraftSearch(event.target.value)} maxLength={500}/></label>
      <label className="field"><span>Memory type</span><select value={draftKind} onChange={event=>setDraftKind(event.target.value as Filters["kind"])}>
        <option value="all">All memories</option><option value="semantic">Facts</option><option value="episodic">Events</option>
      </select></label><button className="primary-action toolbar-action" type="submit">Search</button>
    </form>
    {error?<p className="callout callout-error" role="alert">{errorMessage(error)}</p>:null}
    {actionError?<p className="callout callout-error" role="alert">{errorMessage(actionError)}</p>:null}
    {loading?<div className="empty-state" aria-live="polite"><span className="loading-dot"/>Loading memories…</div>:error!==null&&items.length===0?null:items.length===0?<div className="empty-state"><strong>No memories found</strong><p>Try another search or start a voice conversation.</p></div>:
      <ul className="cards memory-grid">{items.map(item=><li className="memory-card" key={item.id}>
        <div className="card-header"><span className="type-pill" data-kind={item.kind}>{item.kind==="semantic"?"Fact":"Event"}</span>
          <span className="card-subject">{item.subject}</span>{item.timeText?<span className="card-time">{item.timeText}</span>:null}</div>
        <p className="memory-content">{item.content}</p>
        {editing===item.id?<form className="inline-editor" onSubmit={event=>{event.preventDefault();void save(item);}}>
          <label className="field"><span>Correction</span><textarea value={content} onChange={event=>setContent(event.target.value)} maxLength={4000} required/></label>
          <div className="card-actions"><button className="primary-action" type="submit" disabled={busy}>Save correction</button><button className="secondary-action" type="button" disabled={busy} onClick={()=>setEditing(null)}>Cancel</button></div>
        </form>:<div className="card-actions"><button className="secondary-action" type="button" onClick={()=>{setEditing(item.id);setContent(item.content);}}>Correct</button>
          <button className="danger-action" type="button" disabled={busy} onClick={()=>{void remove(item);}}>Delete</button>
          <button className="text-action" type="button" onClick={()=>setSelected(selected===item.id?null:item.id)}>Sources</button></div>}
        {selected===item.id?<Provenance type="memory" id={item.id} onClose={()=>setSelected(null)}/>:null}
      </li>)}</ul>}
    {cursor!==null?<div className="load-more"><button className="secondary-action" type="button" disabled={moreLoading} onClick={()=>{void loadMore();}}>{moreLoading?"Loading…":"Load more memories"}</button></div>:null}
  </section>;
}
