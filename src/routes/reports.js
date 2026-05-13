import { Router } from 'express';
import { withTenant } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

/**
 * GET /api/reports/trial-balance?client_id=...&from=YYYY-MM-DD&to=YYYY-MM-DD
 * 試算表
 */
router.get('/trial-balance', async (req, res) => {
  const { client_id, from, to } = req.query;

  if (!client_id) {
    return res.status(400).json({ error: 'client_id が必要です' });
  }

  try {
    const balance = await withTenant(req.user.tenant_id, async (db) => {
      const { rows } = await db.query(
        `SELECT
           coa.code,
           coa.name,
           coa.category,
           coa.sort_order,
           COALESCE(SUM(CASE WHEN jl.direction = 'debit' THEN jl.amount ELSE 0 END), 0) AS debit_total,
           COALESCE(SUM(CASE WHEN jl.direction = 'credit' THEN jl.amount ELSE 0 END), 0) AS credit_total,
           COUNT(jl.id) AS line_count
         FROM chart_of_accounts coa
         LEFT JOIN journal_lines jl ON jl.account_id = coa.id
         LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
           AND je.deleted_at IS NULL
           AND ($2::date IS NULL OR je.entry_date >= $2::date)
           AND ($3::date IS NULL OR je.entry_date <= $3::date)
         WHERE coa.client_id = $1
         GROUP BY coa.id
         ORDER BY coa.sort_order, coa.code`,
        [client_id, from || null, to || null]
      );

      // 計算 P&L 累計（収益 - 費用）
      let totalRevenue = 0;
      let totalExpense = 0;
      for (const row of rows) {
        if (row.category === 'revenue') {
          totalRevenue += Number(row.credit_total) - Number(row.debit_total);
        }
        if (row.category === 'expense') {
          totalExpense += Number(row.debit_total) - Number(row.credit_total);
        }
      }

      return {
        accounts: rows,
        summary: {
          total_revenue: totalRevenue,
          total_expense: totalExpense,
          net_income: totalRevenue - totalExpense,
        },
      };
    });

    res.json(balance);
  } catch (e) {
    console.error('Trial balance error:', e);
    res.status(500).json({ error: '試算表取得失敗' });
  }
});

export default router;
