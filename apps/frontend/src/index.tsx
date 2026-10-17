import { createRoot } from "react-dom/client";
import { useCallback, useState } from "react";
import { VoiceConversation } from "./voice/VoiceConversation";
import { MindView } from "./mind/MindView";
import { CommitmentsView } from "./mind/CommitmentsView";
import { NotificationToasts } from "./notifications/NotificationToasts";
import "./style.css";

function App(){
  const [view,setView]=useState<"voice"|"mind"|"commitments">("voice");
  const [notificationRevision,setNotificationRevision]=useState(0);
  const [inactiveCommitment,setInactiveCommitment]=useState<Readonly<{id:string;revision:number}>|null>(null);
  const onDue=useCallback(()=>setNotificationRevision(value=>value+1),[]);
  const onCommitmentInactive=useCallback((id:string)=>setInactiveCommitment(value=>({id,revision:(value?.revision??0)+1})),[]);
  return <div className="app-shell">
    <header className="app-header">
      <h1>openloop</h1>
    </header>
    <nav aria-label="Main navigation" className="main-nav">
      <button type="button" aria-current={view==="voice"?"page":undefined} onClick={()=>setView("voice")}>Voice</button>
      <button type="button" aria-current={view==="mind"?"page":undefined} onClick={()=>setView("mind")}>Mind</button>
      <button type="button" aria-current={view==="commitments"?"page":undefined} onClick={()=>setView("commitments")}>Commitments</button>
    </nav>
    <main className="app-content">
      <div hidden={view!=="voice"}><VoiceConversation/></div>
      {view==="mind"?<MindView/>:null}{view==="commitments"?<CommitmentsView notificationRevision={notificationRevision} onCommitmentInactive={onCommitmentInactive}/>:null}
    </main>
    <NotificationToasts onOpenCommitments={()=>setView("commitments")} onDue={onDue} inactiveCommitment={inactiveCommitment}/>
  </div>;
}

const root=document.getElementById("root");
if(root===null) throw new Error("Missing application root");
createRoot(root).render(<App/>);
