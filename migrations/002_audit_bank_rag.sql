-- ============================================================================
-- 002: Audit log + Bank import + AI RAG（pgvector）
-- ============================================================================

-- ─── pgvector 擴展（RAG 用）
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- 1. Audit Log（7 年保留、改ざん禁止）
-- ============================================================================
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID,
  user_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  changes JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_tenant_time ON audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

-- 改ざん防止：UPDATE / DELETE を権限剥奪
GRANT INSERT, SELECT ON audit_log TO app_user;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO app_user;
-- 明示的に UPDATE/DELETE 権限を REVOKE
REVOKE UPDATE, DELETE ON audit_log FROM app_user;
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;

-- ============================================================================
-- 2. Bank Account & Transactions
-- ============================================================================
CREATE TABLE bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id),
  bank_name TEXT NOT NULL,
  account_type TEXT, -- 普通 / 当座
  account_number_masked TEXT, -- 末 4 桁
  default_account_id UUID REFERENCES chart_of_accounts(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_bank_accounts_client ON bank_accounts(client_id);

CREATE TABLE bank_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  bank_account_id UUID REFERENCES bank_accounts(id),
  transaction_date DATE NOT NULL,
  description TEXT NOT NULL,
  amount DECIMAL(15,2) NOT NULL, -- 正 = 入金、負 = 出金
  balance_after DECIMAL(15,2),
  -- AI / 仕訳の紐付け
  status TEXT DEFAULT 'unprocessed' CHECK (status IN ('unprocessed', 'ai_suggested', 'matched', 'ignored')),
  matched_journal_id UUID REFERENCES journal_entries(id),
  ai_suggested_account_id UUID REFERENCES chart_of_accounts(id),
  ai_confidence DECIMAL(5,4),
  ai_reasoning TEXT,
  -- 重複防止
  hash_dedup TEXT NOT NULL,
  raw_csv_row JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, hash_dedup)
);

CREATE INDEX idx_bank_tx_client_date ON bank_transactions(client_id, transaction_date DESC);
CREATE INDEX idx_bank_tx_status ON bank_transactions(client_id, status);

-- RLS for bank tables
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_bank_accounts ON bank_accounts
  FOR ALL TO app_user
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_bank_transactions ON bank_transactions
  FOR ALL TO app_user
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ============================================================================
-- 3. AI Training Examples（RAG 用 vector store）
-- ============================================================================
CREATE TABLE ai_training_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID REFERENCES clients(id), -- NULL = 事務所共通
  input_description TEXT NOT NULL,
  input_amount DECIMAL(15,2),
  input_industry TEXT,
  output_account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  output_tax_rate DECIMAL(5,2),
  embedding vector(1536), -- OpenAI text-embedding-3-small dimension
  -- メタ情報
  created_from TEXT, -- 'confirmed_journal' / 'manual_training'
  source_journal_id UUID REFERENCES journal_entries(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- pgvector の近似最近傍検索用 index
CREATE INDEX idx_ai_training_embedding ON ai_training_examples
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_ai_training_scope ON ai_training_examples(tenant_id, client_id);

-- RLS
ALTER TABLE ai_training_examples ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ai_training ON ai_training_examples
  FOR ALL TO app_user
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ============================================================================
-- 4. 新表に app_user 権限付与（migration 001 の GRANT は新表に効かないため）
-- ============================================================================
GRANT SELECT, INSERT, UPDATE ON bank_accounts TO app_user;
GRANT SELECT, INSERT, UPDATE ON bank_transactions TO app_user;
GRANT SELECT, INSERT, UPDATE ON ai_training_examples TO app_user;
-- audit_log は INSERT のみ（改ざん禁止）
GRANT INSERT, SELECT ON audit_log TO app_user;
