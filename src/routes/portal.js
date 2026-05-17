import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { withoutTenant, withTenant } from '../db.js';
import { portalAuthenticate, signPortalToken } from '../middleware/portalAuth.js';

const router = Router();

// ============================================================================
// 認証（無認証）
// ============================================================================

/**
 * POST /api/portal/auth/login
 */
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'メールとパスワード必要' });
  }

  try {
    const user = await withoutTenant(async (db) => {
      const { rows } = await db.query(
        `SELECT cu.*, c.company_name, t.name as tenant_name
         FROM client_users cu
         JOIN clients c ON c.id = cu.client_id
         JOIN tenants t ON t.id = cu.tenant_id
         WHERE cu.email = $1 AND cu.deleted_at IS NULL AND cu.is_active = TRUE`,
        [email]
      );
      return rows[0];
    });

    if (!user) {
      return res.status(401).json({ error: 'メールまたはパスワードが正しくありません' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'メールまたはパスワードが正しくありません' });
    }

    await withoutTenant(async (db) => {
      await db.query(`UPDATE client_users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
    });

    const token = signPortalToken(user);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        client_id: user.client_id,
        client_name: user.company_name,
        tenant_name: user.tenant_name,
      },
      token,
    });
  } catch (e) {
    console.error('Portal login error:', e);
    res.status(500).json({ error: 'ログイン失敗' });
  }
});

// ============================================================================
// 認証 (要 portal token)
// ============================================================================

router.use(portalAuthenticate);

router.get('/me', async (req, res) => {
  try {
    const info = await withTenant(req.clientUser.tenant_id, async (db) => {
      const { rows } = await db.query(
        `SELECT cu.id, cu.email, cu.display_name, cu.role,
                c.company_name, c.industry, c.id as client_id,
                t.name as tenant_name
         FROM client_users cu
         JOIN clients c ON c.id = cu.client_id
         JOIN tenants t ON t.id = cu.tenant_id
         WHERE cu.id = $1`,
        [req.clientUser.id]
      );
      return rows[0];
    });
    res.json({ user: info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/portal/requests
 * 客户が見る書類リクエスト一覧
 */
router.get('/requests', async (req, res) => {
  try {
    const data = await withTenant(req.clientUser.tenant_id, async (db) => {
      const { rows } = await db.query(
        `SELECT
           dr.id, dr.template_id, dr.status, dr.notes,
           dr.revision_note, dr.reviewed_at,
           dr.requested_at, dr.updated_at,
           t.code as template_code, t.name as template_name,
           t.parent_id, t.frequency_type, t.optional, t.applicability_hint,
           parent_t.name as parent_name,
           c.code as category_code, c.name as category_name, c.sort_order as cat_sort,
           p.fiscal_year as period_year,
           (SELECT json_agg(json_build_object(
             'id', ds.id,
             'file_name', ds.file_name,
             'file_size', ds.file_size,
             'mime_type', ds.mime_type,
             'uploaded_at', ds.uploaded_at
           ) ORDER BY ds.uploaded_at DESC)
            FROM document_submissions ds
            WHERE ds.request_id = dr.id AND ds.superseded_by IS NULL) as submissions
         FROM document_requests dr
         JOIN document_templates t ON t.id = dr.template_id
         LEFT JOIN document_templates parent_t ON parent_t.id = t.parent_id
         LEFT JOIN document_categories c ON c.id = t.category_id
         LEFT JOIN periods p ON p.id = dr.period_id
         WHERE dr.client_id = $1
         ORDER BY p.fiscal_year DESC NULLS LAST, c.sort_order, t.sort_order`,
        [req.clientUser.client_id]
      );
      return rows;
    });
    res.json({ requests: data });
  } catch (e) {
    console.error('Portal requests error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/portal/requests/:id/submissions
 * Body: { file_name, mime_type, file_content_base64 }
 */
router.post('/requests/:id/submissions', async (req, res) => {
  const { file_name, mime_type, file_content_base64 } = req.body;
  if (!file_name || !file_content_base64) {
    return res.status(400).json({ error: 'file_name と file_content_base64 必要' });
  }

  const fileSize = Math.floor((file_content_base64.length * 3) / 4);
  if (fileSize > 10 * 1024 * 1024) {
    return res.status(400).json({ error: 'ファイルサイズは 10MB 以下にしてください' });
  }

  const buffer = Buffer.from(file_content_base64, 'base64');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  // demo 用：data URL に格納（本番では R2 へ移行）
  const dataUrl = `data:${mime_type || 'application/octet-stream'};base64,${file_content_base64}`;

  try {
    const result = await withTenant(req.clientUser.tenant_id, async (db) => {
      // 状態チェック：lock 済みは拒否
      const { rows: reqCheck } = await db.query(
        `SELECT id, status FROM document_requests WHERE id = $1 AND client_id = $2`,
        [req.params.id, req.clientUser.client_id]
      );
      if (reqCheck.length === 0) throw new Error('該当 request 無し');
      if (reqCheck[0].status === 'reviewed' || reqCheck[0].status === 'confirmed') {
        throw new Error('税理士の確認が完了しているため、新規アップロードはできません');
      }

      // 新 submission を作成
      const { rows } = await db.query(
        `INSERT INTO document_submissions
         (tenant_id, request_id, file_url, file_name, file_size, mime_type, file_hash,
          uploaded_by_client_user_id, uploaded_via)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'web')
         RETURNING id, file_name, file_size, uploaded_at`,
        [
          req.clientUser.tenant_id,
          req.params.id,
          dataUrl,
          file_name,
          fileSize,
          mime_type,
          hash,
          req.clientUser.id,
        ]
      );
      const newSubmissionId = rows[0].id;

      // 既存 submissions を supersede（差し替え扱い）
      await db.query(
        `UPDATE document_submissions
         SET superseded_by = $1
         WHERE request_id = $2 AND id != $1 AND superseded_by IS NULL`,
        [newSubmissionId, req.params.id]
      );

      // 状態を submitted に（needs_revision からも復帰）
      await db.query(
        `UPDATE document_requests SET status = 'submitted', updated_at = NOW()
         WHERE id = $1`,
        [req.params.id]
      );

      return rows[0];
    });

    res.json({ submission: result });
  } catch (e) {
    console.error('Upload error:', e);
    res.status(400).json({ error: e.message });
  }
});

/**
 * PATCH /api/portal/requests/:id/not-applicable
 * 客户が「該当なし」を宣言
 */
router.patch('/requests/:id/not-applicable', async (req, res) => {
  try {
    const result = await withTenant(req.clientUser.tenant_id, async (db) => {
      const { rows } = await db.query(
        `UPDATE document_requests
         SET status = 'not_applicable', updated_at = NOW()
         WHERE id = $1 AND client_id = $2
         RETURNING id, status`,
        [req.params.id, req.clientUser.client_id]
      );
      return rows[0];
    });
    if (!result) return res.status(404).json({ error: '該当無し' });
    res.json({ request: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/portal/submissions/:id/download
 */
router.get('/submissions/:id/download', async (req, res) => {
  try {
    const result = await withTenant(req.clientUser.tenant_id, async (db) => {
      const { rows } = await db.query(
        `SELECT ds.file_url, ds.file_name, ds.mime_type
         FROM document_submissions ds
         JOIN document_requests dr ON dr.id = ds.request_id
         WHERE ds.id = $1 AND dr.client_id = $2`,
        [req.params.id, req.clientUser.client_id]
      );
      return rows[0];
    });
    if (!result) return res.status(404).send('Not found');

    const match = result.file_url.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return res.status(500).send('Invalid file format');

    const buffer = Buffer.from(match[2], 'base64');
    res.setHeader('Content-Type', match[1]);
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(result.file_name)}`
    );
    res.send(buffer);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

export default router;
