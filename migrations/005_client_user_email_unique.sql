-- ============================================================================
-- 005: client_users email UNIQUE constraint
-- ============================================================================
-- portal login のため email を unique identifier として使う。
-- 注：同一 email が複数税理士事務所の客户になる場合は将来別途設計。
--    （MVP では email = global identity と単純化）
-- ============================================================================

ALTER TABLE client_users
  ADD CONSTRAINT client_users_email_unique UNIQUE (email);
