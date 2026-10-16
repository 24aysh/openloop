import type pg from "pg";

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";
export async function withTransaction<T>(pool: pg.Pool, options: { isolation: IsolationLevel }, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    // Fixed, closed choice: never interpolate caller-provided SQL.
    const isolation = options.isolation === "read committed" ? "READ COMMITTED" : options.isolation === "repeatable read" ? "REPEATABLE READ" : "SERIALIZABLE";
    await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
    const result = await work(client);
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (error) {
    if (!committed) { try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ } }
    throw error;
  } finally { client.release(); }
}
