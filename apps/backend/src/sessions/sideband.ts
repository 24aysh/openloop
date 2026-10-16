import { z } from "zod";
import { DomainError } from "../contracts";

const envelope=z.object({type:z.string().min(1).max(256)}).passthrough();
const sessionEvent=envelope.extend({session:z.unknown()});

export type ParsedSidebandMessage=
  | Readonly<{kind:"session_created"|"session_updated";session:unknown}>
  | Readonly<{kind:"provider_error"}>
  | Readonly<{kind:"event";payload:Readonly<Record<string,unknown>>}>;

export function parseSidebandMessage(text:string,isBinary:boolean):ParsedSidebandMessage {
  if(isBinary || Buffer.byteLength(text,"utf8")>1_048_576) throw new DomainError("invalid_input","Invalid Realtime sideband message");
  let raw:unknown;
  try {raw=JSON.parse(text);} catch(error){throw new DomainError("invalid_input","Invalid Realtime sideband message",undefined,{cause:error});}
  const parsed=envelope.safeParse(raw);
  if(!parsed.success) throw new DomainError("invalid_input","Invalid Realtime sideband message");
  if(parsed.data.type==="session.created" || parsed.data.type==="session.updated"){
    const event=sessionEvent.safeParse(raw);
    if(!event.success) throw new DomainError("invalid_input","Invalid Realtime session event");
    return {kind:parsed.data.type==="session.created"?"session_created":"session_updated",session:event.data.session};
  }
  if(parsed.data.type==="error") return {kind:"provider_error"};
  return {kind:"event",payload:parsed.data};
}
