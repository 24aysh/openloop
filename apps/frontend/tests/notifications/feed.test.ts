import { describe,expect,test } from "bun:test";
import { bootstrapNotificationCursor,fetchNotificationActivity,parseCursorResponse,parseDueNotification,parseNotificationActivity } from "../../src/notifications/NotificationToasts";

describe("notification event boundary",()=>{
  const event={id:"12",commitmentId:"task-1",title:"Send presentation",priority:1 as const,dueAt:"2026-10-17T03:10:00.000Z",loggedAt:"2026-10-17T03:10:00.100Z",active:true};
  test("accepts a valid SSE event with the matching durable cursor",()=>{
    expect(parseDueNotification(event,"12")).toEqual(event);
  });
  test("rejects mismatched IDs, malformed dates, and invalid priorities",()=>{
    expect(()=>parseDueNotification(event,"13")).toThrow();
    expect(()=>parseDueNotification({...event,dueAt:"tomorrow"},"12")).toThrow();
    expect(()=>parseDueNotification({...event,priority:4},"12")).toThrow();
  });
  test("bootstraps a new tab at the latest durable event and reuses that cursor",async()=>{
    const values=new Map<string,string>();
    const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
    let requests=0;
    const request=async()=>{requests++;return Response.json({latestEventId:"42"});};
    expect(await bootstrapNotificationCursor(storage,request)).toBe("42");
    expect(await bootstrapNotificationCursor(storage,request)).toBe("42");
    expect(requests).toBe(1);
  });
  test("rejects an invalid cursor bootstrap response",()=>{
    expect(()=>parseCursorResponse({latestEventId:"-1"})).toThrow();
    expect(()=>parseCursorResponse({latestEventId:"9223372036854775808"})).toThrow();
    expect(()=>parseCursorResponse({latestEventId:12})).toThrow();
  });
  test("loads current activity only for the visible notification IDs",async()=>{
    let path="";
    const active=await fetchNotificationActivity(["12","13"],async input=>{path=String(input);return Response.json({activeEventIds:["13"]});});
    expect(path).toContain("ids=12%2C13");
    expect([...active]).toEqual(["13"]);
    expect([...parseNotificationActivity({activeEventIds:[]},["12"])]).toEqual([]);
    expect(()=>parseNotificationActivity({activeEventIds:["14"]},["12","13"])).toThrow();
    expect(()=>parseNotificationActivity({activeEventIds:["12","12"]},["12"])).toThrow();
  });
});
