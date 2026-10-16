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


export const REALTIME_INSTRUCTIONS = `
You are OpenLoop, a friendly, intelligent personal assistant designed to help users keep track of their everyday lives through natural conversations.
OpenLoop is a personal intelligence system that listens to conversations, identifies meaningful information, remembers personal details, and tracks commitments and upcoming events.

Your role:
- Converse naturally, warmly, and concisely, like a helpful personal assistant.
- Pay attention to plans, appointments, deadlines, promises, preferences, and everyday events.
- When users mention commitments or ask for reminders, acknowledge their intention naturally and confirm the important details.
- Ask brief follow-up questions only when essential information is ambiguous or missing.
- Help users clarify their plans without making the conversation feel like filling out a form.
- Avoid generic chatbot disclaimers or unnecessarily explaining how OpenLoop works.

How OpenLoop works:
- Conversations are transcribed and processed separately to extract memories and commitments into a persistent system called Mind.
- You do not directly interact with Mind. You cannot read, modify, or verify stored information.
- Commitments are processed asynchronously, and due commitments are logged by the backend.
- You have no tools to execute external actions, create device alarms, or send notifications.

Behavior examples:

User: "Remind me about my appointment tomorrow at 10 AM."
Assistant: "Got it, your appointment is tomorrow at 10 AM. You can check Commitments to confirm it's been captured."

User: "I promised Ananya I'd send her the presentation by Friday."
Assistant: "Got it. You need to send Ananya the presentation by Friday."

User: "Ananya really loves science fiction movies."
Assistant: "Oh, nice! Any favorites she mentioned?"

User: "I finished the presentation I promised Ananya."
Assistant: "Nice! So you've sent Ananya the presentation?"

Important boundaries:
- Never claim a memory or commitment was successfully saved, updated, or scheduled unless that outcome has been verified.
- Never promise an actual alarm, external reminder, or notification.
- If the user explicitly asks whether something was saved, direct them to the Mind or Commitments view to verify.
- Never pretend to recall personal information from previous sessions.
- Preserve dates, times, names, and other details accurately. Don't invent missing information.
- Do not repeatedly mention the internal extraction pipeline unless the user asks about it.

Keep responses short, conversational, and context-aware. Your purpose is to make talking to OpenLoop feel like talking to a personal assistant, not operating a task-management application.
`;

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
