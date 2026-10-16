import { z } from "zod";
import { counterSchema, nonempty, uuidSchema, versionSchema } from "./common";
import { memoryValueSchema } from "./memories";
import { commitmentValueSchema } from "./commitments";

export const reconciliationJobStateSchema = z.enum(["pending","running","retry_wait","succeeded","blocked","skipped"]);
export const jobClaimSchema = z.strictObject({
  userId: uuidSchema, jobId: uuidSchema, sessionId: uuidSchema, claimToken: uuidSchema, baseMindRevision: counterSchema,
  fromOrdinal: z.number().int().positive(), throughOrdinal: z.number().int().positive(), inputHash: z.string().regex(/^[0-9a-f]{64}$/),
}).refine(value => value.throughOrdinal >= value.fromOrdinal);
export type JobClaim = z.infer<typeof jobClaimSchema>;
export const evidenceRefSchema = z.strictObject({ transcriptPartId: uuidSchema, evidenceText: nonempty(4000) });
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export const memoryChangeSchema = z.strictObject({
  entity: z.literal("memory"), action: z.enum(["create","update","delete"]), targetId: uuidSchema.nullable(), expectedVersion: versionSchema.nullable(),
  value: memoryValueSchema.nullable(), sources: z.array(evidenceRefSchema).min(1),
}).refine(value => value.action === "create" ? value.targetId === null && value.expectedVersion === null && value.value !== null
  : value.targetId !== null && value.expectedVersion !== null && (value.action === "delete" ? value.value === null : value.value !== null));
export type ValidatedMemoryChange = z.infer<typeof memoryChangeSchema>;
export const commitmentChangeSchema = z.strictObject({
  entity: z.literal("commitment"), action: z.enum(["create","update","complete","dismiss","reopen"]), targetId: uuidSchema.nullable(), expectedVersion: versionSchema.nullable(),
  value: commitmentValueSchema, sources: z.array(evidenceRefSchema).min(1),
}).refine(value => value.action === "create" ? value.targetId === null && value.expectedVersion === null : value.targetId !== null && value.expectedVersion !== null);
export type ValidatedCommitmentChange = z.infer<typeof commitmentChangeSchema>;
export const validatedChangeSetSchema = z.strictObject({ changes: z.array(z.discriminatedUnion("entity", [memoryChangeSchema, commitmentChangeSchema])).max(50) });
export type ValidatedChangeSet = z.infer<typeof validatedChangeSetSchema>;
export type ApplyResult = Readonly<{ mindRevision: z.infer<typeof counterSchema>; appliedThrough: number; createdMemoryIds: readonly z.infer<typeof uuidSchema>[]; updatedMemoryIds: readonly z.infer<typeof uuidSchema>[]; createdCommitmentIds: readonly z.infer<typeof uuidSchema>[]; updatedCommitmentIds: readonly z.infer<typeof uuidSchema>[] }>;
