// src/routes/schedule.js
// Emploi du temps — séances récurrentes hebdomadaires par cours
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

const DAYS = [0,1,2,3,4,5,6]; // 0=Lundi ... 6=Dimanche

// ═══════════════════════════════════════════
//  ENSEIGNANT — Gérer ses créneaux
// ═══════════════════════════════════════════
router.post('/', teacherOnly, async (req, res) => {
  try {
    const { course_id, day_of_week, start_time, end_time, room } = req.body;
    if (course_id === undefined || day_of_week === undefined || !start_time || !end_time) {
      return res.status(400).json({ success: false, message: 'Cours, jour et horaires requis.' });
    }
    if (!DAYS.includes(parseInt(day_of_week))) {
      return res.status(400).json({ success: false, message: 'Jour invalide.' });
    }
    if (start_time >= end_time) {
      return res.status(400).json({ success: false, message: 'L\'heure de fin doit suivre l\'heure de début.' });
    }

    const c = await pool.query('SELECT filiere, school FROM courses WHERE id=$1 AND teacher_id=$2', [course_id, req.user.id]);
    if (!c.rows.length) return res.status(403).json({ success: false, message: 'Cours introuvable.' });

    const r = await pool.query(
      `INSERT INTO schedule_slots (course_id, teacher_id, day_of_week, start_time, end_time, room, school, filiere)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [course_id, req.user.id, parseInt(day_of_week), start_time, end_time, room||null, c.rows[0].school, c.rows[0].filiere]
    );
    res.status(201).json({ success: true, slot: r.rows[0] });
  } catch(e) {
    console.error('[SCHEDULE POST]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.get('/teacher', teacherOnly, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*, c.title AS course_title
      FROM schedule_slots s
      JOIN courses c ON s.course_id=c.id
      WHERE s.teacher_id=$1
      ORDER BY s.day_of_week ASC, s.start_time ASC
    `, [req.user.id]);
    res.json({ success: true, slots: r.rows });
  } catch(e) {
    console.error('[SCHEDULE TEACHER]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.put('/:id', teacherOnly, async (req, res) => {
  try {
    const { day_of_week, start_time, end_time, room } = req.body;
    if (day_of_week === undefined || !start_time || !end_time) {
      return res.status(400).json({ success: false, message: 'Jour et horaires requis.' });
    }
    if (start_time >= end_time) {
      return res.status(400).json({ success: false, message: 'L\'heure de fin doit suivre l\'heure de début.' });
    }
    const r = await pool.query(
      `UPDATE schedule_slots SET day_of_week=$1, start_time=$2, end_time=$3, room=$4
       WHERE id=$5 AND teacher_id=$6 RETURNING *`,
      [parseInt(day_of_week), start_time, end_time, room||null, req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Créneau introuvable.' });
    res.json({ success: true, slot: r.rows[0] });
  } catch(e) {
    console.error('[SCHEDULE PUT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.delete('/:id', teacherOnly, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM schedule_slots WHERE id=$1 AND teacher_id=$2 RETURNING id', [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Créneau introuvable.' });
    res.json({ success: true });
  } catch(e) {
    console.error('[SCHEDULE DELETE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  ÉTUDIANT — Mon emploi du temps
// ═══════════════════════════════════════════
router.get('/student', async (req, res) => {
  try {
    const me = await pool.query('SELECT school, filiere FROM users WHERE id=$1', [req.user.id]);
    const { school, filiere } = me.rows[0] || {};
    const filiereShort = filiere ? filiere.split(' — ')[0].trim() : null;

    const r = await pool.query(`
      SELECT s.id, s.day_of_week, s.start_time, s.end_time, s.room,
             c.title AS course_title,
             u.first_name||' '||u.last_name AS teacher_name
      FROM schedule_slots s
      JOIN courses c ON s.course_id=c.id
      LEFT JOIN users u ON s.teacher_id=u.id
      WHERE s.school = $1::text
        AND (
          s.filiere IS NULL OR s.filiere=''
          OR s.filiere = $2::text
          OR SPLIT_PART(s.filiere, ' — ', 1) = $3::text
        )
      ORDER BY s.day_of_week ASC, s.start_time ASC
    `, [school||null, filiere||null, filiereShort||null]);

    res.json({ success: true, slots: r.rows });
  } catch(e) {
    console.error('[SCHEDULE STUDENT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  ADMIN — Vue d'ensemble de l'école
// ═══════════════════════════════════════════
router.get('/admin', teacherOnly, async (req, res) => {
  try {
    const u = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const r = await pool.query(`
      SELECT s.*, c.title AS course_title, t.first_name||' '||t.last_name AS teacher_name
      FROM schedule_slots s
      JOIN courses c ON s.course_id=c.id
      LEFT JOIN users t ON s.teacher_id=t.id
      WHERE s.school=$1
      ORDER BY s.day_of_week ASC, s.start_time ASC
    `, [u.rows[0]?.school || null]);
    res.json({ success: true, slots: r.rows });
  } catch(e) {
    console.error('[SCHEDULE ADMIN]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
