import { afterAll,beforeAll,beforeEach,describe,expect,test } from "bun:test";
import express from "express";
import type pg from "pg";
import { errorResponse } from "../../src/http/error-response";
import { NotificationFeed,parseEventCursor } from "../../src/notifications/feed";
import { createNotificationRouter } from "../../src/notifications/routes";
import { CommitmentScheduler,CommitmentLogEmitter } from "../../src/scheduling";
import { clearTestDatabase,createTestPool,prepareTestDatabase } from "../helpers/database";
import { seedCommitment,seedUser,userId } from "../helpers/factories";

let pool:pg.Pool;
beforeAll(async()=>{pool=createTestPool();await prepareTestDatabase(pool);});
beforeEach(async()=>{await clearTestDatabase(pool);});
afterAll(async()=>{await pool?.end();});

describe("notification delivery feed",()=>{
  test("validates replay cursors",()=>{
    expect(parseEventCursor(undefined)).toBe("0");
    expect(parseEventCursor("12")).toBe("12");
    expect(()=>parseEventCursor("-1")).toThrow();
    expect(()=>parseEventCursor("9223372036854775808")).toThrow();
  });
  test("SSE resumes after Last-Event-ID and only sends later durable events",async()=>{
    await seedUser(pool);
    const past=new Date(Date.now()-60_000).toISOString();
    await seedCommitment(pool,undefined,userId,past);
    await seedCommitment(pool,undefined,userId,past);
    await new CommitmentScheduler(pool).tick();
    await new CommitmentLogEmitter(pool,{emit:async()=>{}}).flush();
    const events=await new NotificationFeed(pool).after({userId},"0");
    expect(events).toHaveLength(2);
    const streams=new Set<()=>void>();
    const app=express();app.use(createNotificationRouter(new NotificationFeed(pool),()=>({userId}),streams));app.use(errorResponse);
    const server=app.listen(0,"127.0.0.1");
    try{
      const address=server.address();if(!address || typeof address==="string")throw new Error("Missing test server port");
      const cursorResponse=await fetch(`http://127.0.0.1:${address.port}/api/notifications/cursor`);
      expect(cursorResponse.status).toBe(200);
      expect(await cursorResponse.json()).toEqual({latestEventId:events[1]!.id});
      const controller=new AbortController();
      const response=await fetch(`http://127.0.0.1:${address.port}/api/notifications/stream?after=0`,{
        headers:{"Last-Event-ID":events[0]!.id},signal:controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader=response.body?.getReader();if(!reader)throw new Error("Missing SSE body");
      let body="";
      while(!body.includes(`id: ${events[1]!.id}\n`)){
        const chunk=await reader.read();if(chunk.done)throw new Error("SSE stream ended early");body+=new TextDecoder().decode(chunk.value);
      }
      expect(body).toContain(`event: commitment_due`);
      expect(body).not.toContain(`id: ${events[0]!.id}\n`);
      controller.abort();
      const resetController=new AbortController();
      const resetResponse=await fetch(`http://127.0.0.1:${address.port}/api/notifications/stream?after=999`,{signal:resetController.signal});
      const resetReader=resetResponse.body?.getReader();if(!resetReader)throw new Error("Missing reset body");
      let resetBody="";
      while(!resetBody.includes(`data: ${JSON.stringify({latestEventId:events[1]!.id})}\n`)){
        const chunk=await resetReader.read();if(chunk.done)throw new Error("Reset stream ended early");resetBody+=new TextDecoder().decode(chunk.value);
      }
      expect(resetBody).toContain("event: notification_reset");
      expect(resetBody).toContain(`id: ${events[1]!.id}\n`);
      expect(resetBody).toContain(`data: ${JSON.stringify({latestEventId:events[1]!.id})}`);
      expect(resetBody).not.toContain(`id: ${events[0]!.id}\n`);
      resetController.abort();
      for(const close of streams)close();
      expect(streams.size).toBe(0);
    }finally{
      server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  });
});
