require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

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

  // Only allow SELECT — the frontend has no reason to write anything
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

// ── Health check (Render uses this) ──────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`footy-history running on http://localhost:${PORT}`);
});