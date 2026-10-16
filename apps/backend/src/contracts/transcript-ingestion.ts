import { z } from "zod";
import { counterSchema, timestampSchema, uuidSchema, type UUID } from "./common";
import { transcriptRoleSchema } from "./transcripts";

const providerId = z.string().min(1).max(256).refine(value=>value.trim()===value);
const index = z.number().int().min(0).max(100);
const audioOffset = z.number().int().min(0).max(2_147_483_647);
const base = z.object({ eventId: providerId, receivedAt: timestampSchema });
const predecessor = { predecessorKnown: z.boolean(), previousItemId: providerId.nullable() };
const itemId = { itemId: providerId };

export const normalizedEventSchema = z.discriminatedUnion("kind", [
  base.extend({ kind: z.literal("item"), ...itemId, ...predecessor, role: transcriptRoleSchema,
    itemType: providerId, itemStatus: z.enum(["in_progress","completed","incomplete","unknown"]),
    expectedParts: index.nullable(), unsupported: z.boolean() }).strict(),
  base.extend({ kind: z.literal("committed"), ...itemId, ...predecessor }).strict(),
  base.extend({ kind: z.literal("speech"), ...itemId, boundary: z.enum(["started","stopped"]), audioMs: audioOffset }).strict(),
  base.extend({ kind: z.literal("user_final"), ...itemId, contentIndex: index, text: z.string().max(100_000) }).strict(),
  base.extend({ kind: z.literal("user_failed"), ...itemId, contentIndex: index, errorCode: providerId }).strict(),
  base.extend({ kind: z.literal("assistant_response"), responseId: providerId,
    status: z.enum(["completed","cancelled","failed","incomplete"]),
    items: z.array(z.object({ itemId: providerId, status: z.enum(["completed","incomplete","in_progress"]), unsupported: z.boolean(),
      parts: z.array(z.object({ contentIndex: index, kind: z.enum(["assistant_audio","assistant_text"]), text: z.string().max(100_000) }).strict()).max(100) }).strict()).max(100) }).strict(),
  base.extend({ kind: z.literal("truncated"), ...itemId, contentIndex: index, audioEndMs: z.number().int().min(0).max(2_147_483_647) }).strict(),
  base.extend({ kind: z.literal("deleted"), ...itemId }).strict(),
]);
export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;
export type NormalizeResult = Readonly<{kind:"event";event:NormalizedEvent}|{kind:"ignored"}>;
export const closeReasonSchema = z.enum(["clean","drain_timeout","gap_timeout","sideband_lost","browser_lost","queue_overflow","integrity_error","restart"]);
export type CloseReason = z.infer<typeof closeReasonSchema>;
export type IngestResult = Readonly<{status:"stored"|"duplicate"|"ignored"|"capture_closed";sessionId:UUID;itemId:UUID|null}>;
export type BatchResult = Readonly<{jobs:readonly Readonly<{id:UUID;fromOrdinal:number;throughOrdinal:number}>[];orderedThrough:number;sealedThrough:number}>;
export type CaptureSummary = Readonly<{state:"draining"|"closed"|"incomplete";sealedThrough:number;reason:CloseReason|null}>;
export type JobSettings = Readonly<{model:string;promptVersion:string;schemaVersion:string}>;
export const jobSettingsSchema = z.strictObject({model:providerId,promptVersion:providerId,schemaVersion:providerId});
export type Clock = () => Date;
export const captureEpochSchema = counterSchema;
export const sessionIdentitySchema = uuidSchema;
