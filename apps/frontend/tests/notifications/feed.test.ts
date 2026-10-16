import { describe,expect,test } from "bun:test";
import { parseDueNotification } from "../../src/notifications/NotificationToasts";

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
});
