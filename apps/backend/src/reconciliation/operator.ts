import { uuidSchema } from "../contracts";
import { createPool } from "../db/pool";
import { ReconciliationRepository } from "./repository";

async function main(): Promise<void> {
  const [action, rawId, flag, ...words] = process.argv.slice(2);
  if ((action !== "retry" && action !== "skip") || !rawId || flag !== "--reason" || words.length === 0) throw new Error("Usage: bun apps/backend/src/reconciliation/operator.ts <retry|skip> <job-id> --reason <reason>");
  const jobId = uuidSchema.parse(rawId);
  const reason = words.join(" ");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = createPool(new URL(databaseUrl).toString());
  try {
    const repository = new ReconciliationRepository(pool);
    if (action === "retry") await repository.retryBlocked(jobId, reason);
    else await repository.skipBlocked(jobId, reason);
    process.stdout.write(`${action} ${jobId}\n`);
  } finally { await pool.end(); }
}

if (import.meta.main) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Operator command failed"}\n`); process.exitCode = 1; });
}
