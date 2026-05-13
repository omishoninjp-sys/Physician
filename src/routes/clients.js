import { Router } from 'express';
import { withTenant } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { DEFAULT_ACCOUNTS } from '../services/accountSeed.js';

const router = Router();
router.use(authenticate);

/**
 * GET /api/clients
 * 取得本事務所所有顧客
 */
router.get('/', async (req, res) => {
  try {
    const clients = await withTenant(req.user.tenant_id, async (db) => {
      const { rows } = await db.query(
        `SELECT id, company_name, industry, fiscal_year_start_month, created_at
         FROM clients
         WHERE deleted_at IS NULL
         ORDER BY created_at DESC`
      );
      return rows;
    });
    res.json({ clients });
  } catch (e) {
    console.error('List clients error:', e);
    res.status(500).json({ error: '顧客一覧取得失敗' });
  }
});

/**
 * POST /api/clients
 * 建立新顧客 + 自動 seed 標準勘定科目
 */
router.post('/', async (req, res) => {
  const { company_name, industry, fiscal_year_start_month } = req.body;

  if (!company_name) {
    return res.status(400).json({ error: '会社名は必須です' });
  }

  try {
    const newClient = await withTenant(req.user.tenant_id, async (db) => {
      // 1. 建立 client
      const { rows } = await db.query(
        `INSERT INTO clients (tenant_id, company_name, industry, fiscal_year_start_month)
         VALUES ($1, $2, $3, $4)
         RETURNING id, company_name, industry, fiscal_year_start_month`,
        [req.user.tenant_id, company_name, industry || null, fiscal_year_start_month || 4]
      );
      const client = rows[0];

      // 2. 自動插入標準勘定科目表
      for (const a of DEFAULT_ACCOUNTS) {
        await db.query(
          `INSERT INTO chart_of_accounts
           (tenant_id, client_id, code, name, category, default_tax_rate, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [req.user.tenant_id, client.id, a.code, a.name, a.category, a.tax, a.sort]
        );
      }

      return client;
    });

    res.json({ client: newClient });
  } catch (e) {
    console.error('Create client error:', e);
    res.status(500).json({ error: '顧客作成失敗' });
  }
});

/**
 * GET /api/clients/:id/accounts
 * 取得指定顧客的勘定科目表
 */
router.get('/:id/accounts', async (req, res) => {
  try {
    const accounts = await withTenant(req.user.tenant_id, async (db) => {
      const { rows } = await db.query(
        `SELECT id, code, name, category, default_tax_rate, sort_order
         FROM chart_of_accounts
         WHERE client_id = $1 AND is_active = TRUE
         ORDER BY sort_order, code`,
        [req.params.id]
      );
      return rows;
    });
    res.json({ accounts });
  } catch (e) {
    console.error('List accounts error:', e);
    res.status(500).json({ error: '勘定科目取得失敗' });
  }
});

export default router;
