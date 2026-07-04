// src/routes/attendance.js
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
//  ENSEIGNANT — Séances de présence
// ═══════════════════════════════════════════

// POST /api/attendance/sessions — créer une séance et marquer les présences
router.post('/sessions', teacherOnly, async (req, res) => {
  try {
    const { course_id, session_date, title, records } = req.body;
    if (!course_id) return res.status(400).json({ success: false, message: 'Cours requis.' });

    const check = await pool.query('SELECT id FROM courses WHERE id=$1 AND teacher_id=$2', [course_id, req.user.id]);
    if (!check.rows.length) return res.status(403).json({ success: false, message: 'Cours introuvable.' });

    const session = await pool.query(
      `INSERT INTO attendance_sessions (course_id, teacher_id, title, session_date)
       VALUES ($1,$2,$3,COALESCE($4, CURRENT_DATE)) RETURNING *`,
      [course_id, req.user.id, title||null, session_date||null]
    );
    const sessionId = session.rows[0].id;

    if (Array.isArray(records)) {
      for (const rec of records) {
        await pool.query(
          `INSERT INTO attendance_records (session_id, student_id, status, note)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (session_id, student_id) DO UPDATE SET status=$3, note=$4`,
          [sessionId, rec.student_id, rec.status||'present', rec.note||null]
        );
      }
    }
    res.status(201).json({ success: true, session: session.rows[0] });
  } catch(e) {
    console.error('[ATTENDANCE CREATE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// PUT /api/attendance/sessions/:id — modifier une séance existante
router.put('/sessions/:id', teacherOnly, async (req, res) => {
  try {
    const { records, title, session_date } = req.body;
    const check = await pool.query(
      `SELECT id FROM attendance_sessions WHERE id=$1 AND teacher_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!check.rows.length) return res.status(404).json({ success: false, message: 'Séance introuvable.' });

    if (title !== undefined || session_date !== undefined) {
      await pool.query(
        `UPDATE attendance_sessions SET title=COALESCE($1,title), session_date=COALESCE($2,session_date) WHERE id=$3`,
        [title||null, session_date||null, req.params.id]
      );
    }
    if (Array.isArray(records)) {
      for (const rec of records) {
        await pool.query(
          `INSERT INTO attendance_records (session_id, student_id, status, note)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (session_id, student_id) DO UPDATE SET status=$3, note=$4`,
          [req.params.id, rec.student_id, rec.status||'present', rec.note||null]
        );
      }
    }
    res.json({ success: true });
  } catch(e) {
    console.error('[ATTENDANCE UPDATE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// GET /api/attendance/sessions/course/:courseId — historique des séances d'un cours
router.get('/sessions/course/:courseId', teacherOnly, async (req, res) => {
  try {
    const check = await pool.query('SELECT id FROM courses WHERE id=$1 AND teacher_id=$2', [req.params.courseId, req.user.id]);
    if (!check.rows.length) return res.status(403).json({ success: false, message: 'Cours introuvable.' });

    const r = await pool.query(`
      SELECT s.id, s.title, s.session_date, s.created_at,
             COUNT(ar.id) FILTER (WHERE ar.status='present') AS present_count,
             COUNT(ar.id) FILTER (WHERE ar.status='absent')  AS absent_count,
             COUNT(ar.id) FILTER (WHERE ar.status='late')    AS late_count,
             COUNT(ar.id) FILTER (WHERE ar.status='excused') AS excused_count
      FROM attendance_sessions s
      LEFT JOIN attendance_records ar ON ar.session_id=s.id
      WHERE s.course_id=$1
      GROUP BY s.id
      ORDER BY s.session_date DESC, s.created_at DESC
    `, [req.params.courseId]);
    res.json({ success: true, sessions: r.rows });
  } catch(e) {
    console.error('[ATTENDANCE SESSIONS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// GET /api/attendance/sessions/:id — détail d'une séance (roster complet du cours)
router.get('/sessions/:id', teacherOnly, async (req, res) => {
  try {
    const session = await pool.query(
      `SELECT s.*, c.title AS course_title FROM attendance_sessions s
       JOIN courses c ON s.course_id=c.id
       WHERE s.id=$1 AND s.teacher_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!session.rows.length) return res.status(404).json({ success: false, message: 'Séance introuvable.' });

    const students = await pool.query(`
      SELECT u.id AS student_id, u.first_name, u.last_name,
             COALESCE(ar.status, 'present') AS status, ar.note
      FROM enrollments e
      JOIN users u ON e.student_id=u.id
      LEFT JOIN attendance_records ar ON ar.session_id=$1 AND ar.student_id=u.id
      WHERE e.course_id=$2
      ORDER BY u.last_name, u.first_name
    `, [req.params.id, session.rows[0].course_id]);

    res.json({ success: true, session: session.rows[0], students: students.rows });
  } catch(e) {
    console.error('[ATTENDANCE SESSION DETAIL]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// DELETE /api/attendance/sessions/:id
router.delete('/sessions/:id', teacherOnly, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM attendance_sessions WHERE id=$1 AND teacher_id=$2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Séance introuvable.' });
    res.json({ success: true });
  } catch(e) {
    console.error('[ATTENDANCE DELETE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// GET /api/attendance/course/:courseId/stats — taux de présence par étudiant
router.get('/course/:courseId/stats', teacherOnly, async (req, res) => {
  try {
    const check = await pool.query('SELECT id FROM courses WHERE id=$1 AND teacher_id=$2', [req.params.courseId, req.user.id]);
    if (!check.rows.length) return res.status(403).json({ success: false, message: 'Cours introuvable.' });

    const r = await pool.query(`
      SELECT u.id, u.first_name, u.last_name,
             COUNT(ar.id) FILTER (WHERE ar.status='present') AS present,
             COUNT(ar.id) FILTER (WHERE ar.status='absent')  AS absent,
             COUNT(ar.id) FILTER (WHERE ar.status='late')    AS late,
             COUNT(ar.id) FILTER (WHERE ar.status='excused') AS excused,
             (SELECT COUNT(*) FROM attendance_sessions WHERE course_id=$1) AS total_sessions
      FROM enrollments e
      JOIN users u ON e.student_id=u.id
      LEFT JOIN attendance_sessions s ON s.course_id=$1
      LEFT JOIN attendance_records ar ON ar.session_id=s.id AND ar.student_id=u.id
      WHERE e.course_id=$1
      GROUP BY u.id
      ORDER BY u.last_name, u.first_name
    `, [req.params.courseId]);
    res.json({ success: true, stats: r.rows });
  } catch(e) {
    console.error('[ATTENDANCE STATS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  ÉTUDIANT — Mes présences
// ═══════════════════════════════════════════

// GET /api/attendance/me — taux de présence par cours inscrit
router.get('/me', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.id AS course_id, c.title AS course_title,
             COUNT(ar.id) FILTER (WHERE ar.status='present') AS present,
             COUNT(ar.id) FILTER (WHERE ar.status='absent')  AS absent,
             COUNT(ar.id) FILTER (WHERE ar.status='late')    AS late,
             COUNT(ar.id) FILTER (WHERE ar.status='excused') AS excused,
             (SELECT COUNT(*) FROM attendance_sessions WHERE course_id=c.id) AS total_sessions
      FROM enrollments e
      JOIN courses c ON e.course_id=c.id
      LEFT JOIN attendance_sessions s ON s.course_id=c.id
      LEFT JOIN attendance_records ar ON ar.session_id=s.id AND ar.student_id=$1
      WHERE e.student_id=$1
      GROUP BY c.id
      ORDER BY c.title
    `, [req.user.id]);
    res.json({ success: true, attendance: r.rows });
  } catch(e) {
    console.error('[STUDENT ATTENDANCE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// GET /api/attendance/me/course/:courseId — historique détaillé pour un cours
router.get('/me/course/:courseId', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.id, s.title, s.session_date,
             COALESCE(ar.status, 'present') AS status, ar.note
      FROM attendance_sessions s
      LEFT JOIN attendance_records ar ON ar.session_id=s.id AND ar.student_id=$1
      WHERE s.course_id=$2
      ORDER BY s.session_date DESC
    `, [req.user.id, req.params.courseId]);
    res.json({ success: true, history: r.rows });
  } catch(e) {
    console.error('[STUDENT ATTENDANCE COURSE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
