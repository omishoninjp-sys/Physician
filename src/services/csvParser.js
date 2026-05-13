import crypto from 'crypto';

/**
 * CSV パーサー
 * Supports: 弥生 standard / 三菱UFJ / 三井住友 / 楽天銀行 / 汎用フォーマット
 */

/**
 * 主入口：CSV 内容を解析して bank_transactions 用の rows に変換
 *
 * @param {string} csvText - CSV 内容
 * @param {string} format - 'auto' | 'yayoi' | 'mufg' | 'smbc' | 'rakuten' | 'generic'
 * @returns {Array<{transaction_date, description, amount, balance_after, hash_dedup, raw}>}
 */
export function parseCSV(csvText, format = 'auto') {
  // BOM 除去
  csvText = csvText.replace(/^\uFEFF/, '');

  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    throw new Error('CSV にデータがありません');
  }

  // フォーマット自動検出
  if (format === 'auto') {
    format = detectFormat(lines[0]);
  }

  const parser = PARSERS[format];
  if (!parser) {
    throw new Error(`未対応の CSV フォーマット: ${format}`);
  }

  return parser(lines);
}

function detectFormat(header) {
  const h = header.toLowerCase();
  if (h.includes('日付') && h.includes('摘要') && h.includes('お引出し')) return 'mufg';
  if (h.includes('お取引日') && h.includes('お取扱内容')) return 'smbc';
  if (h.includes('取引日') && h.includes('入出金区分')) return 'rakuten';
  if (h.includes('日付') && h.includes('科目') && h.includes('補助科目')) return 'yayoi';
  return 'generic';
}

const PARSERS = {
  // ─── 汎用：列順を推測（date, description, amount）─────────────
  generic: (lines) => {
    const rows = [];
    const header = parseCSVLine(lines[0]).map((c) => c.toLowerCase());
    const dateIdx = header.findIndex((c) => /日付|date|取引日/i.test(c));
    const descIdx = header.findIndex((c) => /摘要|内容|description|memo/i.test(c));
    const amountIdx = header.findIndex((c) => /金額|amount/i.test(c));

    if (dateIdx === -1 || descIdx === -1 || amountIdx === -1) {
      throw new Error('CSV ヘッダーから date / description / amount 列が判別できません');
    }

    for (let i = 1; i < lines.length; i++) {
      const cells = parseCSVLine(lines[i]);
      if (cells.length < 3) continue;
      const row = buildRow({
        date: cells[dateIdx],
        description: cells[descIdx],
        amount: cells[amountIdx],
      });
      if (row) rows.push(row);
    }
    return rows;
  },

  // ─── 三菱UFJ ─────────────────────────────────────────────
  // 列：日付, 摘要, お引出し, お預入れ, 残高, ...
  mufg: (lines) => {
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCSVLine(lines[i]);
      if (cells.length < 5) continue;
      const date = cells[0];
      const desc = cells[1];
      const withdrawal = parseAmount(cells[2]);
      const deposit = parseAmount(cells[3]);
      const balance = parseAmount(cells[4]);
      const amount = deposit > 0 ? deposit : -withdrawal;
      const row = buildRow({ date, description: desc, amount, balance });
      if (row) rows.push(row);
    }
    return rows;
  },

  // ─── 三井住友 ─────────────────────────────────────────────
  // 列：お取引日, お取扱内容, お支払金額, お預り金額, 残高
  smbc: (lines) => {
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCSVLine(lines[i]);
      if (cells.length < 5) continue;
      const out = parseAmount(cells[2]);
      const inAmt = parseAmount(cells[3]);
      const amount = inAmt > 0 ? inAmt : -out;
      const row = buildRow({
        date: cells[0],
        description: cells[1],
        amount,
        balance: parseAmount(cells[4]),
      });
      if (row) rows.push(row);
    }
    return rows;
  },

  // ─── 楽天銀行 ─────────────────────────────────────────────
  rakuten: (lines) => {
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCSVLine(lines[i]);
      if (cells.length < 4) continue;
      // 取引日, 入出金区分, 金額, 取引後残高, 取引内容
      const sign = cells[1]?.includes('出') ? -1 : 1;
      const amount = parseAmount(cells[2]) * sign;
      const row = buildRow({
        date: cells[0],
        description: cells[4] || cells[1],
        amount,
        balance: parseAmount(cells[3]),
      });
      if (row) rows.push(row);
    }
    return rows;
  },

  // ─── 弥生 standard ────────────────────────────────────────
  // 弥生は仕訳形式なので、ここでは銀行明細としては parse しない
  // （別途仕訳 import 機能で対応する想定）
  yayoi: (lines) => {
    throw new Error('弥生形式の取り込みは別機能（仕訳 import）から実行してください');
  },
};

// ─── ヘルパー ──────────────────────────────────────────────

function parseCSVLine(line) {
  // シンプルな CSV parse（quote 対応）
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function parseAmount(s) {
  if (!s) return 0;
  // カンマ・通貨記号・スペースを除去
  const cleaned = String(s).replace(/[¥,，円\s]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function parseDate(s) {
  if (!s) return null;
  // 2026/05/13、2026-05-13、2026.5.13 等を対応
  const cleaned = String(s).replace(/[.\/]/g, '-');
  const m = cleaned.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function buildRow({ date, description, amount, balance }) {
  const parsedDate = parseDate(date);
  if (!parsedDate || !description) return null;
  const amt = typeof amount === 'number' ? amount : parseAmount(amount);
  if (amt === 0) return null;

  // 重複検知用 hash：date + description + amount
  const hash = crypto
    .createHash('sha256')
    .update(`${parsedDate}|${description}|${amt}`)
    .digest('hex')
    .slice(0, 32);

  return {
    transaction_date: parsedDate,
    description: description.trim(),
    amount: amt,
    balance_after: balance || null,
    hash_dedup: hash,
    raw: { date, description, amount, balance },
  };
}
