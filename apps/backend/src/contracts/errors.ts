export type DomainErrorCode = "not_found" | "invalid_input" | "version_conflict" | "capture_closed" | "ordering_gap" | "stale_claim" | "stale_snapshot" | "dependency_blocked";
export class DomainError extends Error {
  constructor(public readonly code: DomainErrorCode, message: string, public readonly details?: Readonly<Record<string, string | number | boolean>>, options?: ErrorOptions) {
    super(message, options);
    this.name = "DomainError";
  }
}
