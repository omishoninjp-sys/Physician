import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * 取得一個設定好 tenant context 的連線
 * 所有業務 query 都必須透過這個函數取得連線、確保 RLS 生效
 *
 * 使用範例：
 *   await withTenant(tenantId, async (client) => {
 *     const { rows } = await client.query('SELECT * FROM clients');
 *     return rows;
 *   });
 */
export async function withTenant(tenantId, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 設定 tenant context（RLS 會自動 enforce）
    await client.query(`SET LOCAL app.current_tenant = '${tenantId}'`);
    // 切換到 app_user role（RLS policy 是 grant 給 app_user 的）
    await client.query('SET LOCAL ROLE app_user');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 不設 tenant context 的連線（僅供 auth、初始註冊等少數場景使用）
 */
export async function withoutTenant(callback) {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}
