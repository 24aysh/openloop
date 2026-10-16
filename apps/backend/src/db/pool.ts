import pg from "pg";

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5000, application_name: "openloop" });
}
export async function checkDatabase(pool: pg.Pool): Promise<void> { await pool.query("SELECT 1"); }
