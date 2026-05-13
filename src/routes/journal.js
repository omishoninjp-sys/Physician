import { Router } from 'express';
import Decimal from 'decimal.js';
import { withTenant } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { auditLog } from '../middleware/audit.js';
import { classifyTransaction, recordTrainingExample } from '../services/aiClassifier.js';

const router = Router();
router.use(authenticate);

/**
 * GET /api/journal-entries?client_id=...
 */
router.get('/', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id が必要' });

  try {
    const entries = await withTenant(req.user.tenant_id, async (db) => {
      const { rows } = await db.query(
        `SELECT
           je.id, je.entry_date, je.description, je.status, je.source,
           je.ai_confidence, je.ai_reasoning, je.created_at,
           json_agg(
             json_build_object(
               'id', jl.id,
               'direction', jl.direction,
               'amount', jl.amount,
               'tax_rate', jl.tax_rate,
               'account_code', coa.code,
               'account_name', coa.name,
               'line_order', jl.line_order
             ) ORDER BY jl.line_order
           ) AS lines
         FROM journal_entries je
         JOIN journal_lines jl ON jl.journal_entry_id = je.id
         JOIN chart_of_accounts coa ON coa.id = jl.account_id
         WHERE je.client_id = $1 AND je.deleted_at IS NULL
         GROUP BY je.id
         ORDER BY je.entry_date DESC, je.created_at DESC
         LIMIT 100`,
        [client_id]
      );
      return rows;
    });
    res.json({ entries });
  } catch (e) {
    console.error('List journal entries error:', e);
    res.status(500).json({ error: '仕訳一覧取得失敗' });
  }
});

/**
 * POST /api/journal-entries
 */
router.post('/', auditLog('CREATE', 'journal_entry'), async (req, res) => {
  const { client_id, entry_date, description, lines, source, ai_confidence, ai_reasoning } = req.body;

  if (!client_id || !entry_date || !description || !Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ error: '仕訳には最低 2 行（借方・貸方）必要' });
  }

  // 早期借貸平衡チェック
  const debitSum = lines
    .filter((l) => l.direction === 'debit')
    .reduce((sum, l) => sum.plus(new Decimal(l.amount)), new Decimal(0));
  const creditSum = lines
    .filter((l) => l.direction === 'credit')
    .reduce((sum, l) => sum.plus(new Decimal(l.amount)), new Decimal(0));

  if (!debitSum.equals(creditSum)) {
    return res.status(400).json({
      error: `借方・貸方が一致しません（借方 ${debitSum} / 貸方 ${creditSum}）`,
    });
  }

  try {
    const result = await withTenant(req.user.tenant_id, async (db) => {
      const { rows: entryRows } = await db.query(
        `INSERT INTO journal_entries
         (tenant_id, client_id, entry_date, description, source, ai_confidence, ai_reasoning, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          req.user.tenant_id,
          client_id,
          entry_date,
          description,
          source || 'manual',
          ai_confidence || null,
          ai_reasoning || null,
          req.user.id,
        ]
      );
      const entryId = entryRows[0].id;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        await db.query(
          `INSERT INTO journal_lines
           (tenant_id, journal_entry_id, line_order, account_id, direction, amount, tax_rate, memo)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            req.user.tenant_id,
            entryId,
            i + 1,
            line.account_id,
            line.direction,
            new Decimal(line.amount).toFixed(2),
            line.tax_rate || 0,
            line.memo || null,
          ]
        );
      }

      // 業種取得（RAG training 用）
      const { rows: clientRows } = await db.query(
        `SELECT industry FROM clients WHERE id = $1`,
        [client_id]
      );

      return {
        id: entryId,
        debit_line: lines.find((l) => l.direction === 'debit'),
        industry: clientRows[0]?.industry,
      };
    });

    req.audit.entityId = result.id;
    req.audit.changes = { description, amount: debitSum.toFixed(2) };

    // ─── RAG 学習データに非同期で保存 ───
    if (result.debit_line) {
      recordTrainingExample({
        tenant_id: req.user.tenant_id,
        client_id,
        description,
        amount: Number(result.debit_line.amount),
        industry: result.industry,
        account_id: result.debit_line.account_id,
        tax_rate: result.debit_line.tax_rate || 0,
        source_journal_id: result.id,
      }).catch((e) => console.error('RAG record failed:', e.message));
    }

    res.json({ entry: { id: result.id } });
  } catch (e) {
    console.error('Create journal entry error:', e);
    if (e.message && e.message.includes('一致しません')) {
      return res.status(400).json({ error: e.message });
    }
    res.status(500).json({ error: '仕訳作成失敗' });
  }
});

/**
 * POST /api/journal-entries/ai-suggest
 */
router.post('/ai-suggest', async (req, res) => {
  const { client_id, description, amount } = req.body;
  if (!client_id || !description || !amount) {
    return res.status(400).json({ error: '必須項目が不足' });
  }

  try {
    const suggestion = await withTenant(req.user.tenant_id, async (db) => {
      const { rows: accounts } = await db.query(
        `SELECT id, code, name, category, default_tax_rate
         FROM chart_of_accounts
         WHERE client_id = $1 AND is_active = TRUE`,
        [client_id]
      );
      const { rows: clientRows } = await db.query(
        `SELECT industry FROM clients WHERE id = $1`,
        [client_id]
      );
      const industry = clientRows[0]?.industry;

      return await classifyTransaction({
        description,
        amount: Number(amount),
        industry,
        accounts,
        tenant_id: req.user.tenant_id,
        client_id,
      });
    });

    res.json({ suggestion });
  } catch (e) {
    console.error('AI suggest error:', e);
    res.status(500).json({ error: 'AI 提案失敗' });
  }
});

export default router;
