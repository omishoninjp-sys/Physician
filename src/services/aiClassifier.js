import Anthropic from '@anthropic-ai/sdk';
import { withTenant } from '../db.js';
import { embed, isEmbeddingEnabled, toPgVector } from './embedding.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
const client = apiKey ? new Anthropic({ apiKey }) : null;

/**
 * 多階層パイプライン：
 *   Step 1: 規則引擎マッチ（高頻定型 → 100% 信頼度）
 *   Step 2: RAG 検索（pgvector で類似 5 件取得）
 *   Step 3: Claude Haiku 分類（context 込み）
 *   Step 4: 信頼度判定
 */
export async function classifyTransaction(params) {
  const { description, amount, industry, accounts, tenant_id, client_id } = params;

  // ─── Step 1: 規則引擎
  const ruleHit = checkRules(description, accounts);
  if (ruleHit) return ruleHit;

  // ─── Demo mode（Claude API なし）
  if (!client) return demoClassify({ description, accounts });

  try {
    // RAG: 類似過去仕訳の取得
    let similarExamples = [];
    if (tenant_id && isEmbeddingEnabled()) {
      similarExamples = await findSimilarExamples({
        tenant_id,
        client_id,
        description,
      });
    }

    return await classifyWithClaude({
      description,
      amount,
      industry,
      accounts,
      similarExamples,
    });
  } catch (e) {
    console.error('AI classify error:', e.message);
    return demoClassify({ description, accounts });
  }
}

// ─── Step 1: 規則引擎 ─────────────────────────────────────────
function checkRules(description, accounts) {
  const desc = description.toLowerCase();

  const strongRules = [
    { kw: ['東京電力', '関西電力', '中部電力'], code: '5303', tax: 10, conf: 0.98 },
    { kw: ['東京ガス', '大阪ガス'], code: '5303', tax: 10, conf: 0.98 },
    { kw: ['ntt', 'docomo', 'softbank', 'kddi'], code: '5302', tax: 10, conf: 0.95 },
    { kw: ['法人税', '所得税', '源泉徴収', '住民税'], code: '5311', tax: 0, conf: 0.95 },
  ];

  for (const rule of strongRules) {
    if (rule.kw.some((k) => desc.includes(k.toLowerCase()))) {
      const account = accounts.find((a) => a.code === rule.code);
      if (account) {
        return {
          account_code: account.code,
          account_id: account.id,
          account_name: account.name,
          tax_rate: rule.tax,
          confidence: rule.conf,
          reasoning: `[Rule] 「${rule.kw[0]}」キーワードマッチ`,
          source: 'rule',
        };
      }
    }
  }
  return null;
}

// ─── Step 2: RAG 検索 ─────────────────────────────────────────
async function findSimilarExamples({ tenant_id, client_id, description }) {
  const queryEmbedding = await embed(description);
  if (!queryEmbedding) return [];

  try {
    return await withTenant(tenant_id, async (db) => {
      const { rows } = await db.query(
        `SELECT
           ate.input_description,
           ate.input_amount,
           ate.output_tax_rate,
           coa.code AS account_code,
           coa.name AS account_name,
           1 - (ate.embedding <=> $1::vector) AS similarity
         FROM ai_training_examples ate
         JOIN chart_of_accounts coa ON coa.id = ate.output_account_id
         WHERE (ate.client_id = $2 OR ate.client_id IS NULL)
           AND ate.embedding IS NOT NULL
         ORDER BY ate.embedding <=> $1::vector
         LIMIT 5`,
        [toPgVector(queryEmbedding), client_id]
      );
      return rows.filter((r) => r.similarity > 0.7);
    });
  } catch (e) {
    console.error('RAG search error:', e.message);
    return [];
  }
}

// ─── Step 3: Claude 分類 ─────────────────────────────────────
async function classifyWithClaude({ description, amount, industry, accounts, similarExamples }) {
  const accountsContext = accounts
    .filter((a) => a.category === 'expense' || a.category === 'revenue')
    .map((a) => `  ${a.code} | ${a.name} | 税率 ${a.default_tax_rate}%`)
    .join('\n');

  let examplesContext = '';
  if (similarExamples.length > 0) {
    examplesContext = `\n【過去の類似仕訳（参考）】\n`;
    for (const ex of similarExamples) {
      examplesContext += `  「${ex.input_description}」¥${Number(ex.input_amount).toLocaleString()} → ${ex.account_code} ${ex.account_name}（税率 ${ex.output_tax_rate}%）類似度 ${(ex.similarity * 100).toFixed(0)}%\n`;
    }
    examplesContext += `\n上記の類似仕訳パターンを最優先で参考にしてください。\n`;
  }

  const prompt = `あなたは熟練の会計士です。以下の取引を、提供された勘定科目表から最適な科目に分類してください。

【取引情報】
内容: ${description}
金額: ${amount.toLocaleString()} 円
業種: ${industry || '不明'}
${examplesContext}
【利用可能な勘定科目】
${accountsContext}

【出力形式】
必ず以下の JSON 形式で出力してください。説明文は不要です。
{
  "account_code": "勘定科目コード",
  "tax_rate": 税率の数値（10、8、または 0）,
  "confidence": 0.0〜1.0 の信頼度,
  "reasoning": "なぜこの科目を選んだかの簡潔な理由（30 字以内）"
}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI 返回非 JSON');
  const parsed = JSON.parse(jsonMatch[0]);

  const account = accounts.find((a) => a.code === parsed.account_code);
  if (!account) throw new Error(`勘定科目 ${parsed.account_code} 不存在`);

  // 類似例ある場合は信頼度ブースト
  let confidence = parsed.confidence;
  if (similarExamples.length >= 3 && similarExamples[0].similarity > 0.85) {
    confidence = Math.min(0.98, confidence + 0.1);
  }

  return {
    account_code: account.code,
    account_id: account.id,
    account_name: account.name,
    tax_rate: parsed.tax_rate,
    confidence,
    reasoning: parsed.reasoning,
    source: similarExamples.length > 0 ? 'claude+rag' : 'claude',
    rag_examples_used: similarExamples.length,
  };
}

// ─── Demo mode ──────────────────────────────────────────────
function demoClassify({ description, accounts }) {
  const desc = description.toLowerCase();
  const rules = [
    { keywords: ['電力', '電気', '東京電力', '関西電力', '水道', 'ガス'], code: '5303' },
    { keywords: ['交通', '電車', 'タクシー', '新幹線', '駐車'], code: '5301' },
    { keywords: ['通信', '携帯', 'docomo', 'softbank', 'kddi', 'インターネット'], code: '5302' },
    { keywords: ['接待', '会食', 'ディナー', 'ランチ'], code: '5305' },
    { keywords: ['会議', 'ミーティング', 'カフェ'], code: '5306' },
    { keywords: ['家賃', '賃料', 'オフィス賃貸'], code: '5309' },
    { keywords: ['給料', '給与', '人件費'], code: '5201' },
    { keywords: ['消耗品', '文房具', 'コピー用紙'], code: '5304' },
    { keywords: ['広告', 'グーグル広告', 'facebook 広告'], code: '5307' },
  ];

  for (const rule of rules) {
    if (rule.keywords.some((kw) => desc.includes(kw.toLowerCase()))) {
      const account = accounts.find((a) => a.code === rule.code);
      if (account) {
        return {
          account_code: account.code,
          account_id: account.id,
          account_name: account.name,
          tax_rate: account.default_tax_rate,
          confidence: 0.75,
          reasoning: '[Demo mode] キーワードマッチ',
          source: 'demo',
        };
      }
    }
  }

  const fallback = accounts.find((a) => a.code === '5312');
  return {
    account_code: '5312',
    account_id: fallback?.id,
    account_name: '雑費',
    tax_rate: 10,
    confidence: 0.3,
    reasoning: '[Demo mode] 該当なし、要確認',
    source: 'demo',
  };
}

/**
 * 確認された仕訳を学習データとして保存（RAG vector store）
 */
export async function recordTrainingExample({
  tenant_id,
  client_id,
  description,
  amount,
  industry,
  account_id,
  tax_rate,
  source_journal_id,
}) {
  if (!isEmbeddingEnabled()) return;

  try {
    const vector = await embed(description);
    if (!vector) return;

    await withTenant(tenant_id, async (db) => {
      await db.query(
        `INSERT INTO ai_training_examples
         (tenant_id, client_id, input_description, input_amount, input_industry,
          output_account_id, output_tax_rate, embedding, created_from, source_journal_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, 'confirmed_journal', $9)`,
        [
          tenant_id,
          client_id,
          description,
          amount,
          industry || null,
          account_id,
          tax_rate || 0,
          toPgVector(vector),
          source_journal_id,
        ]
      );
    });
  } catch (e) {
    console.error('Training record failed:', e.message);
  }
}
