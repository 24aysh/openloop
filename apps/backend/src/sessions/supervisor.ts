import type { SessionController } from "./controller";

export function startSessionSupervisor(controller:SessionController,onError:(error:unknown)=>void):{stop:()=>Promise<void>} {
  let stopped=false;let running:Promise<void>|null=null;let failure:unknown=null;
  const timer=setInterval(()=>{
    if(stopped || running!==null) return;
    running=controller.tick().catch(error=>{failure=error;try{onError(error);}catch(callbackError){failure=callbackError;}}).finally(()=>{running=null;});
  },2000);
  return {stop:async()=>{stopped=true;clearInterval(timer);await running;if(failure!==null) throw failure;}};
}
