import { Router } from 'express';
import { withTenant } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { auditLog } from '../middleware/audit.js';

const router = Router();
router.use(authenticate);

// ============================================================================
// 範本（global templates）
// ============================================================================

/**
 * GET /api/documents/templates
 * 全 global 範本＋分類（hierarchy 含 parent-child）
 */
router.get('/templates', async (req, res) => {
  try {
    const data = await withTenant(req.user.tenant_id, async (db) => {
      const { rows: categories } = await db.query(
        `SELECT id, code, name, sort_order
         FROM document_categories
         WHERE tenant_id IS NULL
         ORDER BY sort_order, name`
      );

      const { rows: templates } = await db.query(
        `SELECT id, category_id, parent_id, code, name, frequency_type,
                applicability_hint, optional, sort_order
         FROM document_templates
         WHERE tenant_id IS NULL AND is_active = TRUE
         ORDER BY sort_order, name`
      );

      // 組裝 hierarchy
      const byParent = {};
      for (const t of templates) {
        const key = t.parent_id || 'root';
        if (!byParent[key]) byParent[key] = [];
        byParent[key].push({ ...t, children: [] });
      }

      // Build tree under each category
      const tree = categories.map((c) => {
        const tops = (byParent['root'] || []).filter((t) => t.category_id === c.id);
        const withChildren = tops.map((t) => ({
          ...t,
          children: byParent[t.id] || [],
        }));
        return { ...c, templates: withChildren };
      });

      return tree;
    });

    res.json({ categories: data });
  } catch (e) {
    console.error('List templates error:', e);
    res.status(500).json({ error: '範本取得失敗' });
  }
});

// ============================================================================
// 会計年度 (periods)
// ============================================================================

/**
 * GET /api/documents/periods?client_id=...
 */
router.get('/periods', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id 必要' });

  try {
    const periods = await withTenant(req.user.tenant_id, async (db) => {
      const { rows } = await db.query(
        `SELECT id, fiscal_year, start_date, end_date, status, created_at
         FROM periods
         WHERE client_id = $1
         ORDER BY fiscal_year DESC`,
        [client_id]
      );
      return rows;
    });
    res.json({ periods });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/documents/periods
 * Body: { client_id, fiscal_year, start_date?, end_date? }
 */
router.post('/periods', auditLog('CREATE', 'period'), async (req, res) => {
  const { client_id, fiscal_year, start_date, end_date } = req.body;
  if (!client_id || !fiscal_year) {
    return res.status(400).json({ error: 'client_id と fiscal_year 必要' });
  }

  try {
    const period = await withTenant(req.user.tenant_id, async (db) => {
      // 計算預設日期（4 月開始、3 月終了 ── 日本標準）
      const defaultStart = start_date || `${fiscal_year}-04-01`;
      const defaultEnd = end_date || `${fiscal_year + 1}-03-31`;

      const { rows } = await db.query(
        `INSERT INTO periods (tenant_id, client_id, fiscal_year, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.user.tenant_id, client_id, fiscal_year, defaultStart, defaultEnd]
      );
      return rows[0];
    });

    req.audit.entityId = period.id;
    res.json({ period });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(400).json({ error: 'この年度は既に作成されています' });
    }
    console.error('Create period error:', e);
    res.status(500).json({ error: '年度作成失敗' });
  }
});

// ============================================================================
// 書類リクエスト
// ============================================================================

/**
 * GET /api/documents/requests?client_id=&period_id=
 * 特定の client/period の請求一覧＋提出狀況
 */
router.get('/requests', async (req, res) => {
  const { client_id, period_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id 必要' });

  try {
    const result = await withTenant(req.user.tenant_id, async (db) => {
      let sql = `
        SELECT
          dr.id, dr.template_id, dr.status, dr.required, dr.notes,
          dr.requested_at, dr.updated_at,
          t.code AS template_code, t.name AS template_name,
          t.parent_id, t.frequency_type, t.optional, t.applicability_hint,
          parent_t.name AS parent_name,
          c.code AS category_code, c.name AS category_name,
          (SELECT COUNT(*) FROM document_submissions ds
           WHERE ds.request_id = dr.id AND ds.superseded_by IS NULL) AS submission_count
        FROM document_requests dr
        JOIN document_templates t ON t.id = dr.template_id
        LEFT JOIN document_templates parent_t ON parent_t.id = t.parent_id
        LEFT JOIN document_categories c ON c.id = t.category_id
        WHERE dr.client_id = $1`;
      const params = [client_id];

      if (period_id) {
        sql += ` AND (dr.period_id = $2 OR dr.period_id IS NULL)`;
        params.push(period_id);
      }

      sql += ` ORDER BY c.sort_order, COALESCE(parent_t.sort_order, t.sort_order), t.sort_order`;

      const { rows } = await db.query(sql, params);
      return rows;
    });

    res.json({ requests: result });
  } catch (e) {
    console.error('List requests error:', e);
    res.status(500).json({ error: '請求一覧取得失敗' });
  }
});

/**
 * POST /api/documents/requests/batch
 * 稅理士が複数 templates を一括選択
 * Body: { client_id, period_id?, template_ids: [...] }
 */
router.post('/requests/batch', auditLog('BATCH_REQUEST', 'document_requests'), async (req, res) => {
  const { client_id, period_id, template_ids } = req.body;
  if (!client_id || !Array.isArray(template_ids) || template_ids.length === 0) {
    return res.status(400).json({ error: 'client_id と template_ids 必要' });
  }

  try {
    const result = await withTenant(req.user.tenant_id, async (db) => {
      let added = 0;
      for (const tid of template_ids) {
        // 重複チェック：同じ client × period × template の組み合わせは一回限り
        const { rows: existing } = await db.query(
          `SELECT id FROM document_requests
           WHERE client_id = $1 AND template_id = $2
             AND ($3::uuid IS NULL OR period_id = $3 OR period_id IS NULL)`,
          [client_id, tid, period_id || null]
        );
        if (existing.length > 0) continue;

        await db.query(
          `INSERT INTO document_requests
           (tenant_id, client_id, period_id, template_id, requested_by_user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.user.tenant_id, client_id, period_id || null, tid, req.user.id]
        );
        added++;
      }
      return { added, total_requested: template_ids.length };
    });

    req.audit.changes = result;
    res.json(result);
  } catch (e) {
    console.error('Batch request error:', e);
    res.status(500).json({ error: '一括選択失敗' });
  }
});

/**
 * DELETE /api/documents/requests/:id
 * 稅理士が請求項目を取消
 */
router.delete('/requests/:id', auditLog('DELETE', 'document_request'), async (req, res) => {
  try {
    await withTenant(req.user.tenant_id, async (db) => {
      const { rows } = await db.query(
        `DELETE FROM document_requests WHERE id = $1 RETURNING template_id`,
        [req.params.id]
      );
      if (rows.length === 0) throw new Error('該当無し');
    });
    req.audit.entityId = req.params.id;
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * PATCH /api/documents/requests/:id/status
 * Body: { status }
 */
router.patch('/requests/:id/status', auditLog('UPDATE_STATUS', 'document_request'), async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['requested', 'submitted', 'reviewed', 'needs_revision', 'not_applicable', 'confirmed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: '無効な status' });
  }

  try {
    const result = await withTenant(req.user.tenant_id, async (db) => {
      const { rows } = await db.query(
        `UPDATE document_requests
         SET status = $1, updated_at = NOW()
         WHERE id = $2 RETURNING id, status`,
        [status, req.params.id]
      );
      return rows[0];
    });
    if (!result) return res.status(404).json({ error: '該当無し' });
    req.audit.entityId = result.id;
    req.audit.changes = { new_status: status };
    res.json({ request: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
