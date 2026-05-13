import { withoutTenant } from '../db.js';

/**
 * Audit log middleware
 * 在 response 結束後、非同步寫入 audit log（不阻塞 user-facing latency）
 */
export function auditLog(action, entityType) {
  return (req, res, next) => {
    // 把 audit 資訊掛在 req 上、route handler 可以更新
    req.audit = { action, entityType, entityId: null, changes: null };

    res.on('finish', () => {
      // 只記錄成功的操作（2xx）
      if (res.statusCode >= 200 && res.statusCode < 300) {
        writeAuditLog({
          tenant_id: req.user?.tenant_id || null,
          user_id: req.user?.id || null,
          action: req.audit.action,
          entity_type: req.audit.entityType,
          entity_id: req.audit.entityId,
          changes: req.audit.changes,
          ip_address: req.ip,
          user_agent: req.headers['user-agent'],
        }).catch((e) => console.error('Audit log failed:', e.message));
      }
    });

    next();
  };
}

async function writeAuditLog(entry) {
  // audit_log 表沒有 RLS（系統表）、所以用 withoutTenant
  return withoutTenant(async (db) => {
    await db.query(
      `INSERT INTO audit_log
       (tenant_id, user_id, action, entity_type, entity_id, changes, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.tenant_id,
        entry.user_id,
        entry.action,
        entry.entity_type,
        entry.entity_id,
        entry.changes ? JSON.stringify(entry.changes) : null,
        entry.ip_address,
        entry.user_agent,
      ]
    );
  });
}

/**
 * 手動寫入 audit log（特殊事件、e.g. 重要登入失敗）
 */
export async function logEvent(params) {
  return writeAuditLog(params);
}
