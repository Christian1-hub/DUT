const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const jwt     = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'camunolearn_secret_dev';

// Sessions en mémoire
const sessions = new Map();

// POST /api/qrsession/create
router.post('/create', (req, res) => {
  const sessionId = require('crypto').randomUUID();
  sessions.set(sessionId, { status: 'pending', role: null, createdAt: Date.now() });
  setTimeout(() => sessions.delete(sessionId), 5 * 60 * 1000);
  res.json({ success: true, sessionId });
});

// POST /api/qrsession/validate/:sessionId
router.post('/validate/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ success: false, message: 'QR expiré ou invalide.' });
  if (session.status === 'validated') return res.status(400).json({ success: false, message: 'QR déjà utilisé.' });
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Non authentifié.' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), SECRET);
    const r = await pool.query('SELECT role FROM users WHERE id=$1', [decoded.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
    const realRole = r.rows[0].role;
    session.status = 'validated';
    session.role   = realRole;
    sessions.set(req.params.sessionId, session);
    res.json({ success: true, role: realRole });
  } catch(e) {
    res.status(401).json({ success: false, message: 'Token invalide.' });
  }
});

// GET /api/qrsession/status/:sessionId
router.get('/status/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.json({ status: 'expired' });
  res.json({ status: session.status, role: session.role });
});

module.exports = router;