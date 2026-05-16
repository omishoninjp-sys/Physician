-- ============================================================================
-- 004: GRANT DELETE on document_requests
-- ============================================================================
-- Issue: migration 003 のみ SELECT/INSERT/UPDATE を grant、DELETE が漏れていた。
-- 結果：チェックボックスの toggle off（=request 削除）が
-- "permission denied for table document_requests" で失敗。
--
-- document_requests は submissions が無い段階での「やっぱり要らない」を
-- 表現するため hard delete 許可。submissions がある request は
-- 別途 application 層で削除拒否（将来 enhancement）。
-- ============================================================================

GRANT DELETE ON document_requests TO app_user;
