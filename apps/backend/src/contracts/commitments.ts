import { z } from "zod";
import { cursorSchema, nonempty, timestampSchema, timezoneSchema, uuidSchema, versionSchema } from "./common";

export const commitmentStatusSchema = z.enum(["open","completed","dismissed"]);
export const duePrecisionSchema = z.enum(["instant","date","unresolved","none"]);
export const prioritySchema = z.union([z.literal(1),z.literal(2),z.literal(3)]);
export const dueFieldsSchema = z.object({ dueAt: timestampSchema.nullable(), dueTimezone: timezoneSchema.nullable(), dueText: nonempty(500).nullable(), duePrecision: duePrecisionSchema }).refine(value => {
  if (value.duePrecision === "instant" || value.duePrecision === "date") return value.dueAt !== null && value.dueTimezone !== null && value.dueText !== null;
  if (value.duePrecision === "unresolved") return value.dueAt === null && value.dueText !== null;
  return value.dueAt === null && value.dueTimezone === null && value.dueText === null;
}, "Invalid due-time fields");
export const commitmentValueSchema = z.strictObject({
  title: nonempty(500), subject: nonempty(200).nullable(), status: commitmentStatusSchema, priority: prioritySchema,
  dueAt: timestampSchema.nullable(), dueTimezone: timezoneSchema.nullable(), dueText: nonempty(500).nullable(), duePrecision: duePrecisionSchema,
}).refine(value => dueFieldsSchema.safeParse(value).success, "Invalid due-time fields");
export type CommitmentValue = z.infer<typeof commitmentValueSchema>;
export const commitmentSchema = z.strictObject({
  id: uuidSchema, userId: uuidSchema, title: nonempty(500), subject: nonempty(200).nullable(), status: commitmentStatusSchema, priority: prioritySchema,
  dueAt: timestampSchema.nullable(), dueTimezone: timezoneSchema.nullable(), dueText: nonempty(500).nullable(), duePrecision: duePrecisionSchema,
  version: versionSchema, scheduleVersion: versionSchema, manualOverride: z.boolean(), createdAt: timestampSchema, updatedAt: timestampSchema,
  completedAt: timestampSchema.nullable(), dismissedAt: timestampSchema.nullable(),
}).refine(value => dueFieldsSchema.safeParse(value).success).refine(value =>
  value.status === "open" ? value.completedAt === null && value.dismissedAt === null
    : value.status === "completed" ? value.completedAt !== null && value.dismissedAt === null
      : value.dismissedAt !== null && value.completedAt === null);
export type Commitment = z.infer<typeof commitmentSchema>;
export const commitmentEditSchema = z.strictObject({
  expectedVersion: versionSchema, title: nonempty(500).optional(), subject: nonempty(200).nullable().optional(), status: commitmentStatusSchema.optional(), priority: prioritySchema.optional(),
  dueAt: timestampSchema.nullable().optional(), dueTimezone: timezoneSchema.nullable().optional(), dueText: nonempty(500).nullable().optional(), duePrecision: duePrecisionSchema.optional(),
  releaseManualOverride: z.literal(true).optional(),
}).refine(value => Object.keys(value).some(key => key !== "expectedVersion"), "At least one edit field is required");
export type CommitmentEdit = z.infer<typeof commitmentEditSchema>;
export const commitmentQuerySchema = z.strictObject({ status: commitmentStatusSchema.optional(), priority: prioritySchema.optional(), dueBefore: timestampSchema.optional() });
export type CommitmentQuery = z.infer<typeof commitmentQuerySchema>;
export type CommitmentPage = Readonly<{ items: readonly Commitment[]; nextCursor: z.infer<typeof cursorSchema> | null }>;
