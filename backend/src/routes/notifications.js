// src/routes/notifications.js
const express = require('express');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

// Toute personne connectée peut lire/gérer SES notifications (peu importe le rôle)
router.use(auth);

// GET /api/notifications — mes notifications (50 dernières) + compteur non lues
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, title, message, type, link, is_read, created_at
       FROM notifications WHERE user_id=$1
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    const unread = await pool.query(
      `SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=FALSE`,
      [req.user.id]
    );
    res.json({ success: true, notifications: r.rows, unreadCount: parseInt(unread.rows[0].count) });
  } catch(e) {
    console.error('[NOTIFICATIONS GET]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// PUT /api/notifications/:id/read
router.put('/:id/read', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Notification introuvable.' });
    res.json({ success: true });
  } catch(e) {
    console.error('[NOTIF READ]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// PUT /api/notifications/read-all
router.put('/read-all', async (req, res) => {
  try {
    await pool.query(`UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND is_read=FALSE`, [req.user.id]);
    res.json({ success: true });
  } catch(e) {
    console.error('[NOTIF READ ALL]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// DELETE /api/notifications/:id
router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM notifications WHERE id=$1 AND user_id=$2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Notification introuvable.' });
    res.json({ success: true });
  } catch(e) {
    console.error('[NOTIF DELETE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
