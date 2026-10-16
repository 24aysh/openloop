import { useEffect, useState } from "react";

export type DueNotification=Readonly<{
  id:string;commitmentId:string;title:string;priority:1|2|3;dueAt:string;loggedAt:string;active:boolean;
}>;

const cursorKey="openloop.notificationCursor";
export function parseDueNotification(raw:unknown,lastEventId:string):DueNotification {
  if(typeof raw!=="object" || raw===null || Array.isArray(raw))throw new Error("Invalid notification");
  const row=raw as Record<string,unknown>;
  if(typeof row.id!=="string" || !/^(0|[1-9][0-9]{0,18})$/.test(row.id) || row.id!==lastEventId ||
    typeof row.commitmentId!=="string" || typeof row.title!=="string" ||
    (row.priority!==1 && row.priority!==2 && row.priority!==3) ||
    typeof row.dueAt!=="string" || !Number.isFinite(Date.parse(row.dueAt)) ||
    typeof row.loggedAt!=="string" || !Number.isFinite(Date.parse(row.loggedAt)) || typeof row.active!=="boolean")
    throw new Error("Invalid notification");
  return row as DueNotification;
}
function storedCursor():string {
  try{const value=localStorage.getItem(cursorKey);return value && /^(0|[1-9][0-9]{0,18})$/.test(value)?value:"0";}
  catch{return "0";}
}
function rememberCursor(id:string):void {try{localStorage.setItem(cursorKey,id);}catch{/* the stream still works for this tab */}}
function later(left:string,right:string):boolean {return BigInt(left)>BigInt(right);}

export function NotificationToasts({onOpenCommitments,onDue}:{onOpenCommitments:()=>void;onDue:()=>void}){
  const [toasts,setToasts]=useState<readonly (DueNotification & {expiresAt:number})[]>([]);
  const [connected,setConnected]=useState(true);
  useEffect(()=>{
    let cursor=storedCursor();
    const stream=new EventSource(`/api/notifications/stream?after=${encodeURIComponent(cursor)}`);
    stream.onopen=()=>setConnected(true);
    stream.onerror=()=>setConnected(false);
    const receive=(raw:Event)=>{
      const message=raw as MessageEvent<string>;
      try{
        const item=parseDueNotification(JSON.parse(message.data) as unknown,message.lastEventId);
        if(!later(item.id,cursor))return;
        cursor=item.id;rememberCursor(cursor);
        if(!item.active)return;
        onDue();
        setToasts(old=>[...old,{...item,expiresAt:Date.now()+15000}].slice(-3));
      }catch{setConnected(false);}
    };
    const reset=()=>{cursor="0";rememberCursor(cursor);};
    stream.addEventListener("commitment_due",receive);
    stream.addEventListener("notification_reset",reset);
    return()=>{stream.removeEventListener("commitment_due",receive);stream.removeEventListener("notification_reset",reset);stream.close();};
  },[onDue]);
  useEffect(()=>{const timer=setInterval(()=>setToasts(old=>old.filter(item=>item.expiresAt>Date.now())),1000);return()=>clearInterval(timer);},[]);
  return <aside className="notification-area" aria-label="Reminders" aria-live="polite">
    {!connected?<p className="notification-connection">Live reminders reconnecting…</p>:null}
    {toasts.map(item=><div className="notification-toast" key={item.id} role="status">
      <strong>Commitment due</strong><p>{item.title}</p>
      <div className="row"><button type="button" onClick={onOpenCommitments}>View commitments</button>
        <button type="button" aria-label={`Dismiss reminder for ${item.title}`} onClick={()=>setToasts(old=>old.filter(toast=>toast.id!==item.id))}>Dismiss</button></div>
    </div>)}
  </aside>;
}
