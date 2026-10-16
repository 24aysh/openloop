import { Router, type Request, type Response } from "express";
import type { UserScope } from "../contracts";
import { logOperational, safeErrorCode } from "../operational-log";
import { NotificationFeed, parseEventCursor } from "./feed";

export function createNotificationRouter(feed:NotificationFeed,scopeForRequest:(_request:Request)=>UserScope,activeStreams?:Set<()=>void>):Router {
  const router=Router();
  router.get("/api/notifications/events",async(request,response)=>{
    const cursor=parseEventCursor(request.query.after);
    response.json({items:await feed.after(scopeForRequest(request),cursor)});
  });
  router.get("/api/notifications/stream",async(request,response:Response)=>{
    let cursor=parseEventCursor(request.get("Last-Event-ID") ?? request.query.after);
    const scope=scopeForRequest(request);
    response.setHeader("Content-Type","text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control","no-cache, no-transform");
    response.setHeader("Connection","keep-alive");
    response.setHeader("X-Accel-Buffering","no");
    response.flushHeaders();
    response.write(": connected\n\n");
    let closed=false;
    let checked=false;
    let timer:ReturnType<typeof setTimeout>|null=null;
    const heartbeat=setInterval(()=>{if(!closed)response.write(": heartbeat\n\n");},15000);
    const close=()=>{
      if(closed)return;
      closed=true;if(timer)clearTimeout(timer);clearInterval(heartbeat);
      activeStreams?.delete(close);
      if(!response.writableEnded)response.end();
    };
    activeStreams?.add(close);
    response.on("close",close);
    const pump=async():Promise<void>=>{
      if(closed)return;
      try{
        if(!checked){
          const latest=await feed.latestId(scope);
          if(BigInt(cursor)>BigInt(latest)){
            cursor="0";
            response.write("event: notification_reset\ndata: {}\n\n");
          }
          checked=true;
        }
        const events=await feed.after(scope,cursor);
        for(const event of events){
          if(closed)return;
          const frame=`id: ${event.id}\nevent: commitment_due\ndata: ${JSON.stringify(event)}\n\n`;
          if(!response.write(frame)){response.end();return;}
          cursor=event.id;
        }
        if(!closed)timer=setTimeout(()=>{void pump();},events.length===50?0:1000);
      }catch(error){
        if(closed || response.destroyed)return;
        logOperational("backend","notification_stream_failed",{code:safeErrorCode(error)});
        response.end();
      }
    };
    void pump();
  });
  return router;
}
