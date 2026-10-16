import type { UUID } from "../contracts";

export function logReconciliation(event: "claimed" | "applied" | "failed" | "retry" | "skip", jobId: UUID, details: { attempt?: number; code?: string; durationMs?: number } = {}): void {
  process.stderr.write(`${JSON.stringify({ component: "reconciliation", event, jobId, ...details })}\n`);
}
