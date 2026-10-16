import { z } from "zod";
import { timezoneSchema, uuidSchema, type Counter, type Timestamp, type UserScope, type UUID } from "./common";
import { voiceSessionStateSchema, type VoiceSessionState } from "./sessions";

export const providerIdentifierSchema=z.string().min(1).max(256).refine(value=>value.trim()===value && !value.includes("/"));
export const sdpSchema=z.string().min(1).refine(value=>!value.includes("\0") && Buffer.byteLength(value,"utf8")<=65_536,"SDP exceeds 64 KiB");
export const startSessionRequestSchema=z.strictObject({startRequestId:uuidSchema,sdpOffer:sdpSchema,timezone:timezoneSchema});
export type StartSessionRequest=z.infer<typeof startSessionRequestSchema>;
export const startSessionResponseSchema=z.strictObject({sessionId:uuidSchema,sdpAnswer:sdpSchema,state:z.literal("connecting")});
export type StartSessionResponse=z.infer<typeof startSessionResponseSchema>;
export const sessionStatusSchema=z.strictObject({sessionId:uuidSchema,state:voiceSessionStateSchema,captureReady:z.boolean(),orderedThrough:z.number().int().min(0),
  sealedThrough:z.number().int().min(0),appliedThrough:z.number().int().min(0),reconciliationBacklog:z.number().int().min(0),
  blockedReconciliationJobs:z.number().int().min(0),transcriptGapCount:z.number().int().min(0),
  closeReason:z.string().nullable(),errorCode:z.string().nullable()});
export type SessionStatus=z.infer<typeof sessionStatusSchema>;

export type RealtimeSettings=Readonly<{model:string;transcriptionModel:string;voice:string;instructions:string}>;
export type RealtimeSessionConfig=Readonly<Record<string,unknown>>;
export type CreateCallInput=Readonly<{sdpOffer:string;session:RealtimeSessionConfig}>;
export type SidebandHandlers=Readonly<{onOpen:()=>void;onMessage:(text:string,isBinary:boolean)=>void;onError:(error:unknown)=>void;onClose:(code:number)=>void}>;
export interface SidebandConnection { send(payload:unknown):void; close():void; readonly closed:Promise<void>; }
export interface RealtimeGateway {
  createCall(input:CreateCallInput,signal:AbortSignal):Promise<Readonly<{callId:string;sdpAnswer:string}>>;
  connectSideband(callId:string,handlers:SidebandHandlers):SidebandConnection;
  hangup(callId:string,signal:AbortSignal):Promise<void>;
}
export interface SessionControllerContract {
  start(scope:UserScope,request:StartSessionRequest):Promise<Readonly<{response:StartSessionResponse;replayed:boolean}>>;
  status(scope:UserScope,sessionId:UUID):Promise<SessionStatus>;
  activate(scope:UserScope,sessionId:UUID):Promise<SessionStatus>;
  heartbeat(scope:UserScope,sessionId:UUID):Promise<SessionStatus>;
  close(scope:UserScope,sessionId:UUID):Promise<SessionStatus>;
}
export type SessionRuntimeIdentity=Readonly<{sessionId:UUID;scope:UserScope;epoch:Counter;createdAt:Timestamp}>;
export type SessionStateRecord=Readonly<{id:UUID;userId:UUID;state:VoiceSessionState;captureEpoch:Counter;callId:string|null;realtimeSessionId:string|null;
  createdAt:Date;activatedAt:Date|null;closeRequestedAt:Date|null;lastClientHeartbeatAt:Date|null}>;
