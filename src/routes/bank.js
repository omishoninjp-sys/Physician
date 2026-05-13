import { Router } from 'express';
import Decimal from 'decimal.js';
import { withTenant } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { auditLog } from '../middleware/audit.js';
import { parseCSV } from '../services/csvParser.js';
import { classifyTransaction } from '../services/aiClassifier.js';

const router = Router();
router.use(authenticate);

/**
 * GET /api/bank/accounts?client_id=...
 */
router.get('/accounts', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id 必要' });

  try {
    const accounts = await withTenant(req.user.tenant_id, async (db) => {
      const { rows } = await db.query(
        `SELECT id, bank_name, account_type, account_number_masked, default_account_id
         FROM bank_accounts
         WHERE client_id = $1 AND deleted_at IS NULL
         ORDER BY created_at`,
        [client_id]
      );
      return rows;
    });
    res.json({ accounts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/bank/accounts
 * Body: { client_id, bank_name, account_type, account_number, default_account_id }
 */
router.post('/accounts', auditLog('CREATE', 'bank_account'), async (req, res) => {
  const { client_id, bank_name, account_type, account_number, default_account_id } = req.body;
  if (!client_id || !bank_name) {
    return res.status(400).json({ error: '銀行名は必須' });
  }
  try {
    const account = await withTenant(req.user.tenant_id, async (db) => {
      const masked = account_number ? `****${account_number.slice(-4)}` : null;
      const { rows } = await db.query(
        `INSERT INTO bank_accounts
         (tenant_id, client_id, bank_name, account_type, account_number_masked, default_account_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.user.tenant_id, client_id, bank_name, account_type, masked, default_account_id || null]
      );
      return rows[0];
    });
    req.audit.entityId = account.id;
    res.json({ account });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/bank/import-csv
 * Body: { client_id, bank_account_id, csv_text, format }
 */
router.post('/import-csv', auditLog('IMPORT', 'bank_csv'), async (req, res) => {
  const { client_id, bank_account_id, csv_text, format } = req.body;
  if (!client_id || !csv_text) {
    return res.status(400).json({ error: 'client_id と csv_text 必要' });
  }

  let parsed;
  try {
    parsed = parseCSV(csv_text, format || 'auto');
  } catch (e) {
    return res.status(400).json({ error: `CSV 解析失敗: ${e.message}` });
  }

  if (parsed.length === 0) {
    return res.status(400).json({ error: 'CSV から有効な取引が見つかりません' });
  }

  try {
    const result = await withTenant(req.user.tenant_id, async (db) => {
      let inserted = 0;
      let duplicates = 0;

      for (const row of parsed) {
        try {
          await db.query(
            `INSERT INTO bank_transactions
             (tenant_id, client_id, bank_account_id, transaction_date,
              description, amount, balance_after, hash_dedup, raw_csv_row)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              req.user.tenant_id,
              client_id,
              bank_account_id || null,
              row.transaction_date,
              row.description,
              row.amount,
              row.balance_after,
              row.hash_dedup,
              JSON.stringify(row.raw),
            ]
          );
          inserted++;
        } catch (e) {
          if (e.code === '23505') {
            duplicates++;
          } else {
            throw e;
          }
        }
      }

      return { inserted, duplicates, total_parsed: parsed.length };
    });

    req.audit.changes = result;
    res.json(result);
  } catch (e) {
    console.error('CSV import error:', e);
    res.status(500).json({ error: 'インポート失敗' });
  }
});

/**
 * GET /api/bank/transactions?client_id=...&status=unprocessed
 */
router.get('/transactions', async (req, res) => {
  const { client_id, status } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id 必要' });

  try {
    const txs = await withTenant(req.user.tenant_id, async (db) => {
      let sql = `SELECT bt.*, coa.code as ai_account_code, coa.name as ai_account_name
                 FROM bank_transactions bt
                 LEFT JOIN chart_of_accounts coa ON coa.id = bt.ai_suggested_account_id
                 WHERE bt.client_id = $1`;
      const params = [client_id];
      if (status) {
        sql += ' AND bt.status = $2';
        params.push(status);
      }
      sql += ' ORDER BY bt.transaction_date DESC, bt.created_at DESC LIMIT 200';
      const { rows } = await db.query(sql, params);
      return rows;
    });
    res.json({ transactions: txs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/bank/ai-classify-all
 * Body: { client_id }
 * 未処理の bank_transactions に対して AI 分類を一括実行
 */
router.post('/ai-classify-all', auditLog('AI_BATCH_CLASSIFY', 'bank_transactions'), async (req, res) => {
  const { client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id 必要' });

  try {
    const result = await withTenant(req.user.tenant_id, async (db) => {
      // 1. 未処理 transactions 取得（最多 50 筆/回）
      const { rows: txs } = await db.query(
        `SELECT id, description, amount FROM bank_transactions
         WHERE client_id = $1 AND status = 'unprocessed'
         ORDER BY transaction_date DESC LIMIT 50`,
        [client_id]
      );

      if (txs.length === 0) {
        return { processed: 0, message: '未処理取引なし' };
      }

      // 2. 該 client の勘定科目 + 業種取得
      const { rows: accounts } = await db.query(
        `SELECT id, code, name, category, default_tax_rate
         FROM chart_of_accounts WHERE client_id = $1 AND is_active = TRUE`,
        [client_id]
      );
      const { rows: clientRows } = await db.query(
        `SELECT industry FROM clients WHERE id = $1`,
        [client_id]
      );
      const industry = clientRows[0]?.industry;

      // 3. 各 tx に AI 分類
      let processed = 0;
      for (const tx of txs) {
        const suggestion = await classifyTransaction({
          description: tx.description,
          amount: Math.abs(Number(tx.amount)),
          industry,
          accounts,
          tenant_id: req.user.tenant_id,
          client_id,
        });
        await db.query(
          `UPDATE bank_transactions
           SET ai_suggested_account_id = $1, ai_confidence = $2,
               ai_reasoning = $3, status = 'ai_suggested'
           WHERE id = $4`,
          [suggestion.account_id, suggestion.confidence, suggestion.reasoning, tx.id]
        );
        processed++;
      }

      return { processed, total_pending: txs.length };
    });

    req.audit.changes = result;
    res.json(result);
  } catch (e) {
    console.error('AI batch classify error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/bank/transactions/:id/confirm
 * 提案された分類を確認 → 仕訳生成
 */
router.post('/transactions/:id/confirm', auditLog('CONFIRM', 'bank_transaction'), async (req, res) => {
  const { account_id, tax_rate } = req.body;

  try {
    const journal = await withTenant(req.user.tenant_id, async (db) => {
      // 1. 取得 tx
      const { rows: txs } = await db.query(
        `SELECT bt.*, ba.default_account_id
         FROM bank_transactions bt
         LEFT JOIN bank_accounts ba ON ba.id = bt.bank_account_id
         WHERE bt.id = $1`,
        [req.params.id]
      );
      const tx = txs[0];
      if (!tx) throw new Error('取引が見つかりません');
      if (tx.matched_journal_id) throw new Error('既に仕訳済み');

      const finalAccountId = account_id || tx.ai_suggested_account_id;
      if (!finalAccountId) throw new Error('勘定科目が指定されていません');

      // 2. 銀行側勘定科目（デフォルト：普通預金）取得
      let bankAccountId = tx.default_account_id;
      if (!bankAccountId) {
        const { rows } = await db.query(
          `SELECT id FROM chart_of_accounts WHERE client_id = $1 AND code = '1002'`,
          [tx.client_id]
        );
        bankAccountId = rows[0]?.id;
      }
      if (!bankAccountId) throw new Error('銀行側勘定科目（普通預金）が見つかりません');

      const amount = Math.abs(Number(tx.amount));
      const isWithdrawal = Number(tx.amount) < 0;

      // 3. 仕訳作成
      const { rows: entryRows } = await db.query(
        `INSERT INTO journal_entries
         (tenant_id, client_id, entry_date, description, source,
          ai_confidence, ai_reasoning, created_by)
         VALUES ($1, $2, $3, $4, 'ai_suggested', $5, $6, $7) RETURNING id`,
        [
          req.user.tenant_id,
          tx.client_id,
          tx.transaction_date,
          tx.description,
          tx.ai_confidence,
          tx.ai_reasoning,
          req.user.id,
        ]
      );
      const entryId = entryRows[0].id;

      // 借方・貸方
      const debitAccount = isWithdrawal ? finalAccountId : bankAccountId;
      const creditAccount = isWithdrawal ? bankAccountId : finalAccountId;

      await db.query(
        `INSERT INTO journal_lines
         (tenant_id, journal_entry_id, line_order, account_id, direction, amount, tax_rate)
         VALUES ($1, $2, 1, $3, 'debit', $4, $5)`,
        [req.user.tenant_id, entryId, debitAccount, amount, tax_rate || 0]
      );
      await db.query(
        `INSERT INTO journal_lines
         (tenant_id, journal_entry_id, line_order, account_id, direction, amount, tax_rate)
         VALUES ($1, $2, 2, $3, 'credit', $4, 0)`,
        [req.user.tenant_id, entryId, creditAccount, amount]
      );

      // 4. tx を matched に更新
      await db.query(
        `UPDATE bank_transactions SET status = 'matched', matched_journal_id = $1 WHERE id = $2`,
        [entryId, req.params.id]
      );

      return { journal_entry_id: entryId };
    });

    req.audit.entityId = journal.journal_entry_id;
    res.json(journal);
  } catch (e) {
    console.error('Confirm transaction error:', e);
    res.status(400).json({ error: e.message });
  }
});

export default router;
