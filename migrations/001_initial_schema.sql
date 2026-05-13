-- ============================================================================
-- GoyouLink Accounting MVP - 初始 Schema
-- 重點：Multi-tenant via Row-Level Security
-- ============================================================================

-- UUID 擴展（PostgreSQL 內建）
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. 稅理士事務所（tenant）
-- ============================================================================
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- ============================================================================
-- 2. 事務所員工
-- ============================================================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'senior' CHECK (role IN ('manager', 'senior', 'junior')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_tenant ON users(tenant_id);

-- ============================================================================
-- 3. 顧問先（client）
-- ============================================================================
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  company_name TEXT NOT NULL,
  industry TEXT, -- 建設業 / IT / 飲食 etc.
  fiscal_year_start_month SMALLINT NOT NULL DEFAULT 4,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_clients_tenant ON clients(tenant_id) WHERE deleted_at IS NULL;

-- ============================================================================
-- 4. 勘定科目表
-- ============================================================================
CREATE TABLE chart_of_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  default_tax_rate DECIMAL(5,2) DEFAULT 0,
  sort_order INTEGER DEFAULT 100,
  is_active BOOLEAN DEFAULT TRUE,
  UNIQUE (client_id, code)
);

CREATE INDEX idx_accounts_client ON chart_of_accounts(client_id);

-- ============================================================================
-- 5. 仕訳（會計傳票）
-- ============================================================================
CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id),
  entry_date DATE NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('draft', 'pending_review', 'confirmed')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai_suggested')),
  ai_confidence DECIMAL(5,4),
  ai_reasoning TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_journal_entries_client ON journal_entries(tenant_id, client_id, entry_date DESC);

-- ============================================================================
-- 6. 仕訳明細（借方・貸方）
-- ============================================================================
CREATE TABLE journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_order INTEGER NOT NULL,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount DECIMAL(15,2) NOT NULL CHECK (amount >= 0), -- 絕對不可用 FLOAT
  tax_rate DECIMAL(5,2) DEFAULT 0,
  memo TEXT
);

CREATE INDEX idx_journal_lines_entry ON journal_lines(journal_entry_id);
CREATE INDEX idx_journal_lines_account ON journal_lines(account_id);

-- ============================================================================
-- 7. Row-Level Security (RLS) - 核心隔離機制
-- ============================================================================

-- 建立 application role
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- 啟用 RLS（tenants 和 users 表不啟用、用其他方式控制）
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;

-- RLS Policy：只能存取自己 tenant 的資料
CREATE POLICY tenant_isolation_clients ON clients
  FOR ALL TO app_user
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_accounts ON chart_of_accounts
  FOR ALL TO app_user
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_journal_entries ON journal_entries
  FOR ALL TO app_user
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_journal_lines ON journal_lines
  FOR ALL TO app_user
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ============================================================================
-- 8. 借貸平衡 trigger（會計系統命脈）
-- ============================================================================
CREATE OR REPLACE FUNCTION check_journal_balance() RETURNS TRIGGER AS $$
DECLARE
  diff DECIMAL(15,2);
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE 0 END), 0) -
    COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END), 0)
    INTO diff
  FROM journal_lines
  WHERE journal_entry_id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  IF diff != 0 THEN
    RAISE EXCEPTION '仕訳の借方・貸方が一致しません（差額: %）', diff;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_journal_balance();
