import { z } from "zod";
import { nonempty, timestampSchema, uuidSchema, versionSchema, cursorSchema } from "./common";

export const memoryKindSchema = z.enum(["semantic","episodic"]);
export const memoryStateSchema = z.enum(["active","deleted"]);
export const memorySchema = z.strictObject({
  id: uuidSchema, userId: uuidSchema, kind: memoryKindSchema, subject: nonempty(200), predicate: nonempty(200), content: nonempty(4000),
  occurredAt: timestampSchema.nullable(), timeText: nonempty(500).nullable(), state: memoryStateSchema, version: versionSchema,
  manualOverride: z.boolean(), createdAt: timestampSchema, updatedAt: timestampSchema,
}).refine(value => value.kind !== "semantic" || value.occurredAt === null);
export type Memory = z.infer<typeof memorySchema>;
export const memoryValueSchema = z.strictObject({
  kind: memoryKindSchema, subject: nonempty(200), predicate: nonempty(200), content: nonempty(4000),
  occurredAt: timestampSchema.nullable(), timeText: nonempty(500).nullable(),
}).refine(value => value.kind !== "semantic" || value.occurredAt === null);
export type MemoryValue = z.infer<typeof memoryValueSchema>;
export const memoryEditSchema = z.strictObject({
  expectedVersion: versionSchema, content: nonempty(4000).optional(), subject: nonempty(200).optional(), predicate: nonempty(200).optional(),
  occurredAt: timestampSchema.nullable().optional(), timeText: nonempty(500).nullable().optional(), releaseManualOverride: z.literal(true).optional(),
}).refine(value => Object.keys(value).some(key => key !== "expectedVersion"), "At least one edit field is required");
export type MemoryEdit = z.infer<typeof memoryEditSchema>;
export const memoryQuerySchema = z.strictObject({ state: memoryStateSchema.optional(), kind: memoryKindSchema.optional(), subject: nonempty(200).optional(), text: nonempty(500).optional() });
export type MemoryQuery = z.infer<typeof memoryQuerySchema>;
export type MemoryPage = Readonly<{ items: readonly Memory[]; nextCursor: z.infer<typeof cursorSchema> | null }>;
