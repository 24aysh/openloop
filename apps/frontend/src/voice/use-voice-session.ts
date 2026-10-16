import { useCallback, useEffect, useRef, useState } from "react";
import { createBrowserVoiceEnvironment, VoiceSessionClient, type VoiceSnapshot } from "./session-client";

export function useVoiceSession():Readonly<{state:VoiceSnapshot;start:()=>Promise<void>;stop:()=>Promise<void>}> {
  const clientRef=useRef<VoiceSessionClient|null>(null);
  if(clientRef.current===null) clientRef.current=new VoiceSessionClient(createBrowserVoiceEnvironment());
  const [state,setState]=useState<VoiceSnapshot>(clientRef.current.state);
  useEffect(()=>{const client=clientRef.current!;const unsubscribe=client.subscribe(setState);return()=>{unsubscribe();client.dispose();};},[]);
  const start=useCallback(()=>clientRef.current!.start(),[]);
  const stop=useCallback(()=>clientRef.current!.stop(),[]);
  return {state,start,stop};
}
