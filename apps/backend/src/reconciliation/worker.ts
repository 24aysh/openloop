import type { MindWriterContract } from "../contracts";
import { DomainError } from "../contracts";
import { ReconciliationRepository } from "./repository";
import { ExtractionError, type ClaimedExtraction, type JobFailure, type TextExtractor } from "./types";
import { validateProposals } from "./validate";
import { logReconciliation } from "./log";

export class ReconciliationWorker {
  constructor(private readonly repository: ReconciliationRepository, private readonly extractor: TextExtractor, private readonly writer: MindWriterContract) {}

  private async fail(input: ClaimedExtraction, failure: JobFailure,
    started: number): Promise<"deferred" | "blocked"> {
    const result=await this.repository.recordFailure(input.claim,failure);
    if(result.kind==="stale")return "deferred";
    logReconciliation("attempt_failed",input.claim.jobId,{sessionId:input.claim.sessionId,fromOrdinal:input.claim.fromOrdinal,
      throughOrdinal:input.claim.throughOrdinal,attempt:input.attempt,code:failure.code,storedCode:result.code,
      state:result.state,nextAttemptAt:result.nextAttemptAt,durationMs:Math.round(performance.now()-started)});
    return result.state==="blocked"?"blocked":"deferred";
  }

  async tick(signal: AbortSignal = new AbortController().signal): Promise<"idle" | "applied" | "deferred" | "blocked"> {
    if (signal.aborted) return "deferred";
    const input = await this.repository.claimNext();
    if (!input) return "idle";
    const started = performance.now();
    logReconciliation("claimed", input.claim.jobId, { sessionId:input.claim.sessionId,fromOrdinal:input.claim.fromOrdinal,
      throughOrdinal:input.claim.throughOrdinal,attempt: input.attempt });
    if (signal.aborted) return "deferred";
    const transcriptBytes = Buffer.byteLength(JSON.stringify([...input.earlierParts, ...input.newParts]), "utf8");
    const mindBytes = Buffer.byteLength(JSON.stringify(input.mind), "utf8");
    if (transcriptBytes > 65_536 || mindBytes > 131_072) {
      return this.fail(input,{code:"context_limit",policy:"block"},started);
    }
    try {
      const outcome = await this.extractor.extract(input, signal);
      if (signal.aborted) return "deferred";
      if (outcome.kind !== "success") {
        const failure: JobFailure = outcome.kind === "refusal" ? { code: "model_refusal", policy: "block" }
          : outcome.kind === "incomplete" ? { code: "incomplete_output", policy: "invalid" }
            : { code: outcome.code, policy: "invalid" };
        return this.fail(input,failure,started);
      }
      const changes = validateProposals(input, outcome.proposals);
      try {
        await this.writer.applyExtraction(input.claim, changes);
        logReconciliation("applied", input.claim.jobId, { sessionId:input.claim.sessionId,fromOrdinal:input.claim.fromOrdinal,
          throughOrdinal:input.claim.throughOrdinal,attempt: input.attempt,proposalCount:outcome.proposals.length,
          changeCount:changes.changes.length,durationMs: Math.round(performance.now() - started) });
        return "applied";
      } catch (error) {
        if (error instanceof DomainError) throw error;
        if (await this.repository.jobState(input.claim.jobId) === "succeeded") return "applied";
        throw error;
      }
    } catch (error) {
      if (signal.aborted) return "deferred";
      let failure: JobFailure;
      if (error instanceof ExtractionError) failure = error.failure;
      else if (error instanceof DomainError && error.code === "stale_claim") return "deferred";
      else if (error instanceof DomainError && ["stale_snapshot", "dependency_blocked"].includes(error.code)) failure = { code: "stale_snapshot", policy: "conflict" };
      else if (error instanceof DomainError && error.code === "invalid_input") failure = { code: "invalid_apply", policy: "invalid" };
      else throw error;
      return this.fail(input,failure,started);
    }
  }
}

export function startReconciliationLoop(worker: ReconciliationWorker, onError: (error: unknown) => void): { stop: () => Promise<void> } {
  const controller = new AbortController();
  let stopped = false;
  let running: Promise<void> | null = null;
  let failure: unknown = null;
  const run = () => {
    if (stopped || running !== null) return;
    running = worker.tick(controller.signal).then(() => {}).catch(error => {
      stopped = true;
      clearInterval(timer);
      failure = error;
      try { onError(error); } catch (callbackError) { failure = callbackError; }
    }).finally(() => { running = null; });
  };
  const timer = setInterval(run, 1000);
  run();
  return { stop: async () => { stopped = true; clearInterval(timer); controller.abort(); await running; if (failure) throw failure; } };
}
