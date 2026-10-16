import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common";

export const transcriptRoleSchema = z.enum(["unknown","user","assistant","other"]);
export const transcriptStateSchema = z.enum(["pending","complete","failed","interrupted","excluded"]);
export const transcriptPartKindSchema = z.enum(["user_audio","assistant_audio","assistant_text"]);
export const transcriptItemSchema = z.strictObject({
  id: uuidSchema, userId: uuidSchema, sessionId: uuidSchema, providerItemId: z.string(), predecessorKnown: z.boolean(), previousItemId: z.string().nullable(),
  ordinal: z.number().int().positive().nullable(), role: transcriptRoleSchema, itemType: z.string().nullable(), state: transcriptStateSchema,
  expectedParts: z.number().int().min(0).nullable(), providerResponseId: z.string().nullable(), firstSeenAt: timestampSchema, updatedAt: timestampSchema,
  committedAt: timestampSchema.nullable(), timeAnchorAt: timestampSchema.nullable(), speechStartedAt: timestampSchema.nullable(), speechStoppedAt: timestampSchema.nullable(),
  audioStartMs: z.number().int().min(0).nullable(), audioEndMs: z.number().int().min(0).nullable(), terminalAt: timestampSchema.nullable(), errorCode: z.string().nullable(),
});
export type TranscriptItem = z.infer<typeof transcriptItemSchema>;
export const transcriptPartSchema = z.strictObject({
  id: uuidSchema, userId: uuidSchema, itemId: uuidSchema, contentIndex: z.number().int().min(0), kind: transcriptPartKindSchema,
  finalText: z.string().nullable(), state: transcriptStateSchema, finalEventId: z.string().nullable(), textHash: z.string().nullable(),
  completedAt: timestampSchema.nullable(), errorCode: z.string().nullable(),
});
export type TranscriptPart = z.infer<typeof transcriptPartSchema>;
export type TranscriptTurn = Readonly<{ item: TranscriptItem; parts: readonly TranscriptPart[] }>;
export type TranscriptGap = Readonly<{ item: TranscriptItem; reason: "unplaced" | "pending" | "failed" | "excluded" }>;
export type TranscriptPage = Readonly<{ items: readonly TranscriptTurn[]; gaps: readonly TranscriptGap[]; nextCursor: string | null }>;
