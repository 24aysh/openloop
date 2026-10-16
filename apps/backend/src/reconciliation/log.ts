import type { UUID } from "../contracts";
import { logOperational } from "../operational-log";

export function logReconciliation(event: "claimed" | "applied" | "attempt_failed" | "retry" | "skip", jobId: UUID, details: {
  sessionId?: UUID; fromOrdinal?: number; throughOrdinal?: number; attempt?: number; code?: string; storedCode?: string;
  state?: "retry_wait" | "blocked"; nextAttemptAt?: string | null; proposalCount?: number; changeCount?: number; durationMs?: number;
} = {}): void {
  logOperational("reconciliation", event, { jobId, ...details });
}
