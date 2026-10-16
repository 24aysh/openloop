import type { CommitmentScheduler } from "./scheduler";
import type { CommitmentLogEmitter } from "./log-emitter";

export function startSchedulingLoop(scheduler: Pick<CommitmentScheduler, "tick">, emitter: Pick<CommitmentLogEmitter, "flush">,
  onError: (error: unknown) => void): { stop: () => Promise<void> } {
  let stopped = false;
  let running: Promise<void> | null = null;
  let failure: unknown = null;
  const run = () => {
    if (stopped || running !== null) return;
    running = (async () => { await scheduler.tick(); await emitter.flush(); })()
      .catch(error => {
        stopped = true;
        clearInterval(timer);
        failure = error;
        try { onError(error); } catch (callbackError) { failure = callbackError; }
      }).finally(() => { running = null; });
  };
  const timer = setInterval(run, 1000);
  run();
  return { stop: async () => { stopped = true; clearInterval(timer); await running; if (failure) throw failure; } };
}
