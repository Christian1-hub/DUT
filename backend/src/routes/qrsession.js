const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const jwt     = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'camunolearn_secret_dev';

// POST /api/qrsession/create
router.post('/create', async (req, res) => {
  try {
    const sessionId = require('crypto').randomUUID();
    const { pendingRole, user_info } = req.body;
    await pool.query(
      `INSERT INTO qr_sessions (session_id, status, role, user_info, created_at, expires_at)
       VALUES ($1, 'pending', $2, $3, NOW(), NOW() + INTERVAL '15 minutes')`,
      [sessionId, pendingRole || null, user_info ? JSON.stringify(user_info) : null]
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
    const { role } = req.body;
    const r = await pool.query(
      `UPDATE qr_sessions SET status='validated', role=COALESCE($1, role)
       WHERE session_id=$2 AND expires_at > NOW() AND status='pending'
       RETURNING session_id, role`,
      [role || null, req.params.sessionId]
    );
    if (!r.rows.length) return res.status(400).json({ success: false, message: 'Session expirée ou déjà utilisée.' });
    res.json({ success: true, role: r.rows[0].role });
  } catch(e) {
    console.error('[QR VALIDATE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});


// GET /api/qrsession/status/:sessionId
router.get('/status/:sessionId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT status, role, user_info FROM qr_sessions
       WHERE session_id=$1 AND expires_at > NOW()`,
      [req.params.sessionId]
    );
    if (!r.rows.length) return res.json({ status: 'expired' });
    var row = r.rows[0];
    var userInfo = row.user_info ? (typeof row.user_info === 'string' ? JSON.parse(row.user_info) : row.user_info) : null;
    res.json({ status: row.status, role: row.role, user_info: userInfo });
  } catch(e) {
    console.error('[QR STATUS]', e.message);
    res.json({ status: 'expired' });
  }
});

module.exports = router;