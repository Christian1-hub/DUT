const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const jwt     = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'camunolearn_secret_dev';

// POST /api/qrsession/create
router.post('/create', async (req, res) => {
  try {
    const sessionId = require('crypto').randomUUID();
    await pool.query(
      `INSERT INTO qr_sessions (session_id, status, created_at, expires_at)
       VALUES ($1, 'pending', NOW(), NOW() + INTERVAL '5 minutes')`,
      [sessionId]
    );
    res.json({ success: true, sessionId });
  } catch(e) {
    console.error('[QR CREATE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// POST /api/qrsession/validate/:sessionId
router.post('/validate/:sessionId', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, message: 'Non authentifié.' });

    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), SECRET);
    const userResult = await pool.query('SELECT role FROM users WHERE id=$1', [decoded.id]);
    if (!userResult.rows.length) return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });

    const realRole = userResult.rows[0].role;

    const r = await pool.query(
      `UPDATE qr_sessions SET status='validated', role=$1
       WHERE session_id=$2 AND expires_at > NOW() AND status='pending'
       RETURNING session_id`,
      [realRole, req.params.sessionId]
    );

    if (!r.rows.length) return res.status(400).json({ success: false, message: 'Session expirée ou déjà utilisée.' });

    res.json({ success: true, role: realRole });
  } catch(e) {
    console.error('[QR VALIDATE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// GET /api/qrsession/status/:sessionId
router.get('/status/:sessionId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT status, role FROM qr_sessions
       WHERE session_id=$1 AND expires_at > NOW()`,
      [req.params.sessionId]
    );
    if (!r.rows.length) return res.json({ status: 'expired' });
    res.json({ status: r.rows[0].status, role: r.rows[0].role });
  } catch(e) {
    console.error('[QR STATUS]', e.message);
    res.json({ status: 'expired' });
  }
});

module.exports = router;