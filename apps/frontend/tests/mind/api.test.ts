import { describe,expect,test } from "bun:test";
import { ApiError, MindApi, type Commitment, type Memory } from "../../src/mind/api";

const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
const memory:Memory={id:"memory-1",kind:"semantic",subject:"Ananya",predicate:"likes",content:"Science fiction",occurredAt:null,timeText:null,version:"1"};
const commitment:Commitment={id:"commitment-1",title:"Send presentation",subject:"Ananya",status:"open",priority:1,dueAt:null,dueTimezone:null,
  dueText:"tomorrow",duePrecision:"unresolved",version:"2",loggedAt:null};

describe("MindApi boundary",()=>{
  test("invokes the default browser transport without rebinding native fetch",async()=>{
    const originalFetch=globalThis.fetch;let receiver:unknown;
    globalThis.fetch=new Proxy(originalFetch,{apply(_target,thisArgument){receiver=thisArgument;return Promise.resolve(reply({items:[],nextCursor:null}));}});
    try{
      const api=new MindApi();
      await api.memories({},null);
      expect(receiver).not.toBe(api);
    }finally{globalThis.fetch=originalFetch;}
  });

  test("passes filters and opaque cursors to paged memory reads",async()=>{
    const paths:string[]=[];const api=new MindApi(async input=>{paths.push(String(input));return reply({items:[memory],nextCursor:"opaque+/="});});
    const first=await api.memories({text:"science fiction",kind:"semantic"},null);
    expect(first.items[0]).toEqual(memory);expect(first.nextCursor).toBe("opaque+/=");
    await api.memories({},first.nextCursor);
    expect(paths[0]).toContain("text=science+fiction");expect(paths[0]).toContain("kind=semantic");
    expect(paths[1]).toContain("cursor=opaque%2B%2F%3D");
  });

  test("rejects malformed records and exposes safe conflict codes",async()=>{
    const invalid=new MindApi(async()=>reply({items:[{...memory,version:12}],nextCursor:null}));
    await expect(invalid.memories({},null)).rejects.toMatchObject({code:"invalid_server_response"});
    const conflict=new MindApi(async()=>reply({error:{code:"version_conflict",message:"changed"}},409));
    await expect(conflict.editMemory(memory,"new text")).rejects.toEqual(new ApiError("version_conflict"));
  });

  test("submits expected versions and validates commitment and provenance data",async()=>{
    const writes:RequestInit[]=[];
    const api=new MindApi(async(input,init)=>{
      if(String(input).includes("/provenance"))return reply([{id:"change-1",entityVersion:"2",operation:"complete",actor:"reconciler",createdAt:new Date().toISOString(),
        sources:[{sessionId:"session-1",itemId:"item-1",itemOrdinal:1,contentIndex:0,evidenceText:"I sent it"}]}]);
      if(init?.method==="PATCH"){writes.push(init);return reply({...commitment,status:"completed",version:"3"});}
      return reply({items:[commitment],nextCursor:null});
    });
    expect((await api.commitments("open",null)).items[0]?.duePrecision).toBe("unresolved");
    expect((await api.provenance("commitment","commitment-1"))[0]?.sources[0]?.evidenceText).toBe("I sent it");
    expect((await api.setCommitmentStatus(commitment,"completed")).version).toBe("3");
    expect(JSON.parse(String(writes[0]?.body))).toEqual({expectedVersion:"2",status:"completed"});
  });

  test("parses the backend log time for a commitment",async()=>{
    const loggedAt="2026-10-16T21:55:00.119Z";
    const api=new MindApi(async()=>reply({items:[{...commitment,loggedAt}],nextCursor:null}));
    expect((await api.commitments("all",null)).items[0]?.loggedAt).toBe(loggedAt);
  });
  test("sends a versioned delete request for a commitment",async()=>{
    let request:RequestInit|undefined;
    const api=new MindApi(async(_path,init)=>{request=init;return reply({...commitment,status:"deleted",version:"3"});});
    expect((await api.deleteCommitment(commitment)).status).toBe("deleted");
    expect(request?.method).toBe("DELETE");
    expect(JSON.parse(String(request?.body))).toEqual({expectedVersion:"2"});
  });
});
