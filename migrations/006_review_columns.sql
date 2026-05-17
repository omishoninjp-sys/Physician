-- ============================================================================
-- 006: review / lock workflow columns
-- ============================================================================
-- 稅理士のレビュー機能（OK / 差し戻し）と確認後ロック実装のため：
--   - revision_note: 差し戻し時の理由
--   - reviewed_at: レビュー時刻
--   - reviewed_by_user_id: 誰がレビューしたか
--
-- 状態遷移：
--   requested → submitted（顧客上傳）
--   submitted → reviewed（稅理士 OK = lock、顧客上傳拒否）
--   submitted → needs_revision（稅理士 差し戻し）
--   needs_revision → submitted（顧客再上傳）
--   reviewed → submitted/requested（稅理士 unlock 解除）
-- ============================================================================

ALTER TABLE document_requests
  ADD COLUMN IF NOT EXISTS revision_note TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by_user_id UUID REFERENCES users(id);
