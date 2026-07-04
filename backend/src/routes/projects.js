// src/routes/projects.js
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
//  ENSEIGNANT — Projets académiques
// ═══════════════════════════════════════════
router.post('/', teacherOnly, async (req, res) => {
  try {
    const { title, description, course_id, deadline, file_url } = req.body;
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Titre requis.' });

    let filiere = null, school = null;
    if (course_id) {
      const c = await pool.query('SELECT filiere, school FROM courses WHERE id=$1 AND teacher_id=$2', [course_id, req.user.id]);
      if (!c.rows.length) return res.status(403).json({ success: false, message: 'Cours introuvable.' });
      filiere = c.rows[0].filiere; school = c.rows[0].school;
    } else {
      const u = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
      school = u.rows[0]?.school || null;
    }

    const r = await pool.query(
      `INSERT INTO projects (title, description, course_id, teacher_id, school, filiere, deadline, file_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [title.trim(), description||null, course_id||null, req.user.id, school, filiere, deadline||null, file_url||null]
    );
    res.status(201).json({ success: true, project: r.rows[0] });
  } catch(e) {
    console.error('[PROJECT POST]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.get('/teacher', teacherOnly, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*, c.title AS course_title,
             COUNT(ps.id) AS submission_count,
             COUNT(ps.id) FILTER (WHERE ps.grade IS NOT NULL) AS graded_count
      FROM projects p
      LEFT JOIN courses c ON p.course_id=c.id
      LEFT JOIN project_submissions ps ON ps.project_id=p.id
      WHERE p.teacher_id=$1
      GROUP BY p.id, c.title
      ORDER BY p.created_at DESC
    `, [req.user.id]);
    res.json({ success: true, projects: r.rows });
  } catch(e) {
    console.error('[PROJECTS TEACHER]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.put('/:id', teacherOnly, async (req, res) => {
  try {
    const { title, description, deadline, file_url, status } = req.body;
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Titre requis.' });
    const r = await pool.query(
      `UPDATE projects SET title=$1, description=$2, deadline=$3, file_url=COALESCE($4,file_url), status=COALESCE($5,status)
       WHERE id=$6 AND teacher_id=$7 RETURNING *`,
      [title.trim(), description||null, deadline||null, file_url||null, status||null, req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Projet introuvable.' });
    res.json({ success: true, project: r.rows[0] });
  } catch(e) {
    console.error('[PROJECT PUT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.delete('/:id', teacherOnly, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM projects WHERE id=$1 AND teacher_id=$2 RETURNING id', [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Projet introuvable.' });
    res.json({ success: true });
  } catch(e) {
    console.error('[PROJECT DELETE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.get('/:id/submissions', teacherOnly, async (req, res) => {
  try {
    const check = await pool.query('SELECT id FROM projects WHERE id=$1 AND teacher_id=$2', [req.params.id, req.user.id]);
    if (!check.rows.length) return res.status(403).json({ success: false, message: 'Projet introuvable.' });
    const r = await pool.query(`
      SELECT ps.*, u.first_name||' '||u.last_name AS student_name, u.email AS student_email
      FROM project_submissions ps
      JOIN users u ON ps.student_id=u.id
      WHERE ps.project_id=$1
      ORDER BY ps.submitted_at DESC
    `, [req.params.id]);
    res.json({ success: true, submissions: r.rows });
  } catch(e) {
    console.error('[PROJECT SUBMISSIONS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.put('/submissions/:id/grade', teacherOnly, async (req, res) => {
  try {
    const { grade, feedback } = req.body;
    if (grade === undefined || isNaN(grade) || grade < 0 || grade > 20) {
      return res.status(400).json({ success: false, message: 'Note entre 0 et 20.' });
    }
    const r = await pool.query(
      `UPDATE project_submissions SET grade=$1, feedback=$2, graded_at=NOW()
       WHERE id=$3 RETURNING id, grade, feedback`,
      [parseFloat(grade), feedback||null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Soumission introuvable.' });
    res.json({ success: true, submission: r.rows[0] });
  } catch(e) {
    console.error('[PROJECT GRADE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  ÉTUDIANT — Mes projets
// ═══════════════════════════════════════════
router.get('/student', async (req, res) => {
  try {
    const me = await pool.query('SELECT school, filiere FROM users WHERE id=$1', [req.user.id]);
    const { school, filiere } = me.rows[0] || {};
    const filiereShort = filiere ? filiere.split(' — ')[0].trim() : null;

    const r = await pool.query(`
      SELECT p.id, p.title, p.description, p.deadline, p.file_url, p.status, p.created_at,
             c.title AS course_title,
             u.first_name||' '||u.last_name AS teacher_name,
             ps.id AS submission_id, ps.team_name, ps.grade, ps.feedback, ps.submitted_at
      FROM projects p
      LEFT JOIN courses c ON p.course_id=c.id
      LEFT JOIN users u ON p.teacher_id=u.id
      LEFT JOIN project_submissions ps ON ps.project_id=p.id AND ps.student_id=$1
      WHERE p.school = $2::text
        AND (
          p.filiere IS NULL OR p.filiere=''
          OR p.filiere = $3::text
          OR SPLIT_PART(p.filiere, ' — ', 1) = $4::text
        )
      ORDER BY p.deadline ASC NULLS LAST, p.created_at DESC
    `, [req.user.id, school||null, filiere||null, filiereShort||null]);

    res.json({ success: true, projects: r.rows });
  } catch(e) {
    console.error('[PROJECTS STUDENT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.post('/:id/submit', async (req, res) => {
  try {
    const { content, file_url, team_name } = req.body;
    if (!content?.trim() && !file_url) {
      return res.status(400).json({ success: false, message: 'Contenu ou fichier requis.' });
    }
    const check = await pool.query('SELECT id FROM projects WHERE id=$1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ success: false, message: 'Projet introuvable.' });

    const r = await pool.query(
      `INSERT INTO project_submissions (project_id, student_id, team_name, content, file_url)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (project_id, student_id) DO UPDATE
         SET team_name=$3, content=$4, file_url=$5, submitted_at=NOW()
       RETURNING *`,
      [req.params.id, req.user.id, team_name||null, content?.trim()||null, file_url||null]
    );
    res.json({ success: true, submission: r.rows[0] });
  } catch(e) {
    console.error('[PROJECT SUBMIT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
