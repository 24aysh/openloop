import pg from "pg";
import { migrate } from "../../scripts/migrate";
import { createPool } from "../../src/db/pool";

const tables=["commitment_logs","change_sources","mind_changes","commitments","memories","reconciliation_jobs","transcript_parts","transcript_items","voice_sessions","mind_state","users"];

export function createTestPool():pg.Pool {
  const url=process.env.TEST_DATABASE_URL;
  if(!url) throw new Error("TEST_DATABASE_URL is required");
  const test=new URL(url);const production=process.env.DATABASE_URL;
  if(!/(^|[_-])test($|[_-])/.test(test.pathname.slice(1).toLowerCase()) || (production && new URL(production).href===test.href)) throw new Error("Refusing non-test database URL");
  return createPool(url,5);
}
export async function prepareTestDatabase(pool:pg.Pool):Promise<void> { await migrate(pool); }
export async function clearTestDatabase(pool:pg.Pool):Promise<void> { await pool.query(`TRUNCATE ${tables.join(",")} RESTART IDENTITY`); }
