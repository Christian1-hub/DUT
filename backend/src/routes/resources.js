// src/routes/resources.js
// Bibliothèque de ressources — documents/liens partagés par filière/cours
const express = require('express');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

router.use(auth);

const teacherOnly = (req, res, next) => {
  if (req.user.role !== 'enseignant' && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Accès réservé aux enseignants.' });
  }
  next();
};

// ═══════════════════════════════════════════
//  ENSEIGNANT / ADMIN — Publier une ressource
// ═══════════════════════════════════════════
router.post('/', teacherOnly, async (req, res) => {
  try {
    const { title, description, category, file_url, link_url, course_id } = req.body;
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Titre requis.' });
    if (!file_url && !link_url?.trim()) {
      return res.status(400).json({ success: false, message: 'Fichier ou lien requis.' });
    }

    let filiere = null, school = null;
    if (course_id) {
      const c = await pool.query('SELECT filiere, school FROM courses WHERE id=$1 AND teacher_id=$2', [course_id, req.user.id]);
      if (!c.rows.length) return res.status(403).json({ success: false, message: 'Cours introuvable.' });
      filiere = c.rows[0].filiere; school = c.rows[0].school;
    } else {
      const u = await pool.query('SELECT school, filiere FROM users WHERE id=$1', [req.user.id]);
      school = u.rows[0]?.school || null;
      filiere = u.rows[0]?.filiere || null;
    }

    const r = await pool.query(
      `INSERT INTO resources (title, description, category, file_url, link_url, course_id, teacher_id, school, filiere)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [title.trim(), description||null, category||'autre', file_url||null, link_url?.trim()||null, course_id||null, req.user.id, school, filiere]
    );
    res.status(201).json({ success: true, resource: r.rows[0] });
  } catch(e) {
    console.error('[RESOURCE POST]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.get('/teacher', teacherOnly, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT res.*, c.title AS course_title
      FROM resources res
      LEFT JOIN courses c ON res.course_id=c.id
      WHERE res.teacher_id=$1
      ORDER BY res.created_at DESC
    `, [req.user.id]);
    res.json({ success: true, resources: r.rows });
  } catch(e) {
    console.error('[RESOURCES TEACHER]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.put('/:id', teacherOnly, async (req, res) => {
  try {
    const { title, description, category, file_url, link_url } = req.body;
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Titre requis.' });
    const r = await pool.query(
      `UPDATE resources SET title=$1, description=$2, category=$3, file_url=COALESCE($4,file_url), link_url=COALESCE($5,link_url)
       WHERE id=$6 AND teacher_id=$7 RETURNING *`,
      [title.trim(), description||null, category||'autre', file_url||null, link_url?.trim()||null, req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Ressource introuvable.' });
    res.json({ success: true, resource: r.rows[0] });
  } catch(e) {
    console.error('[RESOURCE PUT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.delete('/:id', teacherOnly, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM resources WHERE id=$1 AND teacher_id=$2 RETURNING id', [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Ressource introuvable.' });
    res.json({ success: true });
  } catch(e) {
    console.error('[RESOURCE DELETE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  ÉTUDIANT — Consulter la bibliothèque
// ═══════════════════════════════════════════
router.get('/student', async (req, res) => {
  try {
    const me = await pool.query('SELECT school, filiere FROM users WHERE id=$1', [req.user.id]);
    const { school, filiere } = me.rows[0] || {};
    const filiereShort = filiere ? filiere.split(' — ')[0].trim() : null;

    const r = await pool.query(`
      SELECT res.id, res.title, res.description, res.category, res.file_url, res.link_url,
             res.downloads_count, res.created_at,
             c.title AS course_title,
             u.first_name||' '||u.last_name AS teacher_name
      FROM resources res
      LEFT JOIN courses c ON res.course_id=c.id
      LEFT JOIN users u ON res.teacher_id=u.id
      WHERE res.school = $1::text
        AND (
          res.filiere IS NULL OR res.filiere=''
          OR res.filiere = $2::text
          OR SPLIT_PART(res.filiere, ' — ', 1) = $3::text
        )
      ORDER BY res.created_at DESC
    `, [school||null, filiere||null, filiereShort||null]);

    res.json({ success: true, resources: r.rows });
  } catch(e) {
    console.error('[RESOURCES STUDENT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.post('/:id/download', async (req, res) => {
  try {
    const r = await pool.query('UPDATE resources SET downloads_count = downloads_count + 1 WHERE id=$1 RETURNING file_url, link_url', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Ressource introuvable.' });
    res.json({ success: true, url: r.rows[0].file_url || r.rows[0].link_url });
  } catch(e) {
    console.error('[RESOURCE DOWNLOAD]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  ADMIN — Vue d'ensemble
// ═══════════════════════════════════════════
router.get('/admin', teacherOnly, async (req, res) => {
  try {
    const u = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const school = u.rows[0]?.school || null;
    const r = await pool.query(`
      SELECT res.*, u.first_name||' '||u.last_name AS teacher_name
      FROM resources res
      LEFT JOIN users u ON res.teacher_id=u.id
      WHERE res.school=$1
      ORDER BY res.created_at DESC
    `, [school]);
    res.json({ success: true, resources: r.rows });
  } catch(e) {
    console.error('[RESOURCES ADMIN]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
