import { z } from "zod";
import type { RealtimeSessionConfig, RealtimeSettings } from "../contracts";

const effectiveSessionSchema=z.object({
  id:z.string().min(1).max(256),
  model:z.string().min(1),
  tools:z.array(z.unknown()),
  tool_choice:z.string(),
  audio:z.object({
    input:z.object({
      transcription:z.object({model:z.string().min(1)}).passthrough(),
      turn_detection:z.object({type:z.literal("server_vad"),threshold:z.number(),prefix_padding_ms:z.number(),silence_duration_ms:z.number(),create_response:z.boolean(),interrupt_response:z.boolean()}).passthrough(),
    }).passthrough(),
    output:z.object({voice:z.string().min(1)}).passthrough(),
  }).passthrough(),
}).passthrough();

export const REALTIME_INSTRUCTIONS=`You are Openloop, a concise conversational assistant. Listen naturally and respond helpfully. You do not have access to the user's saved Mind in this session, so never claim to remember stored personal information. Do not call tools or claim that you performed external actions.`;

export function buildRealtimeSessionConfig(settings:RealtimeSettings):RealtimeSessionConfig {
  return {
    type:"realtime",model:settings.model,instructions:settings.instructions,output_modalities:["audio"],tools:[],tool_choice:"none",
    audio:{input:{transcription:{model:settings.transcriptionModel},turn_detection:{type:"server_vad",threshold:0.5,prefix_padding_ms:300,silence_duration_ms:500,create_response:true,interrupt_response:true}},output:{voice:settings.voice}},
  };
}

export function buildSidebandUpdate(settings:RealtimeSettings):Readonly<Record<string,unknown>> {
  const full=buildRealtimeSessionConfig(settings);
  const audio=(full.audio as {input:unknown});
  return {type:"session.update",event_id:`openloop_config_${crypto.randomUUID()}`,session:{type:"realtime",instructions:settings.instructions,tools:[],tool_choice:"none",audio:{input:audio.input}}};
}

export function parseEffectiveSession(value:unknown,settings:RealtimeSettings):Readonly<{id:string;matches:boolean}> {
  const session=effectiveSessionSchema.parse(value);
  const input=session.audio.input;
  const vad=input.turn_detection;
  const matches=session.model===settings.model && session.audio.output.voice===settings.voice && session.tools.length===0 && session.tool_choice==="none"
    && input.transcription.model===settings.transcriptionModel && vad.type==="server_vad" && vad.threshold===0.5 && vad.prefix_padding_ms===300
    && vad.silence_duration_ms===500 && vad.create_response && vad.interrupt_response;
  return {id:session.id,matches};
}
