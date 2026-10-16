import { z } from "zod";
import { DomainError, normalizedEventSchema, timestampSchema, type NormalizeResult, type Timestamp } from "../contracts";

const object = z.record(z.string(), z.unknown());
const id = z.string().min(1).max(256);
const nonnegative = z.number().int().min(0).max(2_147_483_647);
function parse<T>(schema:z.ZodType<T>, value:unknown):T {
  const result=schema.safeParse(value);
  if(!result.success) throw new DomainError("invalid_input","Malformed Realtime event");
  return result.data;
}
function predecessor(raw:Record<string,unknown>):{predecessorKnown:boolean;previousItemId:string|null} {
  if(!Object.hasOwn(raw,"previous_item_id")) return {predecessorKnown:false,previousItemId:null};
  return {predecessorKnown:true,previousItemId:parse(id.nullable(),raw.previous_item_id)};
}
function event(value:unknown):NormalizeResult { return {kind:"event",event:parse(normalizedEventSchema,value)}; }
const ignoredTypes=new Set(["response.content_part.done","response.output_item.added","response.output_item.done","response.output_text.done","response.output_audio_transcript.done","response.output_audio.done",
  "conversation.item.input_audio_transcription.segment","input_audio_buffer.timeout_triggered","input_audio_buffer.dtmf_event_received"]);

export function normalizeServerEvent(payload:unknown,receivedAt:Timestamp):NormalizeResult {
  parse(timestampSchema,receivedAt);
  const raw=parse(object,payload);
  const type=parse(z.string(),raw.type);
  if(type.endsWith(".delta") || ignoredTypes.has(type) || type==="response.created" || type==="session.updated" || type==="response.content_part.added") return {kind:"ignored"};
  const eventId=parse(id,raw.event_id);
  const common={eventId,receivedAt};
  if(type==="conversation.item.created" || type==="conversation.item.added" || type==="conversation.item.done") {
    const item=parse(object,raw.item);
    const itemId=parse(id,item.id);
    const itemType=parse(id,item.type);
    const role=item.role===undefined?"unknown":item.role==="user"||item.role==="assistant"?item.role:"other";
    const status=item.status===undefined?"unknown":parse(z.enum(["in_progress","completed","incomplete"]),item.status);
    const content=item.content===undefined?null:parse(z.array(object).max(100),item.content);
    const layoutKnown=role==="user" && status==="completed" && content!==null && content.length>0;
    const unsupported=itemType!=="message" || role==="other" || (layoutKnown && !content.every(part=>part.type==="input_audio"));
    // added/created establish the insertion position. done finalizes the same item and
    // may repeat inconsistent predecessor metadata, so it must not move an item.
    const ordering=type==="conversation.item.done"?{predecessorKnown:false,previousItemId:null}:predecessor(raw);
    return event({...common,kind:"item",itemId,...ordering,role,itemType,itemStatus:status,
      expectedParts:layoutKnown && !unsupported ? content.length:null,unsupported});
  }
  if(type==="input_audio_buffer.committed") return event({...common,kind:"committed",itemId:parse(id,raw.item_id),...predecessor(raw)});
  if(type==="input_audio_buffer.speech_started" || type==="input_audio_buffer.speech_stopped") {
    const started=type.endsWith("started");
    return event({...common,kind:"speech",itemId:parse(id,raw.item_id),boundary:started?"started":"stopped",
      audioMs:parse(nonnegative,raw[started?"audio_start_ms":"audio_end_ms"])});
  }
  if(type==="conversation.item.input_audio_transcription.completed") return event({...common,kind:"user_final",itemId:parse(id,raw.item_id),contentIndex:parse(nonnegative,raw.content_index),text:parse(z.string().max(100_000),raw.transcript)});
  if(type==="conversation.item.input_audio_transcription.failed") {
    const details=raw.error===undefined?{}:parse(object,raw.error);
    const errorCode=typeof details.code==="string" && details.code.length>0 && details.code.length<=256 ? details.code:"transcription_failed";
    return event({...common,kind:"user_failed",itemId:parse(id,raw.item_id),contentIndex:parse(nonnegative,raw.content_index),errorCode});
  }
  if(type==="response.done") {
    const response=parse(object,raw.response);
    const status=parse(z.enum(["completed","cancelled","failed","incomplete"]),response.status);
    const outputs=response.output===undefined?[]:parse(z.array(object).max(100),response.output);
    const items=outputs.map(output=>{
      const itemId=parse(id,output.id);
      const itemStatus=output.status===undefined?"in_progress":parse(z.enum(["completed","incomplete","in_progress"]),output.status);
      const content=output.content===undefined?[]:parse(z.array(object).max(100),output.content);
      let unsupported=output.type!=="message" || output.role!=="assistant";
      const parts:{contentIndex:number;kind:"assistant_audio"|"assistant_text";text:string}[]=[];
      content.forEach((part,contentIndex)=>{
        if(part.type==="output_audio" && typeof part.transcript==="string") {parts.push({contentIndex,kind:"assistant_audio",text:part.transcript});return;}
        if(part.type==="output_text" && typeof part.text==="string") {parts.push({contentIndex,kind:"assistant_text",text:part.text});return;}
        if(part.type!=="output_audio" && part.type!=="output_text") unsupported=true;
      });
      return {itemId,status:itemStatus,unsupported,parts};
    });
    return event({...common,kind:"assistant_response",responseId:parse(id,response.id),status,items});
  }
  if(type==="conversation.item.truncated") return event({...common,kind:"truncated",itemId:parse(id,raw.item_id),contentIndex:parse(nonnegative,raw.content_index),audioEndMs:parse(nonnegative,raw.audio_end_ms)});
  if(type==="conversation.item.deleted") return event({...common,kind:"deleted",itemId:parse(id,raw.item_id)});
  if(type.startsWith("conversation.item.") || type.startsWith("input_audio_buffer.")) throw new DomainError("invalid_input","Unsupported Realtime conversation event");
  return {kind:"ignored"};
}
