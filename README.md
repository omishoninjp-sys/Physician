# GoyouLink Accounting MVP

> AI 記帳助手 for 稅理士事務所
> 對應規格書 v2.0 / 系統架構規劃書 v1.0 / AI 自動仕訳技術可行性備忘

---

## 包含的功能

### Phase 0 基盤
- ✅ Multi-tenant + PostgreSQL **Row-Level Security**（事務所間データ漏洩を DB 層で防御）
- ✅ JWT 認證 + bcrypt
- ✅ **Audit log**（全業務 API call 記錄、改ざん禁止）
- ✅ **借貸平衡 trigger**（DB 層で強制、アプリ bug でも一致しない仕訳を拒絶）
- ✅ decimal.js 金額計算（float 誤差ゼロ）

### Phase 1 MVP 機能
- ✅ 顧問先管理 + 自動 seed 28 標準勘定科目
- ✅ 仕訳入力（手動 / AI 提案）
- ✅ **AI 自動仕訳 pipeline** (4 階層)：
  - Step 1: 規則引擎（98% 信頼度）
  - Step 2: RAG 検索（pgvector）
  - Step 3: Claude Haiku 分類
  - Step 4: 信頼度判定
- ✅ **銀行 CSV 取り込み**（MUFG / SMBC / 楽天 / 汎用形式）
- ✅ **AI 一括分類**（pending bank transactions を batch 処理）
- ✅ 試算表 / 損益計算
- ✅ React SPA 前端

### Phase 2+ 未実装
- ❌ Receipt OCR（Document AI 統合）
- ❌ LINE Bot 領収書アップロード
- ❌ PDF 月次報告書
- ❌ 月締めワークフロー
- ❌ 消費税申告書 draft

---

## クイックスタート

### 必要環境
- Node.js 20+
- PostgreSQL 14+ with **pgvector** extension
- (選填) Anthropic API key — Claude を使用
- (選填) OpenAI API key — RAG 機能を有効化

### セットアップ

```bash
# 1. 依存パッケージ
npm install

# 2. PostgreSQL（pgvector 込み）
createdb goyoulink_mvp
psql goyoulink_mvp -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 3. 環境変数
cp .env.example .env
# .env を編集（DATABASE_URL、ANTHROPIC_API_KEY、OPENAI_API_KEY）

# 4. Migration
npm run migrate

# 5. 起動
npm run dev
```

http://localhost:3000 にアクセス。

---

## 3 つの動作モード

ANTHROPIC_API_KEY と OPENAI_API_KEY の設定によって 3 段階の精度モードで動作：

| モード | ANTHROPIC | OPENAI | 精度（目安） |
|---|---|---|---|
| 🔧 Demo | × | × | 約 60%（keyword） |
| 🤖 Claude | ○ | × | 80〜90% |
| 🧠 **Claude + RAG** | ○ | ○ | 90〜95%（学習で更に向上） |

起動時のログで現在のモードを確認できる。

---

## デモフロー（5 分）

1. **事務所登録**：名前・メール・パスワードを入力 → 自動ログイン
2. **顧客登錄**：「+ 新規顧問先」→ 業種選択 → **28 個の勘定科目が自動セット**
3. **仕訳入力**：「+ 仕訳入力」→ 摘要「東京電力 5 月分」¥5,432 → **🤖 AI 自動仕訳**
4. **AI が「5303 水道光熱費 / 信頼度 98%」を提案**（規則引擎が hit）
5. **銀行明細**：「📥 CSV 取り込み」→ サンプル CSV を貼り付け
6. **🤖 AI 一括仕訳**：未処理取引を一気に分類
7. **試算表**：仕訳が即時反映、損益確認

---

## ファイル構成

```
goyoulink-mvp/
├── package.json
├── railway.json                 ← Railway デプロイ設定
├── DEPLOY.md                    ← Railway 部署完整手順
├── .env.example
├── migrations/
│   ├── 001_initial_schema.sql   ← 基本テーブル + RLS + 借貸平衡 trigger
│   └── 002_audit_bank_rag.sql   ← audit log + 銀行明細 + pgvector
├── src/
│   ├── server.js                ← Express 起動
│   ├── db.js                    ← withTenant() helper（RLS 核心）
│   ├── migrate.js
│   ├── middleware/
│   │   ├── auth.js              ← JWT
│   │   └── audit.js             ← Audit log middleware
│   ├── routes/
│   │   ├── auth.js              ← 登録 / ログイン
│   │   ├── clients.js           ← 顧客 CRUD + auto seed
│   │   ├── journal.js           ← 仕訳 + AI 提案 + RAG 学習
│   │   ├── bank.js              ← 銀行 CSV import + AI 一括分類
│   │   └── reports.js           ← 試算表
│   └── services/
│       ├── accountSeed.js       ← 標準勘定科目（28 個）
│       ├── csvParser.js         ← MUFG / SMBC / 楽天 / 汎用
│       ├── embedding.js         ← OpenAI embedding wrapper
│       └── aiClassifier.js      ← 4 階層 pipeline
└── public/
    └── index.html               ← React SPA（CDN）
```

---

## 動作確認（E2E テスト結果）

このリポジトリは下記のシナリオを実機で検証済み：

### 1. AI 分類精度（demo mode、5 件サンプル）

```
東京電力 5月分電気代  ¥5,432    → 5303 水道光熱費  (98% via Rule) ✓
オフィス家賃          ¥250,000  → 5309 地代家賃    (75% via Keyword) ✓
売上 株式会社A        ¥150,000  → 5312 雑費        (30% 要確認) ⚠ 適切に低信頼度
タクシー代            ¥1,850    → 5301 旅費交通費  (75%) ✓
会議費 カフェ         ¥1,200    → 5306 会議費      (75%) ✓
```

「売上」は demo mode の keyword に無いため低信頼度（30%）が正しく出る。Claude モードでは 4001 売上高に正しく分類される。

### 2. Multi-tenant 隔離

- Tenant A: 1 顧客（株式会社サンプル）
- Tenant B: 0 顧客
- → **DB レベル RLS で完全隔離**、アプリ bug があっても漏洩しない

### 3. Audit log

- IMPORT（CSV 取り込み）→ 自動記錄
- AI_BATCH_CLASSIFY（一括分類）→ 自動記錄
- 全業務操作が 7 年保存対応の audit_log に蓄積

---

## デプロイ

Railway へのデプロイは `DEPLOY.md` 参照。
GitHub push → Railway 自動 build → 10 分で本番化。

コスト目安：月 $12〜22（小規模）、月 $30〜（100 顧客 / 1 万仕訳）。

---

## 本番投入前に必須

これは **demo / PoC** 目的。本番運用前に：

- [ ] HTTPS 強制
- [ ] パスワード強度ポリシー
- [ ] Rate limiting 強化
- [ ] backup / DR 戦略
- [ ] ISMS / 個人情報保護法対応
- [ ] 損害賠償責任保険
- [ ] 稅理士顧問による法規 review
- [ ] Soft delete 全業務テーブル
- [ ] 電子帳簿保存法対応（タイムスタンプ局統合）

これらなしで本番運用は **絶対 NG**（顧客財務データを扱うため）。

---

## アーキテクチャ参照

- `規格書 v2.0` ── プロダクト機能仕様
- `システム架構規劃書 v1.0` ── 全体アーキテクチャ
- `AI 自動仕訳技術可行性備忘` ── 95% 精度への技術路徑
- 本 MVP ── 上記すべての具体実装

詳細は各設計文書参照。
