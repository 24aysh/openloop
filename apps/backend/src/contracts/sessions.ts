import { z } from "zod";
import { counterSchema, timestampSchema, uuidSchema, timezoneSchema } from "./common";

export const voiceSessionStateSchema = z.enum(["initializing","connecting","active","draining","closed","incomplete","failed"]);
export type VoiceSessionState = z.infer<typeof voiceSessionStateSchema>;
export const voiceSessionSchema = z.strictObject({
  id: uuidSchema, userId: uuidSchema, sessionSeq: counterSchema, startRequestId: uuidSchema,
  offerHash: z.string().regex(/^[0-9a-f]{64}$/), callId: z.string().nullable(), realtimeSessionId: z.string().nullable(),
  state: voiceSessionStateSchema, timezone: timezoneSchema, createdAt: timestampSchema, updatedAt: timestampSchema,
  activatedAt: timestampSchema.nullable(), closedAt: timestampSchema.nullable(), closeRequestedAt: timestampSchema.nullable(),
  lastClientHeartbeatAt: timestampSchema.nullable(), lastSidebandEventAt: timestampSchema.nullable(),
  captureEpoch: counterSchema, orderedThrough: z.number().int().min(0), sealedThrough: z.number().int().min(0), appliedThrough: z.number().int().min(0),
  closeReason: z.string().nullable(), errorCode: z.string().nullable(),
});
export type VoiceSession = z.infer<typeof voiceSessionSchema>;
