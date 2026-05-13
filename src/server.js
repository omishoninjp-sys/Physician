import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

import authRoutes from './routes/auth.js';
import clientRoutes from './routes/clients.js';
import journalRoutes from './routes/journal.js';
import reportRoutes from './routes/reports.js';
import bankRoutes from './routes/bank.js';
import { isEmbeddingEnabled } from './services/embedding.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Railway などの proxy 環境で正しい IP を取得
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '10mb' })); // CSV 取り込みのために大きめ

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/journal-entries', journalRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/bank', bankRoutes);

// Health check
app.get('/api/health', (req, res) => {
  const aiMode = process.env.ANTHROPIC_API_KEY
    ? isEmbeddingEnabled()
      ? 'claude+rag'
      : 'claude'
    : 'demo';

  res.json({
    status: 'ok',
    ai_mode: aiMode,
    timestamp: new Date().toISOString(),
  });
});

// 靜態前端
app.use(express.static(join(__dirname, '..', 'public')));

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'サーバーエラー' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  const aiMode = process.env.ANTHROPIC_API_KEY
    ? isEmbeddingEnabled()
      ? '🧠 Claude + RAG (pgvector)'
      : '🤖 Claude (RAG なし)'
    : '🔧 Demo (キーワードマッチ)';

  console.log(`\n🟢 GoyouLink Accounting MVP`);
  console.log(`📍 http://localhost:${port}`);
  console.log(`${aiMode}\n`);
});
