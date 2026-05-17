import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

/**
 * 客户端 JWT 認證
 * 税理士 JWT とは別 type で発行、相互利用不可
 */
export function portalAuthenticate(req, res, next) {
  const token =
    req.headers.authorization?.replace(/^Bearer\s+/, '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'ログインが必要です' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'portal') {
      return res.status(401).json({ error: 'Invalid token type' });
    }
    req.clientUser = {
      id: payload.client_user_id,
      client_id: payload.client_id,
      tenant_id: payload.tenant_id,
      email: payload.email,
      role: payload.role,
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'トークンが無効です' });
  }
}

export function signPortalToken(user) {
  return jwt.sign(
    {
      type: 'portal',
      client_user_id: user.id,
      client_id: user.client_id,
      tenant_id: user.tenant_id,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}
