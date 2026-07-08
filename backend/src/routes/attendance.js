// src/routes/attendance.js
const express = require('express');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { calculateDistance } = require('../utils/geo');
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

// ═══════════════════════════════════════════
//  ÉTUDIANT — Auto-signalement de présence (geofencing)
// ═══════════════════════════════════════════

// GET /api/attendance/today-sessions — séances du jour pour mes cours inscrits
router.get('/today-sessions', async (req, res) => {
  if (req.user.role !== 'etudiant') {
    return res.status(403).json({ success: false, message: 'Réservé aux étudiants.' });
  }
  try {
    const r = await pool.query(`
      SELECT s.id, s.title, s.session_date, c.title AS course_title,
             ar.checkin_status, ar.checkin_distance_m, ar.status, ar.checkin_at
      FROM attendance_sessions s
      JOIN courses c ON s.course_id = c.id
      JOIN enrollments e ON e.course_id = c.id AND e.student_id = $1
      LEFT JOIN attendance_records ar ON ar.session_id = s.id AND ar.student_id = $1
      WHERE e.student_id = $1 AND s.session_date = CURRENT_DATE
      ORDER BY c.title
    `, [req.user.id]);
    res.json({ success: true, sessions: r.rows });
  } catch(e) {
    console.error('[TODAY SESSIONS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// POST /api/attendance/mark-present — signaler sa présence, vérifiée par géolocalisation.
// Le calcul de distance est toujours refait ici (jamais fait confiance au frontend).
router.post('/mark-present', async (req, res) => {
  if (req.user.role !== 'etudiant') {
    return res.status(403).json({ success: false, message: 'Réservé aux étudiants.' });
  }
  try {
    const { session_id, latitude, longitude, accuracy } = req.body;
    const lat = parseFloat(latitude), lng = parseFloat(longitude), acc = parseFloat(accuracy);
    if (!session_id || !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(acc)) {
      return res.status(400).json({ success: false, message: 'Coordonnées GPS manquantes ou invalides.' });
    }

    // La séance doit exister, être celle du jour, et l'étudiant doit être inscrit au cours.
    const sessionCheck = await pool.query(`
      SELECT s.id, s.course_id, c.school
      FROM attendance_sessions s
      JOIN courses c ON s.course_id = c.id
      JOIN enrollments e ON e.course_id = c.id AND e.student_id = $1
      WHERE s.id = $2 AND s.session_date = CURRENT_DATE
    `, [req.user.id, session_id]);
    if (!sessionCheck.rows.length) {
      return res.status(403).json({ success: false, message: "Séance introuvable, terminée, ou vous n'êtes pas inscrit à ce cours." });
    }
    const session = sessionCheck.rows[0];

    // Écrit (ou met à jour) la ligne de présence. Ne rétrograde jamais un statut déjà
    // validé (par le prof ou un check-in précédent réussi) à cause d'un essai raté,
    // mais garde toujours la trace géo la plus récente — utile pour le mémoire.
    const upsertCheckin = async (checkinStatus, distance, freshStatus) => {
      const existing = await pool.query(
        'SELECT id FROM attendance_records WHERE session_id=$1 AND student_id=$2',
        [session_id, req.user.id]
      );
      if (existing.rows.length) {
        return pool.query(
          `UPDATE attendance_records
           SET status = CASE WHEN $1='validated' THEN 'present' ELSE status END,
               checkin_status=$1, checkin_lat=$2, checkin_lng=$3,
               checkin_accuracy_m=$4, checkin_distance_m=$5, checkin_at=NOW()
           WHERE id=$6 RETURNING *`,
          [checkinStatus, lat, lng, acc, distance, existing.rows[0].id]
        );
      }
      return pool.query(
        `INSERT INTO attendance_records
           (session_id, student_id, status, checkin_status, checkin_lat, checkin_lng, checkin_accuracy_m, checkin_distance_m, checkin_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         RETURNING *`,
        [session_id, req.user.id, freshStatus, checkinStatus, lat, lng, acc, distance]
      );
    };

    // Geofencing — ignoré si l'école n'a pas encore configuré ses coordonnées GPS.
    // On calcule la distance tout de suite (même si la précision est mauvaise) car
    // c'est une information utile à afficher à l'étudiant dans les deux cas.
    const schoolRow = await pool.query(
      'SELECT latitude, longitude, geofence_radius_meters FROM schools WHERE school=$1',
      [session.school]
    );
    const school = schoolRow.rows[0];
    const geofenceConfigured = !!(school && school.latitude != null && school.longitude != null);
    const radius = geofenceConfigured ? school.geofence_radius_meters : null;
    const distance = geofenceConfigured ? calculateDistance(lat, lng, school.latitude, school.longitude) : null;

    const commonInfo = {
      accuracy: Math.round(acc),
      distance: distance != null ? Math.round(distance) : null,
      radius,
      geofenceConfigured,
      checkedAt: new Date().toISOString(),
      yourPosition: { latitude: lat, longitude: lng },
    };

    // Précision GPS insuffisante → on enregistre quand même la tentative, mais on rejette.
    if (acc > 100) {
      await upsertCheckin('rejected_low_accuracy', distance, 'absent');
      return res.status(400).json({
        success: false,
        reason: 'low_accuracy',
        ...commonInfo,
        message: `Précision GPS insuffisante (${Math.round(acc)}m, il faut 100m ou moins). Sortez à l'extérieur, loin des bâtiments, et réessayez.`,
      });
    }

    if (geofenceConfigured && distance > radius) {
      await upsertCheckin('rejected_out_of_zone', distance, 'absent');
      return res.status(403).json({
        success: false,
        reason: 'out_of_zone',
        ...commonInfo,
        message: `Vous êtes à ${Math.round(distance)}m de votre établissement (rayon autorisé : ${radius}m). Rapprochez-vous et réessayez.`,
      });
    }

    const r = await upsertCheckin('validated', distance, 'present');
    res.json({
      success: true,
      status: 'present',
      ...commonInfo,
      record: r.rows[0],
    });
  } catch(e) {
    console.error('[MARK PRESENT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
