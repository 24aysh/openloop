export type DomainErrorCode = "not_found" | "invalid_input" | "version_conflict" | "capture_closed" | "ordering_gap" | "stale_claim" | "stale_snapshot" | "dependency_blocked"
  | "active_session_exists" | "start_request_conflict" | "restart_required" | "session_not_ready" | "upstream_failure" | "setup_timeout";
export class DomainError extends Error {
  constructor(public readonly code: DomainErrorCode, message: string, public readonly details?: Readonly<Record<string, string | number | boolean>>, options?: ErrorOptions) {
    super(message, options);
    this.name = "DomainError";
  }
}
