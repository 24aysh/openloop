import { createHash } from "node:crypto";
import { z } from "zod";
import { cursorSchema, timestampSchema, uuidSchema, type Cursor } from "../contracts";
import { DomainError } from "../contracts";

const cursorPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ v: z.literal(1), kind: z.literal("memories"), filter: z.string(), updatedAt: timestampSchema, id: uuidSchema }),
  z.strictObject({ v: z.literal(1), kind: z.literal("commitments"), filter: z.string(), priority: z.union([z.literal(1),z.literal(2),z.literal(3)]), dueAt: timestampSchema.nullable(), id: uuidSchema }),
  z.strictObject({ v: z.literal(1), kind: z.literal("transcript"), filter: z.string(), ordinal: z.number().int().positive(), id: uuidSchema }),
]);
export type CursorPayload = z.infer<typeof cursorPayloadSchema>;
export type CursorKind = CursorPayload["kind"];

export function filterFingerprint(value: object): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function encodeCursor(payload: CursorPayload): Cursor { return cursorSchema.parse(Buffer.from(JSON.stringify(payload)).toString("base64url")); }
export function decodeCursor(cursor: Cursor | null, kind: CursorKind, filter: string): CursorPayload | null {
  if (cursor === null) return null;
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.byteLength(text) > 2048 || Buffer.from(text).toString("base64url") !== cursor) throw new Error("Invalid cursor encoding");
    const payload = cursorPayloadSchema.parse(JSON.parse(text));
    if (payload.kind !== kind || payload.filter !== filter) throw new Error("Cursor query mismatch");
    return payload;
  } catch { throw new DomainError("invalid_input", "Invalid pagination cursor"); }
}
