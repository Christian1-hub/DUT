const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool    = require('../db/pool');

// Sessions en mémoire — expire après 5 minutes
const sessions = new Map();

// ── Créer une session QR (PC) ────────────────────────────
router.post('/create', (req, res) => {
  const sessionId = uuidv4();
  sessions.set(sessionId, { status: 'pending', role: null, createdAt: Date.now() });
  setTimeout(() => sessions.delete(sessionId), 5 * 60 * 1000);
  res.json({ success: true, sessionId });
});

// ── Valider (téléphone après scan) ───────────────────────
// Le vrai rôle est lu en base — impossible de tricher
router.post('/validate/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session)
    return res.status(404).json({ success: false, message: 'QR expiré ou invalide.' });
  if (session.status === 'validated')
    return res.status(400).json({ success: false, message: 'QR déjà utilisé.' });

  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ success: false, message: 'Non authentifié.' });

  try {
    const jwt     = require('jsonwebtoken');
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), process.env.JWT_SECRET);
    const r       = await pool.query('SELECT role FROM users WHERE id=$1', [decoded.id]);
    if (!r.rows.length)
      return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });

    const realRole     = r.rows[0].role;
    session.status     = 'validated';
    session.role       = realRole;
    sessions.set(req.params.sessionId, session);
    res.json({ success: true, message: 'Rôle confirmé !', role: realRole });
  } catch(e) {
    console.error('[QRSESSION]', e.message);
    res.status(401).json({ success: false, message: 'Token invalide.' });
  }
});

// ── Statut (polling PC toutes les 2s) ────────────────────
router.get('/status/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.json({ status: 'expired' });
  res.json({ status: session.status, role: session.role });
});

module.exports = router;