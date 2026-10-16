import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type pg from "pg";
import { createPool } from "../src/db/pool";

const directory = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(672745117)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const files = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = await readFile(join(directory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const result = await client.query<{checksum:string}>("SELECT checksum FROM schema_migrations WHERE version=$1", [file]);
      if (result.rows[0]) {
        if (result.rows[0].checksum !== checksum) throw new Error(`Migration checksum mismatch: ${file}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    }
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(672745117)"); } finally { client.release(); }
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = createPool(url);
  try { await migrate(pool); } finally { await pool.end(); }
}
