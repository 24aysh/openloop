import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

export const uuidSchema = z.uuid().brand<"UUID">();
export type UUID = z.infer<typeof uuidSchema>;

export const counterSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).brand<"Counter">();
export const versionSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"Counter">();
export type Counter = z.infer<typeof counterSchema>;

export const timestampSchema = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString()).brand<"Timestamp">();
export type Timestamp = z.infer<typeof timestampSchema>;
export const databaseTimestampSchema = z.union([z.date(), z.string()])
  .transform(value => value instanceof Date ? value.toISOString() : value)
  .pipe(timestampSchema);

export const timezoneSchema = z.string().min(1).refine(value => {
  if (!/^(UTC|[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+)$/.test(value)) return false;
  try { Temporal.Now.zonedDateTimeISO(value); return true; } catch { return false; }
}, "Invalid IANA timezone");

export const cursorSchema = z.string().max(2732).brand<"Cursor">();
export type Cursor = z.infer<typeof cursorSchema>;
export const pageRequestSchema = z.strictObject({ limit: z.number().int().min(1).max(100), cursor: cursorSchema.nullable() });
export type PageRequest = z.infer<typeof pageRequestSchema>;
export const userScopeSchema = z.strictObject({ userId: uuidSchema });
export type UserScope = z.infer<typeof userScopeSchema>;
export const versionedSchema = z.strictObject({ expectedVersion: versionSchema });
export type Versioned = z.infer<typeof versionedSchema>;

export function nextCounter(value: Counter): Counter { return counterSchema.parse((BigInt(value) + 1n).toString()); }
export function requireVersion(value: Counter): Counter { return versionSchema.parse(value); }
export function nowTimestamp(value: Date): Timestamp { return timestampSchema.parse(value.toISOString()); }

export const nonempty = (maximum: number) => z.string().trim().min(1).max(maximum);
