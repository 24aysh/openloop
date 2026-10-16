import { DomainError } from "./contracts/errors";

type LogValue = string | number | boolean | null;
type Component = "backend" | "http" | "session" | "transcript" | "reconciliation";

export function logOperational(component: Component, event: string, fields: Readonly<Record<string, LogValue>> = {}): void {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), component, event, ...fields })}\n`);
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    && /^[a-zA-Z0-9_]{1,40}$/.test(error.code)) return error.code;
  return "unexpected_error";
}
