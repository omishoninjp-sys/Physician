import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { withoutTenant } from '../db.js';
import { signToken } from '../middleware/auth.js';

const router = Router();

/**
 * POST /api/auth/register
 * 註冊新事務所 + 第一個 manager 用戶
 */
router.post('/register', async (req, res) => {
  const { tenant_name, email, password, display_name } = req.body;

  if (!tenant_name || !email || !password || !display_name) {
    return res.status(400).json({ error: '必須項目が不足しています' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'パスワードは 8 文字以上必要です' });
  }

  try {
    const result = await withoutTenant(async (client) => {
      // 事務所 + 用戶在同 transaction 內建立
      await client.query('BEGIN');

      const { rows: tenantRows } = await client.query(
        'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name',
        [tenant_name]
      );
      const tenant = tenantRows[0];

      const passwordHash = await bcrypt.hash(password, 10);
      const { rows: userRows } = await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, display_name, role)
         VALUES ($1, $2, $3, $4, 'manager')
         RETURNING id, tenant_id, email, display_name, role`,
        [tenant.id, email, passwordHash, display_name]
      );

      await client.query('COMMIT');
      return userRows[0];
    });

    const token = signToken(result);
    res.json({ user: result, token });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(400).json({ error: 'このメールアドレスは既に使用されています' });
    }
    console.error('Register error:', e);
    res.status(500).json({ error: '登錄失敗' });
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'メールとパスワードが必要です' });
  }

  try {
    const user = await withoutTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT u.*, t.name as tenant_name
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
         WHERE u.email = $1`,
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

    const token = signToken(user);
    res.json({
      user: {
        id: user.id,
        tenant_id: user.tenant_id,
        tenant_name: user.tenant_name,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
      },
      token,
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'ログイン失敗' });
  }
});

export default router;
