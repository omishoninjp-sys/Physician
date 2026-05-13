/**
 * Embedding service
 * OpenAI text-embedding-3-small（1536 dim、cosine similarity）
 * OpenAI key なしの場合は disabled、RAG なしモードで動作
 */

const OPENAI_KEY = process.env.OPENAI_API_KEY;

export function isEmbeddingEnabled() {
  return !!OPENAI_KEY;
}

/**
 * テキストを 1536 次元 vector に変換
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
export async function embed(text) {
  if (!OPENAI_KEY) return null;

  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('OpenAI embed error:', err);
      return null;
    }

    const data = await res.json();
    return data.data[0].embedding;
  } catch (e) {
    console.error('Embed error:', e.message);
    return null;
  }
}

/**
 * 複数テキストを batch で embed
 */
export async function embedBatch(texts) {
  if (!OPENAI_KEY || texts.length === 0) return texts.map(() => null);

  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: texts,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('OpenAI embed batch error:', err);
      return texts.map(() => null);
    }

    const data = await res.json();
    return data.data.map((d) => d.embedding);
  } catch (e) {
    console.error('Embed batch error:', e.message);
    return texts.map(() => null);
  }
}

/**
 * pgvector 用のベクトル形式（'[0.1,0.2,...]'）に変換
 */
export function toPgVector(embedding) {
  if (!embedding) return null;
  return `[${embedding.join(',')}]`;
}
