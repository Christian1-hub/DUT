// src/routes/messages.js
// Messagerie directe — conversations privées entre membres d'un même établissement
const express = require('express');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

router.use(auth);

// ═══════════════════════════════════════════
//  Contacts disponibles (même école, tous rôles)
// ═══════════════════════════════════════════
router.get('/contacts', async (req, res) => {
  try {
    const me = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const school = me.rows[0]?.school || null;
    if (!school) return res.json({ success: true, contacts: [] });

    const r = await pool.query(`
      SELECT id, first_name, last_name, email, role, avatar_url
      FROM users
      WHERE school=$1 AND id<>$2 AND role IN ('etudiant','enseignant','admin')
      ORDER BY role, first_name
    `, [school, req.user.id]);
    res.json({ success: true, contacts: r.rows });
  } catch(e) {
    console.error('[MSG CONTACTS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  Mes conversations (aperçu + non-lus)
// ═══════════════════════════════════════════
router.get('/conversations', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT conv.id,
             other.id AS other_id, other.first_name||' '||other.last_name AS other_name,
             other.role AS other_role, other.avatar_url AS other_avatar,
             lm.content AS last_message, lm.created_at AS last_at, lm.sender_id AS last_sender_id,
             (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=conv.id AND m.sender_id<>$1 AND m.is_read=FALSE) AS unread_count
      FROM conversations conv
      JOIN users other ON other.id = CASE WHEN conv.user_a=$1 THEN conv.user_b ELSE conv.user_a END
      LEFT JOIN LATERAL (
        SELECT content, created_at, sender_id FROM messages
        WHERE conversation_id=conv.id ORDER BY created_at DESC LIMIT 1
      ) lm ON TRUE
      WHERE conv.user_a=$1 OR conv.user_b=$1
      ORDER BY COALESCE(lm.created_at, conv.created_at) DESC
    `, [req.user.id]);
    res.json({ success: true, conversations: r.rows });
  } catch(e) {
    console.error('[MSG CONVERSATIONS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  Démarrer / récupérer une conversation
// ═══════════════════════════════════════════
router.post('/conversations', async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, message: 'Destinataire requis.' });
    if (user_id === req.user.id) return res.status(400).json({ success: false, message: 'Impossible de se contacter soi-même.' });

    const target = await pool.query('SELECT school FROM users WHERE id=$1', [user_id]);
    const me     = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    if (!target.rows.length || target.rows[0].school !== me.rows[0]?.school) {
      return res.status(403).json({ success: false, message: 'Utilisateur introuvable dans votre établissement.' });
    }

    const existing = await pool.query(
      `SELECT id FROM conversations WHERE (user_a=$1 AND user_b=$2) OR (user_a=$2 AND user_b=$1)`,
      [req.user.id, user_id]
    );
    if (existing.rows.length) {
      return res.json({ success: true, conversation_id: existing.rows[0].id });
    }

    const r = await pool.query(
      `INSERT INTO conversations (user_a, user_b) VALUES ($1,$2) RETURNING id`,
      [req.user.id, user_id]
    );
    res.status(201).json({ success: true, conversation_id: r.rows[0].id });
  } catch(e) {
    console.error('[MSG CONV CREATE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  Messages d'une conversation (+ marquage lu)
// ═══════════════════════════════════════════
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const conv = await pool.query('SELECT * FROM conversations WHERE id=$1 AND (user_a=$2 OR user_b=$2)', [req.params.id, req.user.id]);
    if (!conv.rows.length) return res.status(404).json({ success: false, message: 'Conversation introuvable.' });

    const r = await pool.query(`
      SELECT m.*, u.first_name||' '||u.last_name AS sender_name
      FROM messages m
      JOIN users u ON m.sender_id=u.id
      WHERE m.conversation_id=$1
      ORDER BY m.created_at ASC
    `, [req.params.id]);

    await pool.query(
      `UPDATE messages SET is_read=TRUE WHERE conversation_id=$1 AND sender_id<>$2 AND is_read=FALSE`,
      [req.params.id, req.user.id]
    );

    res.json({ success: true, messages: r.rows });
  } catch(e) {
    console.error('[MSG LIST]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ success: false, message: 'Message vide.' });

    const conv = await pool.query('SELECT * FROM conversations WHERE id=$1 AND (user_a=$2 OR user_b=$2)', [req.params.id, req.user.id]);
    if (!conv.rows.length) return res.status(404).json({ success: false, message: 'Conversation introuvable.' });

    const r = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, req.user.id, content.trim()]
    );

    const other = conv.rows[0].user_a === req.user.id ? conv.rows[0].user_b : conv.rows[0].user_a;
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, link) VALUES ($1,$2,$3,'message',$4)`,
      [other, 'Nouveau message', content.trim().slice(0,140), '/messages']
    ).catch(()=>{});

    res.status(201).json({ success: true, message: r.rows[0] });
  } catch(e) {
    console.error('[MSG SEND]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  Badge non-lus (polling léger)
// ═══════════════════════════════════════════
router.get('/unread-count', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT COUNT(*) FROM messages m
      JOIN conversations c ON m.conversation_id=c.id
      WHERE (c.user_a=$1 OR c.user_b=$1) AND m.sender_id<>$1 AND m.is_read=FALSE
    `, [req.user.id]);
    res.json({ success: true, count: parseInt(r.rows[0].count) });
  } catch(e) {
    console.error('[MSG UNREAD]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
