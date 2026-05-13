import { readFile, readdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pool } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runMigrations() {
  const migrationsDir = join(__dirname, '..', 'migrations');
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql') && !f.includes('template'))
    .sort();

  const client = await pool.connect();
  try {
    for (const file of files) {
      console.log(`Running ${file}...`);
      const sql = await readFile(join(migrationsDir, file), 'utf-8');
      await client.query(sql);
      console.log(`✓ ${file} done`);
    }
    console.log('\n✅ All migrations completed');
  } catch (e) {
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
