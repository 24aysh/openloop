import { createRoot } from "react-dom/client";
import { VoiceConversation } from "./voice/VoiceConversation";

const root=document.getElementById("root");
if(root===null) throw new Error("Missing application root");
createRoot(root).render(<VoiceConversation/>);
