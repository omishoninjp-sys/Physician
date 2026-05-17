import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

/**
 * 驗證 JWT、注入 user + tenant 資訊到 req
 */
export function authenticate(req, res, next) {
  const token =
    req.headers.authorization?.replace(/^Bearer\s+/, '') || req.query.token;
  if (!token) {
    return res.status(401).json({ error: '認證が必要です' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.user_id,
      tenant_id: payload.tenant_id,
      email: payload.email,
      role: payload.role,
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'トークンが無効です' });
  }
}

export function signToken(user) {
  return jwt.sign(
    {
      user_id: user.id,
      tenant_id: user.tenant_id,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}
