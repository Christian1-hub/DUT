// src/routes/forum.js
// Communautés partagées entre profs et étudiants de la même école
const express = require('express');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

router.use(auth);

// ── GET /api/forum/communities — toutes les communautés de l'école
router.get('/communities', async (req, res) => {
  try {
    const u = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const school = u.rows[0]?.school;

    // Si l'utilisateur n'a pas d'école : retourner toutes les communautés (cas admin global)
    // Si l'utilisateur a une école : retourner les communautés de cette école
    let r;
    if (!school) {
      r = await pool.query(`
        SELECT c.id, c.name, c.description, c.category, c.icon, c.school, c.created_at,
               COUNT(DISTINCT cm.user_id) AS member_count,
               EXISTS(SELECT 1 FROM community_members WHERE community_id=c.id AND user_id=$1) AS is_member,
               u.first_name||' '||u.last_name AS teacher_name,
               u.id AS teacher_id
        FROM communities c
        LEFT JOIN community_members cm ON cm.community_id=c.id
        LEFT JOIN users u ON c.teacher_id=u.id
        GROUP BY c.id, u.first_name, u.last_name, u.id
        ORDER BY c.created_at DESC`,
        [req.user.id]
      );
    } else {
      r = await pool.query(`
        SELECT c.id, c.name, c.description, c.category, c.icon, c.school, c.created_at,
               COUNT(DISTINCT cm.user_id) AS member_count,
               EXISTS(SELECT 1 FROM community_members WHERE community_id=c.id AND user_id=$1) AS is_member,
               u.first_name||' '||u.last_name AS teacher_name,
               u.id AS teacher_id
        FROM communities c
        LEFT JOIN community_members cm ON cm.community_id=c.id
        LEFT JOIN users u ON c.teacher_id=u.id
        WHERE c.school = $2
        GROUP BY c.id, u.first_name, u.last_name, u.id
        ORDER BY c.created_at DESC`,
        [req.user.id, school]
      );
    }
    res.json({ success: true, communities: r.rows });
  } catch(e) {
    console.error('[FORUM COMMUNITIES]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── POST /api/forum/communities/:id/join
router.post('/communities/:id/join', async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO community_members (community_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch(e) {
    console.error('[JOIN]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── DELETE /api/forum/communities/:id/leave
router.delete('/communities/:id/leave', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM community_members WHERE community_id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch(e) {
    console.error('[LEAVE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /api/forum/:communityId/posts
router.get('/:communityId/posts', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.id, p.content, p.created_at,
             u.first_name||' '||u.last_name AS author_name,
             u.role AS author_role,
             u.id AS author_id,
             COUNT(DISTINCT pl.user_id) AS likes,
             EXISTS(SELECT 1 FROM post_likes WHERE post_id=p.id AND user_id=$2) AS liked_by_me,
             COUNT(DISTINCT rep.id) AS reply_count
      FROM community_posts p
      JOIN users u ON p.author_id=u.id
      LEFT JOIN post_likes pl ON pl.post_id=p.id
      LEFT JOIN community_replies rep ON rep.post_id=p.id
      WHERE p.community_id=$1
      GROUP BY p.id, u.first_name, u.last_name, u.role, u.id
      ORDER BY p.created_at DESC`,
      [req.params.communityId, req.user.id]
    );
    res.json({ success: true, posts: r.rows });
  } catch(e) {
    console.error('[POSTS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── POST /api/forum/:communityId/posts
router.post('/:communityId/posts', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ success: false, message: 'Contenu requis.' });
    const r = await pool.query(
      'INSERT INTO community_posts (community_id, author_id, content) VALUES ($1,$2,$3) RETURNING *',
      [req.params.communityId, req.user.id, content.trim()]
    );
    res.status(201).json({ success: true, post: r.rows[0] });
  } catch(e) {
    console.error('[POST]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── DELETE /api/forum/posts/:id
router.delete('/posts/:id', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM community_posts WHERE id=$1 AND author_id=$2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch(e) {
    console.error('[DELETE POST]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── POST /api/forum/posts/:id/like
router.post('/posts/:id/like', async (req, res) => {
  try {
    const exists = await pool.query(
      'SELECT 1 FROM post_likes WHERE post_id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if (exists.rows.length) {
      await pool.query('DELETE FROM post_likes WHERE post_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
      // likes calculé dynamiquement depuis post_likes, pas besoin de UPDATE
      return res.json({ success: true, liked: false });
    }
    await pool.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1,$2)', [req.params.id, req.user.id]);
    // likes calculé dynamiquement depuis post_likes, pas besoin de UPDATE
    res.json({ success: true, liked: true });
  } catch(e) {
    console.error('[LIKE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /api/forum/posts/:id/replies
router.get('/posts/:id/replies', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT rep.id, rep.content, rep.created_at,
             u.first_name||' '||u.last_name AS author_name,
             u.role AS author_role, u.id AS author_id
      FROM community_replies rep
      JOIN users u ON rep.author_id=u.id
      WHERE rep.post_id=$1 ORDER BY rep.created_at ASC`,
      [req.params.id]
    );
    res.json({ success: true, replies: r.rows });
  } catch(e) {
    console.error('[REPLIES]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── POST /api/forum/posts/:id/replies
router.post('/posts/:id/replies', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ success: false, message: 'Contenu requis.' });
    const r = await pool.query(
      'INSERT INTO community_replies (post_id, author_id, content) VALUES ($1,$2,$3) RETURNING *',
      [req.params.id, req.user.id, content.trim()]
    );
    res.status(201).json({ success: true, reply: r.rows[0] });
  } catch(e) {
    console.error('[REPLY]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── DELETE /api/forum/replies/:id — supprimer une réponse
router.delete('/replies/:id', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM community_replies WHERE id=$1 AND author_id=$2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch(e) {
    console.error('[DELETE REPLY]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /api/forum/community/:id — info d'une communauté
router.get('/community/:id', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, u.first_name||' '||u.last_name AS teacher_name,
             COUNT(DISTINCT cm.user_id) AS member_count
      FROM communities c
      LEFT JOIN users u ON c.teacher_id=u.id
      LEFT JOIN community_members cm ON cm.community_id=c.id
      WHERE c.id=$1 GROUP BY c.id, u.first_name, u.last_name`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Communauté introuvable.' });
    res.json({ success: true, community: r.rows[0] });
  } catch(e) {
    console.error('[COMMUNITY INFO]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
