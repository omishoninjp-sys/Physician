-- ============================================================================
-- 003: 申告ワークフロー OS - 新資料表 + 全 15 個範本 seed
-- ============================================================================
-- v2 pivot：從 AI 記帳助手轉為「稅理士 × 顧問先」共同ワークスペース
-- 既存テーブル（仕訳・銀行 etc）は残す（将来 add-on 可能）
-- ============================================================================

-- ─── 1. document_categories（上層分類）──────────────────────────
CREATE TABLE document_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID, -- NULL = global（system 提供）、設值 = tenant 自訂
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX uniq_global_category_code
  ON document_categories(code) WHERE tenant_id IS NULL;

-- ─── 2. document_templates（範本 master、parent-child 支援）──────
CREATE TABLE document_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  category_id UUID REFERENCES document_categories(id),
  parent_id UUID REFERENCES document_templates(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  frequency_type TEXT NOT NULL CHECK (frequency_type IN (
    'permanent_or_changed',   -- 永続/変動時（登記簿、定款、契約書類）
    'one_time_setup',         -- 一次性（新設法人 only）
    'past_period_reference',  -- 過年度参照（前期/前々期）
    'per_period',             -- 当期毎（領収書、明細等）
    'anytime'                 -- 随時（送付封書等）
  )),
  applicability_hint TEXT,
  optional BOOLEAN DEFAULT FALSE, -- 預設可標「該当なし」
  sort_order INTEGER DEFAULT 100,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX uniq_global_template_code
  ON document_templates(code) WHERE tenant_id IS NULL;
CREATE INDEX idx_templates_parent ON document_templates(parent_id);

-- ─── 3. periods（会計年度 per client）─────────────────────────────
CREATE TABLE periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id),
  fiscal_year INTEGER NOT NULL,
  start_date DATE,
  end_date DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open',          -- 開始
    'in_progress',   -- 書類回収中
    'review',        -- 稅理士レビュー中
    'client_review', -- 客戶確認中
    'confirmed',     -- 客戶確認済み（lock）
    'filed',         -- 申告完了
    'archived'       -- アーカイブ
  )),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, fiscal_year)
);

CREATE INDEX idx_periods_client ON periods(tenant_id, client_id);

-- ─── 4. document_requests（稅理士勾選的清單）──────────────────────
CREATE TABLE document_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id),
  period_id UUID REFERENCES periods(id), -- NULL = permanent/anytime 類型
  template_id UUID NOT NULL REFERENCES document_templates(id),
  custom_name TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested',       -- 稅理士勾選、客戶未動
    'submitted',       -- 客戶已上傳
    'reviewed',        -- 稅理士 OK
    'needs_revision',  -- 稅理士要求重提
    'not_applicable',  -- 客戶標「該当なし」
    'confirmed'        -- 完全 lock
  )),
  required BOOLEAN DEFAULT TRUE,
  notes TEXT,
  requested_by_user_id UUID REFERENCES users(id),
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_requests_client_period ON document_requests(tenant_id, client_id, period_id);
CREATE INDEX idx_requests_status ON document_requests(tenant_id, status);

-- ─── 5. document_submissions（客戶上傳的檔案）──────────────────────
CREATE TABLE document_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  request_id UUID NOT NULL REFERENCES document_requests(id),
  file_url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size BIGINT,
  mime_type TEXT,
  file_hash TEXT NOT NULL, -- SHA-256 改ざん検知
  uploaded_by_user_id UUID REFERENCES users(id),
  uploaded_by_client_user_id UUID,
  uploaded_via TEXT, -- 'web' / 'line' / 'import'
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  superseded_by UUID REFERENCES document_submissions(id)
);

CREATE INDEX idx_submissions_request ON document_submissions(request_id);

-- ─── 6. confirmations（客戶確認、永久 lock 記錄）─────────────────
CREATE TABLE confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  period_id UUID REFERENCES periods(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('period', 'submission', 'draft')),
  target_id UUID NOT NULL,
  confirmation_type TEXT NOT NULL CHECK (confirmation_type IN (
    'draft_review',           -- 暫定決算書の確認
    'final_settlement',       -- 最終決算書の確認
    'filing_acknowledgment'   -- 申告書受領確認
  )),
  confirmed_by_client_user_id UUID,
  confirmed_at TIMESTAMPTZ DEFAULT NOW(),
  ip_address INET,
  notes TEXT,
  snapshot_hash TEXT NOT NULL -- 確認時点的快照 hash
);

CREATE INDEX idx_confirmations_period ON confirmations(period_id);

-- ─── 7. client_users（客戶側用戶、multi-user-ready）─────────────
CREATE TABLE client_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id),
  email TEXT,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN (
    'owner',            -- 経営者（最終確認権限）
    'accounting_staff', -- 経理担当（日常上傳）
    'viewer'            -- 閲覧のみ
  )),
  password_hash TEXT,
  line_user_id TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_client_users_client ON client_users(tenant_id, client_id) WHERE deleted_at IS NULL;

-- ============================================================================
-- RLS（全 7 個新表）
-- ============================================================================
ALTER TABLE document_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_users ENABLE ROW LEVEL SECURITY;

-- categories / templates：global（tenant_id IS NULL）全 tenant 可讀、自訂的限自己
CREATE POLICY tenant_isolation_categories ON document_categories
  FOR ALL TO app_user
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_templates ON document_templates
  FOR ALL TO app_user
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant', true)::uuid);

-- 其他表：嚴格 tenant 隔離
CREATE POLICY tenant_isolation_periods ON periods
  FOR ALL TO app_user USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_requests ON document_requests
  FOR ALL TO app_user USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_submissions ON document_submissions
  FOR ALL TO app_user USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_confirmations ON confirmations
  FOR ALL TO app_user USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_client_users ON client_users
  FOR ALL TO app_user USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- GRANT
GRANT SELECT, INSERT, UPDATE ON document_categories TO app_user;
GRANT SELECT, INSERT, UPDATE ON document_templates TO app_user;
GRANT SELECT, INSERT, UPDATE ON periods TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON document_requests TO app_user;
GRANT SELECT, INSERT, UPDATE ON document_submissions TO app_user;
GRANT SELECT, INSERT, UPDATE ON confirmations TO app_user;
GRANT SELECT, INSERT, UPDATE ON client_users TO app_user;

-- ============================================================================
-- Seed：15 個範本（含子項目、共 ~43 個 templates）
-- ============================================================================
DO $$
DECLARE
  cat_corporate UUID;
  cat_setup UUID;
  cat_past UUID;
  cat_change UUID;
  cat_period UUID;
  cat_contracts UUID;
  cat_misc UUID;

  parent_setup UUID;
  parent_prev UUID;
  parent_prev2 UUID;
  parent_change UUID;
  parent_bank UUID;
BEGIN
  -- Skip if already seeded
  IF EXISTS (SELECT 1 FROM document_categories WHERE code = 'corporate_basic' AND tenant_id IS NULL) THEN
    RETURN;
  END IF;

  -- ─── Categories ─────────────────────────────────────────────
  INSERT INTO document_categories (tenant_id, code, name, sort_order) VALUES
    (NULL, 'corporate_basic', '法人基本書類', 10) RETURNING id INTO cat_corporate;
  INSERT INTO document_categories (tenant_id, code, name, sort_order) VALUES
    (NULL, 'setup', '開業時届出', 20) RETURNING id INTO cat_setup;
  INSERT INTO document_categories (tenant_id, code, name, sort_order) VALUES
    (NULL, 'past_filings', '過年度申告書', 30) RETURNING id INTO cat_past;
  INSERT INTO document_categories (tenant_id, code, name, sort_order) VALUES
    (NULL, 'change_notifications', '異動届', 40) RETURNING id INTO cat_change;
  INSERT INTO document_categories (tenant_id, code, name, sort_order) VALUES
    (NULL, 'period_transactions', '当期取引書類', 50) RETURNING id INTO cat_period;
  INSERT INTO document_categories (tenant_id, code, name, sort_order) VALUES
    (NULL, 'contracts', '契約書類', 60) RETURNING id INTO cat_contracts;
  INSERT INTO document_categories (tenant_id, code, name, sort_order) VALUES
    (NULL, 'misc', 'その他', 70) RETURNING id INTO cat_misc;

  -- ─── 1. 登記簿謄本 ─────────────────────────────────────────
  INSERT INTO document_templates (tenant_id, category_id, code, name, frequency_type, sort_order)
  VALUES (NULL, cat_corporate, 'registration_copy', '登記簿謄本', 'permanent_or_changed', 10);

  -- ─── 2. 定款 ──────────────────────────────────────────────
  INSERT INTO document_templates (tenant_id, category_id, code, name, frequency_type, sort_order)
  VALUES (NULL, cat_corporate, 'articles_of_incorporation', '定款', 'permanent_or_changed', 20);

  -- ─── 3. 開業時届出書（parent + 6 children）────────────────
  INSERT INTO document_templates
    (tenant_id, category_id, code, name, frequency_type, applicability_hint, sort_order)
  VALUES (NULL, cat_setup, 'setup_notifications_group', '開業時届出書', 'one_time_setup', '新設法人のみ', 10)
  RETURNING id INTO parent_setup;

  INSERT INTO document_templates (tenant_id, category_id, parent_id, code, name, frequency_type, sort_order) VALUES
    (NULL, cat_setup, parent_setup, 'setup_kuni',          '設立届（国）',         'one_time_setup', 10),
    (NULL, cat_setup, parent_setup, 'setup_pref',          '設立届（都道府県）',    'one_time_setup', 20),
    (NULL, cat_setup, parent_setup, 'setup_city',          '設立届（市町村）',      'one_time_setup', 30),
    (NULL, cat_setup, parent_setup, 'setup_blue_form',     '青色申告届出書',        'one_time_setup', 40),
    (NULL, cat_setup, parent_setup, 'setup_withholding',   '源泉所得税納期特例',    'one_time_setup', 50),
    (NULL, cat_setup, parent_setup, 'setup_payroll_office','給与支払事務所開設届',  'one_time_setup', 60);

  -- ─── 4. 前期申告書一式（parent + 9 children）──────────────
  INSERT INTO document_templates
    (tenant_id, category_id, code, name, frequency_type, applicability_hint, sort_order)
  VALUES (NULL, cat_past, 'prev_period_filings', '前期の申告書一式', 'past_period_reference', '既存法人 / onboard 時の参照', 10)
  RETURNING id INTO parent_prev;

  INSERT INTO document_templates (tenant_id, category_id, parent_id, code, name, frequency_type, sort_order) VALUES
    (NULL, cat_past, parent_prev, 'prev_national_tax',     '国税申告書（前期）',     'past_period_reference', 10),
    (NULL, cat_past, parent_prev, 'prev_local_tax',        '地方税申告書（前期）',   'past_period_reference', 20),
    (NULL, cat_past, parent_prev, 'prev_consumption_tax',  '消費税申告書（前期）',   'past_period_reference', 30),
    (NULL, cat_past, parent_prev, 'prev_breakdown',        '内訳書（前期）',         'past_period_reference', 40),
    (NULL, cat_past, parent_prev, 'prev_financial',        '決算書（前期）',         'past_period_reference', 50),
    (NULL, cat_past, parent_prev, 'prev_fixed_assets',     '固定資産台帳（前期）',   'past_period_reference', 60),
    (NULL, cat_past, parent_prev, 'prev_trial_balance',    '試算表（前期）',         'past_period_reference', 70),
    (NULL, cat_past, parent_prev, 'prev_general_ledger',   '総勘定元帳（前期）',     'past_period_reference', 80),
    (NULL, cat_past, parent_prev, 'prev_journal',          '仕訳日記帳（前期）',     'past_period_reference', 90);

  -- ─── 5. 前々期申告書一式（parent + 9 children）────────────
  INSERT INTO document_templates
    (tenant_id, category_id, code, name, frequency_type, applicability_hint, sort_order)
  VALUES (NULL, cat_past, 'prev2_period_filings', '前々期の申告書一式', 'past_period_reference', '既存法人 / onboard 時の参照', 20)
  RETURNING id INTO parent_prev2;

  INSERT INTO document_templates (tenant_id, category_id, parent_id, code, name, frequency_type, sort_order) VALUES
    (NULL, cat_past, parent_prev2, 'prev2_national_tax',     '国税申告書（前々期）',     'past_period_reference', 10),
    (NULL, cat_past, parent_prev2, 'prev2_local_tax',        '地方税申告書（前々期）',   'past_period_reference', 20),
    (NULL, cat_past, parent_prev2, 'prev2_consumption_tax',  '消費税申告書（前々期）',   'past_period_reference', 30),
    (NULL, cat_past, parent_prev2, 'prev2_breakdown',        '内訳書（前々期）',         'past_period_reference', 40),
    (NULL, cat_past, parent_prev2, 'prev2_financial',        '決算書（前々期）',         'past_period_reference', 50),
    (NULL, cat_past, parent_prev2, 'prev2_fixed_assets',     '固定資産台帳（前々期）',   'past_period_reference', 60),
    (NULL, cat_past, parent_prev2, 'prev2_trial_balance',    '試算表（前々期）',         'past_period_reference', 70),
    (NULL, cat_past, parent_prev2, 'prev2_general_ledger',   '総勘定元帳（前々期）',     'past_period_reference', 80),
    (NULL, cat_past, parent_prev2, 'prev2_journal',          '仕訳日記帳（前々期）',     'past_period_reference', 90);

  -- ─── 6. 異動届（parent + 3 children）──────────────────────
  INSERT INTO document_templates
    (tenant_id, category_id, code, name, frequency_type, applicability_hint, sort_order)
  VALUES (NULL, cat_change, 'change_notifications', '異動届', 'permanent_or_changed', '情報変更時のみ', 10)
  RETURNING id INTO parent_change;

  INSERT INTO document_templates (tenant_id, category_id, parent_id, code, name, frequency_type, sort_order) VALUES
    (NULL, cat_change, parent_change, 'change_kuni',  '異動届（国）',        'permanent_or_changed', 10),
    (NULL, cat_change, parent_change, 'change_pref',  '異動届（都道府県）',  'permanent_or_changed', 20),
    (NULL, cat_change, parent_change, 'change_city',  '異動届（市町村）',    'permanent_or_changed', 30);

  -- ─── 7. 銀行口座明細（parent + 1 child: 合計記帳明細）─────
  INSERT INTO document_templates
    (tenant_id, category_id, code, name, frequency_type, sort_order)
  VALUES (NULL, cat_period, 'bank_statements', '銀行口座の明細', 'per_period', 10)
  RETURNING id INTO parent_bank;

  INSERT INTO document_templates (tenant_id, category_id, parent_id, code, name, frequency_type, optional, sort_order) VALUES
    (NULL, cat_period, parent_bank, 'bank_combined_detail', '合計記帳の明細（該当あれば）', 'per_period', TRUE, 10);

  -- ─── 8〜11. 経費領収書 / クレカ明細 / 売上明細 / 給与明細 ─
  INSERT INTO document_templates (tenant_id, category_id, code, name, frequency_type, sort_order) VALUES
    (NULL, cat_period, 'expense_receipts',  '経費領収書',          'per_period', 20),
    (NULL, cat_period, 'credit_statements', 'クレジットカードの明細', 'per_period', 30),
    (NULL, cat_period, 'sales_detail',      '売上明細等',          'per_period', 40),
    (NULL, cat_period, 'payroll_detail',    '給与明細',            'per_period', 50);

  -- ─── 12. 借入金返済予定表（有負債時）──────────────────────
  INSERT INTO document_templates
    (tenant_id, category_id, code, name, frequency_type, applicability_hint, optional, sort_order)
  VALUES (NULL, cat_period, 'loan_schedule', '借入金の返済予定表（期末残高確認可能なもの）',
          'per_period', '有借入時のみ', TRUE, 60);

  -- ─── 13. 賃貸契約書 ───────────────────────────────────────
  INSERT INTO document_templates
    (tenant_id, category_id, code, name, frequency_type, applicability_hint, optional, sort_order)
  VALUES (NULL, cat_contracts, 'lease_contract', '賃貸契約書',
          'permanent_or_changed', '賃貸契約があれば', TRUE, 10);

  -- ─── 14. 固定資産の契約書 ────────────────────────────────
  INSERT INTO document_templates
    (tenant_id, category_id, code, name, frequency_type, applicability_hint, optional, sort_order)
  VALUES (NULL, cat_contracts, 'fixed_asset_contract', '固定資産の契約書',
          'permanent_or_changed', '固定資産があれば', TRUE, 20);

  -- ─── 15. 税務署等送付封書 ────────────────────────────────
  INSERT INTO document_templates
    (tenant_id, category_id, code, name, frequency_type, sort_order)
  VALUES (NULL, cat_misc, 'tax_authority_mail',
          '税務署 / 県税事務所 / 市役所から送られてくる封書',
          'anytime', 10);

END $$;
