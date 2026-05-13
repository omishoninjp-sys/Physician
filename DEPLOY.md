# Railway デプロイ手順

Railway で本 MVP を本番デプロイする手順（所要時間 約 10 分）。

---

## 前提

- GitHub アカウント
- Railway アカウント（https://railway.app）
- (選填) Anthropic API key
- (選填) OpenAI API key（RAG 機能用）

---

## Step 1: GitHub にコードを push

```bash
cd goyoulink-mvp
git init
git add .
git commit -m "Initial MVP commit"

# GitHub で新リポジトリ作成後
git remote add origin https://github.com/YOUR-USER/goyoulink-mvp.git
git branch -M main
git push -u origin main
```

---

## Step 2: Railway で新プロジェクト作成

1. https://railway.app/new
2. 「Deploy from GitHub repo」
3. GitHub 連携、`goyoulink-mvp` を選択
4. 自動的に Node.js プロジェクトとして認識される

---

## Step 3: PostgreSQL を追加

1. 同じ Railway プロジェクト内で「+ New」
2. 「Database」→「Add PostgreSQL」
3. **重要**：pgvector 拡張を有効化
   - PostgreSQL service の「Settings」→「Variables」
   - または Railway PostgreSQL は最近 pgvector 標準搭載

Railway 提供の PostgreSQL でない場合は、別途 pgvector 対応 PG（Supabase 等）を使用。

---

## Step 4: 環境変数を設定

App service の「Variables」タブで以下を設定：

```
DATABASE_URL              = ${{ Postgres.DATABASE_URL }}  # 自動入力
JWT_SECRET                = 任意のランダム文字列（openssl rand -hex 32）
ANTHROPIC_API_KEY         = sk-ant-...（選填、無い場合は demo mode）
OPENAI_API_KEY            = sk-...（選填、無い場合は RAG 無し）
NODE_ENV                  = production
```

`${{ Postgres.DATABASE_URL }}` は Railway の特殊 syntax で、同プロジェクト内の Postgres service の URL を自動参照する。

---

## Step 5: デプロイ確認

1. Railway が自動的に build + deploy 開始
2. Logs タブで進捗確認：
   ```
   Running 001_initial_schema.sql...
   ✓ 001_initial_schema.sql done
   Running 002_audit_bank_rag.sql...
   ✓ 002_audit_bank_rag.sql done
   ✅ All migrations completed
   🟢 GoyouLink Accounting MVP
   🧠 Claude + RAG (pgvector)
   ```

3. 「Settings」→「Networking」→「Generate Domain」で公開 URL 取得

---

## Step 6: 動作確認

```bash
# Health check
curl https://your-app.up.railway.app/api/health

# 期待結果
{"status":"ok","ai_mode":"claude+rag","timestamp":"..."}
```

ブラウザでアクセス → 事務所登録 → デモ実行。

---

## トラブルシューティング

### pgvector が無効

`vector` extension が無い場合、Railway PostgreSQL のバージョンが古い可能性。
解決策：
- Supabase の Postgres を別途使用（DATABASE_URL を Supabase のものに変更）
- または Neon Postgres（pgvector 対応）

### Migration が失敗

```bash
# Railway CLI で手動 migration
railway login
railway link
railway run npm run migrate
```

### Cold start が遅い

Railway の hobby plan は idle で sleep する。production は Pro plan 推奨（月 $5〜）。

---

## コスト見積もり

| サービス | 月額 |
|---|---|
| Railway Hobby plan | $5 |
| PostgreSQL（小規模） | $5〜 |
| Anthropic Claude Haiku | $1〜10（使用量による） |
| OpenAI Embedding | $0.5〜2 |
| **合計（初期）** | **約 $12〜22 / 月** |

100 顧客 / 1 万仕訳 / 月でも $30 程度に収まる見込み。

---

## CI/CD 設定（オプション）

Railway は GitHub に push するだけで自動 deploy。
追加で `.github/workflows/test.yml` を作成して PR で test 実行も可能。
