import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import { fileURLToPath } from 'url';
import path from 'path';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SQL proxy endpoint ────────────────────────────────────────────────────────
app.post('/query', async (req, res) => {
  const { query, params = [] } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Missing query' });
  }

  if (!query.trim().toUpperCase().startsWith('SELECT')) {
    return res.status(403).json({ error: 'Only SELECT queries are permitted' });
  }

  try {
    const result = await pool.query(query, params);
    res.json({ rows: result.rows });
  } catch (err) {
    console.error('DB error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Root → app.html ───────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`footy-history running on http://localhost:${PORT}`);
});
