import { readFile, readdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pool } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Migration runner with proper tracking
 * - schema_migrations 表で適用済みを管理
 * - 既存スキーマがあれば自動検出して tracker に seed
 */
async function runMigrations() {
  const migrationsDir = join(__dirname, '..', 'migrations');
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql') && !f.includes('template'))
    .sort();

  const client = await pool.connect();
  try {
    // ─── 1. tracker 表確保
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── 2. tracker が空かつ既存テーブルがある場合、自動 seed
    const { rows: trackerRows } = await client.query('SELECT version FROM schema_migrations');

    if (trackerRows.length === 0) {
      // Detect existing schema and back-fill tracker
      const detections = [
        { migration: '001_initial_schema.sql', detect_table: 'tenants' },
        { migration: '002_audit_bank_rag.sql', detect_table: 'audit_log' },
        { migration: '003_workflow_v2.sql', detect_table: 'document_categories' },
      ];

      for (const d of detections) {
        const { rows } = await client.query(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
          [d.detect_table]
        );
        if (rows.length > 0) {
          await client.query(
            'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
            [d.migration]
          );
          console.log(`⊙ Detected existing ${d.migration} (table ${d.detect_table} exists)`);
        }
      }
    }

    // ─── 3. 適用済み一覧再取得
    const { rows: appliedRows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(appliedRows.map((r) => r.version));

    // ─── 4. pending な migration を順次実行
    let executed = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`⊙ ${file} already applied, skipping`);
        continue;
      }
      console.log(`Running ${file}...`);
      const sql = await readFile(join(migrationsDir, file), 'utf-8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      console.log(`✓ ${file} done`);
      executed++;
    }

    if (executed === 0) {
      console.log('\n✅ Schema up to date (no migrations to run)');
    } else {
      console.log(`\n✅ ${executed} migration(s) applied`);
    }
  } catch (e) {
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
