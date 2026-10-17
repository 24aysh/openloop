import { useEffect, useState } from "react";

export type DueNotification=Readonly<{
  id:string;commitmentId:string;title:string;priority:1|2|3;dueAt:string;loggedAt:string;active:boolean;
}>;

const cursorKey="openloop.notificationCursor";
const cursorPattern=/^(0|[1-9][0-9]{0,18})$/;
function validCursor(value:unknown):value is string {
  return typeof value==="string" && cursorPattern.test(value) && BigInt(value)<=9223372036854775807n;
}
export function parseDueNotification(raw:unknown,lastEventId:string):DueNotification {
  if(typeof raw!=="object" || raw===null || Array.isArray(raw))throw new Error("Invalid notification");
  const row=raw as Record<string,unknown>;
  if(!validCursor(row.id) || row.id!==lastEventId ||
    typeof row.commitmentId!=="string" || typeof row.title!=="string" ||
    (row.priority!==1 && row.priority!==2 && row.priority!==3) ||
    typeof row.dueAt!=="string" || !Number.isFinite(Date.parse(row.dueAt)) ||
    typeof row.loggedAt!=="string" || !Number.isFinite(Date.parse(row.loggedAt)) || typeof row.active!=="boolean")
    throw new Error("Invalid notification");
  return row as DueNotification;
}
type CursorStorage=Pick<Storage,"getItem"|"setItem">;
type CursorRequest=(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>;
type CursorResponse=Readonly<{latestEventId:string}>;
export function parseCursorResponse(raw:unknown):CursorResponse {
  if(typeof raw!=="object" || raw===null || Array.isArray(raw))throw new Error("Invalid notification cursor");
  const latestEventId=(raw as Record<string,unknown>).latestEventId;
  if(!validCursor(latestEventId))throw new Error("Invalid notification cursor");
  return {latestEventId};
}
function storedCursor(storage:CursorStorage):string|null {
  try{const value=storage.getItem(cursorKey);return validCursor(value)?value:null;}
  catch{return null;}
}
function rememberCursor(storage:CursorStorage,id:string):void {try{storage.setItem(cursorKey,id);}catch{/* the stream still works for this tab */}}
export async function bootstrapNotificationCursor(storage:CursorStorage,request:CursorRequest):Promise<string> {
  const existing=storedCursor(storage);if(existing!==null)return existing;
  const response=await request("/api/notifications/cursor");
  if(!response.ok)throw new Error("Notification cursor unavailable");
  const {latestEventId}=parseCursorResponse(await response.json() as unknown);
  rememberCursor(storage,latestEventId);
  return latestEventId;
}
function later(left:string,right:string):boolean {return BigInt(left)>BigInt(right);}

export function NotificationToasts({onOpenCommitments,onDue}:{onOpenCommitments:()=>void;onDue:()=>void}){
  const [toasts,setToasts]=useState<readonly (DueNotification & {expiresAt:number})[]>([]);
  const [connected,setConnected]=useState(true);
  useEffect(()=>{
    let closed=false;let stream:EventSource|null=null;let retry:ReturnType<typeof setTimeout>|null=null;
    const connect=async()=>{
      try{
        let cursor=await bootstrapNotificationCursor(sessionStorage,fetch);
        if(closed)return;
        stream=new EventSource(`/api/notifications/stream?after=${encodeURIComponent(cursor)}`);
        stream.onopen=()=>setConnected(true);
        stream.onerror=()=>setConnected(false);
        const receive=(raw:Event)=>{
          const message=raw as MessageEvent<string>;
          try{
            const item=parseDueNotification(JSON.parse(message.data) as unknown,message.lastEventId);
            if(!later(item.id,cursor))return;
            cursor=item.id;rememberCursor(sessionStorage,cursor);
            if(!item.active)return;
            onDue();
            setToasts(old=>[...old,{...item,expiresAt:Date.now()+15000}].slice(-3));
          }catch{setConnected(false);}
        };
        const reset=(raw:Event)=>{
          try{cursor=parseCursorResponse(JSON.parse((raw as MessageEvent<string>).data) as unknown).latestEventId;rememberCursor(sessionStorage,cursor);}
          catch{setConnected(false);}
        };
        stream.addEventListener("commitment_due",receive);
        stream.addEventListener("notification_reset",reset);
      }catch{if(!closed){setConnected(false);retry=setTimeout(()=>{void connect();},1000);}}
    };
    void connect();
    return()=>{closed=true;if(retry!==null)clearTimeout(retry);stream?.close();};
  },[onDue]);
  useEffect(()=>{const timer=setInterval(()=>setToasts(old=>old.filter(item=>item.expiresAt>Date.now())),1000);return()=>clearInterval(timer);},[]);
  return <aside className="notification-area" aria-label="Reminders" aria-live="polite">
    {!connected?<p className="notification-connection"><span className="loading-dot"/>Live reminders reconnecting…</p>:null}
    {toasts.map(item=><div className="notification-toast" key={item.id} role="status">
      <div className="toast-heading"><span className="toast-icon" aria-hidden="true"/><div><span className="eyebrow">Commitment due</span><strong>{item.title}</strong></div></div>
      <div className="card-actions"><button className="primary-action" type="button" onClick={onOpenCommitments}>View commitment</button>
        <button className="text-action" type="button" aria-label={`Dismiss reminder for ${item.title}`} onClick={()=>setToasts(old=>old.filter(toast=>toast.id!==item.id))}>Dismiss</button></div>
    </div>)}
  </aside>;
}
