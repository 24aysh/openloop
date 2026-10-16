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
  const onDue=useCallback(()=>setNotificationRevision(value=>value+1),[]);
  return <main><header><h1>Openloop</h1><p>Listen · Understand · Remember · Anticipate · Act</p></header>
    <nav aria-label="Main navigation" className="row">
      <button type="button" aria-current={view==="voice"?"page":undefined} onClick={()=>setView("voice")}>Voice</button>
      <button type="button" aria-current={view==="mind"?"page":undefined} onClick={()=>setView("mind")}>Mind</button>
      <button type="button" aria-current={view==="commitments"?"page":undefined} onClick={()=>setView("commitments")}>Commitments</button>
    </nav>
    <div hidden={view!=="voice"}><VoiceConversation/></div>
    {view==="mind"?<MindView/>:null}{view==="commitments"?<CommitmentsView notificationRevision={notificationRevision}/>:null}
    <NotificationToasts onOpenCommitments={()=>setView("commitments")} onDue={onDue}/>
  </main>;
}

const root=document.getElementById("root");
if(root===null) throw new Error("Missing application root");
createRoot(root).render(<App/>);
