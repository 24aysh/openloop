export type Memory=Readonly<{id:string;kind:"semantic"|"episodic";subject:string;predicate:string;content:string;
  occurredAt:string|null;timeText:string|null;version:string}>;
export type Commitment=Readonly<{id:string;title:string;subject:string|null;status:"open"|"completed"|"dismissed";
  priority:1|2|3;dueAt:string|null;dueTimezone:string|null;dueText:string|null;duePrecision:"instant"|"date"|"unresolved"|"none";
  version:string;loggedAt:string|null}>;
export type Page<T>=Readonly<{items:readonly T[];nextCursor:string|null}>;
export type Source=Readonly<{sessionId:string;itemId:string;itemOrdinal:number;contentIndex:number;evidenceText:string}>;
export type Change=Readonly<{id:string;entityVersion:string;operation:string;actor:"reconciler"|"user";createdAt:string;sources:readonly Source[]}>;
export type Transcript=Readonly<{items:readonly Readonly<{item:Readonly<{id:string;ordinal:number|null;role:string;state:string;errorCode:string|null}>;
  parts:readonly Readonly<{contentIndex:number;state:string;finalText:string|null;errorCode:string|null}>[]}>[];
  gaps:readonly Readonly<{reason:string;item:Readonly<{id:string;errorCode:string|null}>}>[];nextCursor:string|null}>;

export class ApiError extends Error {
  constructor(readonly code:string){super(code);this.name="ApiError";}
}
const browserRequest=(path:string,init?:RequestInit):Promise<Response>=>fetch(path,init);
const record=(value:unknown):Record<string,unknown>=>{
  if(typeof value!=="object"||value===null||Array.isArray(value)) throw new ApiError("invalid_server_response");
  return value as Record<string,unknown>;
};
const string=(value:unknown):string=>{if(typeof value!=="string")throw new ApiError("invalid_server_response");return value;};
const optionalString=(value:unknown):string|null=>value===null?null:string(value);
const integer=(value:unknown):number=>{if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0)throw new ApiError("invalid_server_response");return value;};
const choice=<T extends string>(value:unknown,allowed:readonly T[]):T=>{if(typeof value!=="string"||!allowed.includes(value as T))throw new ApiError("invalid_server_response");return value as T;};

function memory(value:unknown):Memory {
  const row=record(value);
  return {id:string(row.id),kind:choice(row.kind,["semantic","episodic"]),subject:string(row.subject),predicate:string(row.predicate),
    content:string(row.content),occurredAt:optionalString(row.occurredAt),timeText:optionalString(row.timeText),version:string(row.version)};
}
function commitment(value:unknown):Commitment {
  const row=record(value);const priority=integer(row.priority);
  if(priority!==1&&priority!==2&&priority!==3)throw new ApiError("invalid_server_response");
  return {id:string(row.id),title:string(row.title),subject:optionalString(row.subject),status:choice(row.status,["open","completed","dismissed"]),
    priority,dueAt:optionalString(row.dueAt),dueTimezone:optionalString(row.dueTimezone),dueText:optionalString(row.dueText),
    duePrecision:choice(row.duePrecision,["instant","date","unresolved","none"]),version:string(row.version),
    loggedAt:row.loggedAt===undefined?null:optionalString(row.loggedAt)};
}
function page<T>(value:unknown,parse:(item:unknown)=>T):Page<T>{
  const row=record(value);if(!Array.isArray(row.items))throw new ApiError("invalid_server_response");
  return {items:row.items.map(parse),nextCursor:optionalString(row.nextCursor)};
}
function changes(value:unknown):readonly Change[]{
  if(!Array.isArray(value))throw new ApiError("invalid_server_response");
  return value.map(raw=>{const row=record(raw);if(!Array.isArray(row.sources))throw new ApiError("invalid_server_response");
    return {id:string(row.id),entityVersion:string(row.entityVersion),operation:string(row.operation),actor:choice(row.actor,["reconciler","user"]),
      createdAt:string(row.createdAt),sources:row.sources.map(rawSource=>{const source=record(rawSource);return {
        sessionId:string(source.sessionId),itemId:string(source.itemId),itemOrdinal:integer(source.itemOrdinal),
        contentIndex:integer(source.contentIndex),evidenceText:string(source.evidenceText),
      };})};});
}
function transcript(value:unknown):Transcript {
  const row=record(value);if(!Array.isArray(row.items)||!Array.isArray(row.gaps))throw new ApiError("invalid_server_response");
  return {nextCursor:optionalString(row.nextCursor),items:row.items.map(raw=>{
    const turn=record(raw),item=record(turn.item);if(!Array.isArray(turn.parts))throw new ApiError("invalid_server_response");
    return {item:{id:string(item.id),ordinal:item.ordinal===null?null:integer(item.ordinal),role:string(item.role),state:string(item.state),errorCode:optionalString(item.errorCode)},
      parts:turn.parts.map(rawPart=>{const part=record(rawPart);return {contentIndex:integer(part.contentIndex),state:string(part.state),
        finalText:optionalString(part.finalText),errorCode:optionalString(part.errorCode)};})};
  }),gaps:row.gaps.map(raw=>{const gap=record(raw),item=record(gap.item);return {reason:string(gap.reason),item:{id:string(item.id),errorCode:optionalString(item.errorCode)}};})};
}

export class MindApi {
  constructor(private readonly request:(path:string,init?:RequestInit)=>Promise<Response>=browserRequest){}
  private async send(path:string,signal?:AbortSignal,init?:RequestInit):Promise<unknown>{
    let response:Response;
    try{response=await this.request(path,{...init,signal});}catch(error){if(signal?.aborted)throw error;throw new ApiError("backend_unreachable");}
    let body:unknown;try{body=await response.json();}catch{throw new ApiError("invalid_server_response");}
    if(!response.ok){const error=record(body).error;const code=error&&typeof error==="object"&&"code" in error&&typeof error.code==="string"?error.code:"request_failed";
      throw new ApiError(code);}
    return body;
  }
  async memories(filters:{text?:string;kind?:"semantic"|"episodic"},cursor:string|null,signal?:AbortSignal):Promise<Page<Memory>>{
    const query=new URLSearchParams({limit:"50"});if(filters.text)query.set("text",filters.text);if(filters.kind)query.set("kind",filters.kind);if(cursor)query.set("cursor",cursor);
    return page(await this.send(`/api/mind/memories?${query}`,signal),memory);
  }
  async commitments(status:"all"|Commitment["status"],cursor:string|null,signal?:AbortSignal):Promise<Page<Commitment>>{
    const query=new URLSearchParams({limit:"50"});if(status!=="all")query.set("status",status);if(cursor)query.set("cursor",cursor);
    return page(await this.send(`/api/commitments?${query}`,signal),commitment);
  }
  async provenance(type:"memory"|"commitment",id:string,signal?:AbortSignal):Promise<readonly Change[]>{
    return changes(await this.send(`/api/mind/${type}/${encodeURIComponent(id)}/provenance`,signal));
  }
  async transcript(sessionId:string,cursor:string|null,signal?:AbortSignal):Promise<Transcript>{
    const query=new URLSearchParams({limit:"50"});if(cursor)query.set("cursor",cursor);
    return transcript(await this.send(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?${query}`,signal));
  }
  async editMemory(item:Memory,content:string,signal?:AbortSignal):Promise<Memory>{
    return memory(await this.send(`/api/mind/memories/${encodeURIComponent(item.id)}`,signal,{method:"PATCH",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({expectedVersion:item.version,content})}));
  }
  async deleteMemory(item:Memory,signal?:AbortSignal):Promise<Memory>{
    return memory(await this.send(`/api/mind/memories/${encodeURIComponent(item.id)}`,signal,{method:"DELETE",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({expectedVersion:item.version})}));
  }
  async setCommitmentStatus(item:Commitment,status:Commitment["status"],signal?:AbortSignal):Promise<Commitment>{
    return commitment(await this.send(`/api/commitments/${encodeURIComponent(item.id)}`,signal,{method:"PATCH",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({expectedVersion:item.version,status})}));
  }
}
