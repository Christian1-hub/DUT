// src/routes/teacher.js
const express = require('express');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

// Auth + rôle enseignant sur toutes les routes
router.use(auth);
router.use((req, res, next) => {
  if (req.user.role !== 'enseignant' && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Accès réservé aux enseignants.' });
  }
  next();
});

// ═══════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════
router.get('/dashboard', async (req, res) => {
  try {
    const id = req.user.id;

    const user = await pool.query(
      'SELECT id, first_name, last_name, email, school, filiere, bio, created_at FROM users WHERE id = $1',
      [id]
    );
    const stats = await Promise.all([
      pool.query('SELECT COUNT(*) FROM classes WHERE teacher_id=$1', [id]),
      pool.query('SELECT COUNT(*) FROM courses WHERE teacher_id=$1', [id]),
      pool.query(`SELECT COUNT(DISTINCT cm.student_id) FROM class_members cm JOIN classes cl ON cm.class_id=cl.id WHERE cl.teacher_id=$1`, [id]),
      pool.query(`SELECT COUNT(*) FROM assignment_submissions sub JOIN assignments a ON sub.assignment_id=a.id JOIN courses c ON a.course_id=c.id WHERE c.teacher_id=$1 AND sub.score IS NULL`, [id]),
    ]);

    const recent = await pool.query(
      `SELECT sub.id, sub.submitted_at, sub.grade,
              u.first_name||' '||u.last_name AS student_name,
              a.title AS assignment_title, c.title AS course_title
       FROM assignment_submissions sub
       JOIN users u       ON sub.student_id    = u.id
       JOIN assignments a ON sub.assignment_id = a.id
       JOIN courses c     ON a.course_id       = c.id
       WHERE c.teacher_id = $1
       ORDER BY sub.submitted_at DESC LIMIT 6`,
      [id]
    );

    res.json({
      success: true,
      user: user.rows[0],
      stats: {
        classes:  parseInt(stats[0].rows[0].count),
        courses:  parseInt(stats[1].rows[0].count),
        students: parseInt(stats[2].rows[0].count),
        toGrade:  parseInt(stats[3].rows[0].count),
      },
      recentActivity: recent.rows,
    });
  } catch(e) {
    console.error('[DASHBOARD]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  PROFIL
// ═══════════════════════════════════════════
router.get('/profile', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, first_name, last_name, email, school, filiere, bio, created_at FROM users WHERE id=$1',
      [req.user.id]
    );
    res.json({ success: true, user: r.rows[0] });
  } catch(e) {
    console.error('[PROFILE GET]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.put('/profile', async (req, res) => {
  try {
    const { first_name, last_name, discipline, filiere, bio, phone } = req.body;
    if (!first_name?.trim() || !last_name?.trim()) {
      return res.status(400).json({ success: false, message: 'Prénom et nom requis.' });
    }
    const r = await pool.query(
      `UPDATE users SET first_name=$1, last_name=$2, discipline=$3, filiere=$4, bio=$5, phone=$6
       WHERE id=$7 RETURNING id, first_name, last_name, email, school, discipline, filiere, bio, phone, created_at`,
      [first_name.trim(), last_name.trim(), discipline||null, filiere||null, bio||null, phone||null, req.user.id]
    );
    res.json({ success: true, user: r.rows[0] });
  } catch(e) {
    console.error('[PROFILE PUT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  CLASSES
// ═══════════════════════════════════════════
router.get('/classes', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT cl.*, COUNT(cm.student_id) AS student_count
       FROM classes cl
       LEFT JOIN class_members cm ON cm.class_id=cl.id
       WHERE cl.teacher_id=$1
       GROUP BY cl.id ORDER BY cl.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, classes: r.rows });
  } catch(e) {
    console.error('[CLASSES GET]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.post('/classes', async (req, res) => {
  try {
    const { name, filiere, level, description, academic_year } = req.body;
    if (!name?.trim() || !filiere?.trim()) {
      return res.status(400).json({ success: false, message: 'Nom et filière requis.' });
    }
    const u = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const school = u.rows[0]?.school || 'Non défini';
    const r = await pool.query(
      `INSERT INTO classes (name, filiere, level, description, academic_year, school, teacher_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name.trim(), filiere||null, level||null, description||null, academic_year||null, school, req.user.id]
    );
    const classId = r.rows[0].id;

    // Rattacher automatiquement les étudiants déjà inscrits sur cette école/filière
    // (le prof peut créer la classe APRÈS que des étudiants se soient déjà inscrits)
    const filiereShort = filiere.split(' — ')[0].trim();
    await pool.query(
      `INSERT INTO class_members (class_id, student_id)
       SELECT $1, u.id FROM users u
       WHERE u.role='etudiant' AND u.school=$2
         AND (u.filiere=$3 OR SPLIT_PART(u.filiere, ' — ', 1) = $4)
       ON CONFLICT DO NOTHING`,
      [classId, school, filiere.trim(), filiereShort]
    );

    // Inscrire aussi ces étudiants aux cours déjà liés à cette classe (normalement aucun à la création,
    // mais garde la cohérence si des cours existaient déjà pour cette filière sans classe associée)
    await pool.query(
      `INSERT INTO enrollments (student_id, course_id)
       SELECT cm.student_id, c.id FROM class_members cm
       JOIN courses c ON c.class_id=$1
       WHERE cm.class_id=$1
       ON CONFLICT DO NOTHING`,
      [classId]
    );

    res.status(201).json({ success: true, class: r.rows[0] });
  } catch(e) {
    console.error('[CLASS POST]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.delete('/classes/:id', async (req, res) => {
  try {
    const r = await pool.query(
      'DELETE FROM classes WHERE id=$1 AND teacher_id=$2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Classe introuvable.' });
    res.json({ success: true });
  } catch(e) {
    console.error('[CLASS DELETE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.get('/classes/:id/students', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, cm.joined_at
       FROM class_members cm
       JOIN users u       ON cm.student_id = u.id
       JOIN classes cl    ON cm.class_id   = cl.id
       WHERE cm.class_id=$1 AND cl.teacher_id=$2
       ORDER BY u.last_name`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true, students: r.rows });
  } catch(e) {
    console.error('[CLASS STUDENTS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  COURS
// ═══════════════════════════════════════════
router.get('/courses', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id, c.title, c.description, c.filiere,
              COALESCE(c.color, 'orange') AS color,
              c.file_url,
              c.class_id,
              c.created_at,
              cl.name AS class_name,
              cl.level AS class_level,
              COUNT(DISTINCT e.student_id) AS student_count,
              COUNT(DISTINCT a.id)         AS assignment_count
       FROM courses c
       LEFT JOIN classes cl     ON cl.id = c.class_id
       LEFT JOIN enrollments e  ON e.course_id = c.id
       LEFT JOIN assignments a  ON a.course_id = c.id
       WHERE c.teacher_id=$1
       GROUP BY c.id, cl.name, cl.level
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, courses: r.rows });
  } catch(e) {
    console.error('[COURSES GET]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.post('/courses', async (req, res) => {
  try {
    const { title, description, filiere, color, class_id, file_url } = req.body;
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Titre requis.' });
    const u = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const school = u.rows[0]?.school || null;
    const r = await pool.query(
      `INSERT INTO courses (title, description, filiere, teacher_id, school, file_url, color)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title.trim(), description||null, filiere||null, req.user.id, school, file_url||null, color||'orange']
    );
    const courseId = r.rows[0].id;

    if (class_id) {
      // Inscrire les étudiants de la classe liée
      await pool.query(
        `INSERT INTO enrollments (student_id, course_id)
         SELECT student_id, $1 FROM class_members WHERE class_id=$2
         ON CONFLICT DO NOTHING`,
        [courseId, class_id]
      );
      console.log(`[COURSE] Étudiants de la classe ${class_id} inscrits au cours "${title}"`);
    }

    if (filiere && school) {
      // Inscrire AUSSI tous les étudiants de l'école avec cette filière
      // (même ceux qui ne sont pas dans une classe explicite)
      // Comparaison souple : correspondance exacte OU même code court avant le " — "
      // (le champ filière du cours est saisi librement par le prof, celui de l'étudiant
      // vient d'une liste fixe, donc les deux chaînes ne matchent pas toujours au caractère près)
      const filiereShort = filiere.split(' — ')[0].trim();
      await pool.query(
        `INSERT INTO enrollments (student_id, course_id)
         SELECT u.id, $1 FROM users u
         WHERE u.role='etudiant'
           AND u.school=$2
           AND (u.filiere=$3 OR SPLIT_PART(u.filiere, ' — ', 1) = $4 OR SPLIT_PART(u.filiere, ' ', 1) = $4)
           AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id=u.id AND e.course_id=$1)
         ON CONFLICT DO NOTHING`,
        [courseId, school, filiere, filiereShort]
      );
      console.log(`[COURSE] Étudiants filière ${filiere} de ${school} inscrits au cours "${title}"`);
    }

    res.status(201).json({ success: true, course: r.rows[0] });
  } catch(e) {
    console.error('[COURSE POST]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.put('/courses/:id', async (req, res) => {
  try {
    const { title, description, filiere, color, file_url } = req.body;
    console.log('[COURSE PUT] file_url recu:', file_url, 'color:', color);
    const r = await pool.query(
      `UPDATE courses SET title=$1, description=$2, filiere=$3, color=$4, file_url=COALESCE($5, file_url)
       WHERE id=$6 AND teacher_id=$7 RETURNING *`,
      [title, description||null, filiere||null, color||'orange', file_url||null, req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Cours introuvable.' });

    // Rejouer l'auto-inscription (utile pour rattraper des étudiants inscrits
    // après la création du cours, ou si la filière a été corrigée)
    if (filiere && r.rows[0].school) {
      const filiereShort = filiere.split(' — ')[0].trim();
      await pool.query(
        `INSERT INTO enrollments (student_id, course_id)
         SELECT u.id, $1 FROM users u
         WHERE u.role='etudiant' AND u.school=$2
           AND (u.filiere=$3 OR SPLIT_PART(u.filiere, ' — ', 1) = $4 OR SPLIT_PART(u.filiere, ' ', 1) = $4)
           AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id=u.id AND e.course_id=$1)
         ON CONFLICT DO NOTHING`,
        [req.params.id, r.rows[0].school, filiere, filiereShort]
      );
    }

    res.json({ success: true, course: r.rows[0] });
  } catch(e) {
    console.error('[COURSE PUT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.delete('/courses/:id', async (req, res) => {
  try {
    const r = await pool.query(
      'DELETE FROM courses WHERE id=$1 AND teacher_id=$2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Cours introuvable.' });
    res.json({ success: true });
  } catch(e) {
    console.error('[COURSE DELETE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  DEVOIRS & QUIZ
// ═══════════════════════════════════════════
router.get('/assignments', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.id, a.title, a.due_date, a.status, false AS is_quiz, a.file_url, NULL AS instructions, a.created_at,
              c.title AS course_title, c.filiere, c.class_id,
              cl.name AS class_name,
              COUNT(DISTINCT e.student_id)                                            AS total_students,
              COUNT(DISTINCT sub.id)                                                   AS submissions_count,
              COUNT(DISTINCT CASE WHEN sub.score IS NULL THEN sub.id END)              AS to_grade
       FROM assignments a
       JOIN courses c        ON a.course_id = c.id
       LEFT JOIN classes cl  ON c.class_id  = cl.id
       LEFT JOIN enrollments e ON e.course_id = c.id
       LEFT JOIN assignment_submissions sub ON sub.assignment_id = a.id
       WHERE c.teacher_id=$1
       GROUP BY a.id, c.title, c.filiere, c.class_id, cl.name
       ORDER BY a.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, assignments: r.rows });
  } catch(e) {
    console.error('[ASSIGNMENTS GET]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.post('/assignments', async (req, res) => {
  try {
    const { title, course_id, due_date, instructions, is_quiz, quiz_data, file_url } = req.body;
    if (!title?.trim() || !course_id) {
      return res.status(400).json({ success: false, message: 'Titre et cours requis.' });
    }
    // Vérifier que le cours appartient au prof
    const check = await pool.query('SELECT id FROM courses WHERE id=$1 AND teacher_id=$2', [course_id, req.user.id]);
    if (!check.rows.length) return res.status(403).json({ success: false, message: 'Cours introuvable.' });

    const r = await pool.query(
      `INSERT INTO assignments (title, course_id, due_date, instructions, is_quiz, quiz_data, file_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title.trim(), course_id, due_date||null, instructions||null, !!is_quiz, quiz_data||null, file_url||null]
    );
    res.status(201).json({ success: true, assignment: r.rows[0] });
  } catch(e) {
    console.error('[ASSIGNMENT POST]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.delete('/assignments/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM assignments WHERE id=$1
       AND course_id IN (SELECT id FROM courses WHERE teacher_id=$2) RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Devoir introuvable.' });
    res.json({ success: true });
  } catch(e) {
    console.error('[ASSIGNMENT DELETE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.get('/assignments/:id/submissions', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT sub.id, sub.submitted_at, sub.grade, sub.feedback, sub.content, sub.file_url,
              u.first_name||' '||u.last_name AS student_name, u.email AS student_email,
              a.title AS assignment_title, a.is_quiz, a.quiz_data
       FROM assignment_submissions sub
       JOIN users u       ON sub.student_id    = u.id
       JOIN assignments a ON sub.assignment_id = a.id
       JOIN courses c     ON a.course_id       = c.id
       WHERE sub.assignment_id=$1 AND c.teacher_id=$2
       ORDER BY sub.submitted_at ASC`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true, submissions: r.rows });
  } catch(e) {
    console.error('[SUBMISSIONS GET]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.put('/submissions/:id/grade', async (req, res) => {
  try {
    const { grade, feedback } = req.body;
    if (grade === undefined || isNaN(grade) || grade < 0 || grade > 20) {
      return res.status(400).json({ success: false, message: 'Note entre 0 et 20.' });
    }
    const r = await pool.query(
      `UPDATE assignment_submissions SET grade=$1, feedback=$2, graded_at=NOW()
       WHERE id=$3 RETURNING id, grade, feedback`,
      [parseFloat(grade), feedback||null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Soumission introuvable.' });
    res.json({ success: true, submission: r.rows[0] });
  } catch(e) {
    console.error('[GRADE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  COMMUNAUTÉS
// ═══════════════════════════════════════════
router.get('/communities', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id, c.name, c.description, c.category, c.icon, c.school, c.created_at,
              COUNT(DISTINCT cm.user_id) AS member_count
       FROM communities c
       LEFT JOIN community_members cm ON cm.community_id=c.id
       WHERE c.teacher_id=$1
       GROUP BY c.id ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, communities: r.rows });
  } catch(e) {
    console.error('[COMMUNITIES GET]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.post('/communities', async (req, res) => {
  try {
    const { name, description, category, icon } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Nom requis.' });
    const u = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const school = u.rows[0]?.school || null;
    const r = await pool.query(
      `INSERT INTO communities (name, description, category, icon, teacher_id, school)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name.trim(), description||null, category||null, icon||'forum', req.user.id, school]
    );
    // Le prof rejoint automatiquement
    await pool.query(
      'INSERT INTO community_members (community_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [r.rows[0].id, req.user.id]
    );
    res.status(201).json({ success: true, community: r.rows[0] });
  } catch(e) {
    console.error('[COMMUNITY POST]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.delete('/communities/:id', async (req, res) => {
  try {
    const r = await pool.query(
      'DELETE FROM communities WHERE id=$1 AND teacher_id=$2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Communauté introuvable.' });
    res.json({ success: true });
  } catch(e) {
    console.error('[COMMUNITY DELETE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  STATISTIQUES
// ═══════════════════════════════════════════
router.get('/stats', async (req, res) => {
  try {
    const id = req.user.id;
    const avg = await pool.query(
      `SELECT c.title, c.filiere, cl.name AS class_name,
              ROUND(AVG(sub.grade)::numeric,2) AS average,
              COUNT(DISTINCT e.student_id)     AS students,
              COUNT(DISTINCT CASE WHEN sub.grade IS NOT NULL THEN sub.id END) AS graded,
              COUNT(DISTINCT sub.id)            AS total_submissions
       FROM courses c
       LEFT JOIN classes cl    ON c.class_id  = cl.id
       LEFT JOIN enrollments e ON e.course_id = c.id
       LEFT JOIN assignments a ON a.course_id = c.id
       LEFT JOIN assignment_submissions sub ON sub.assignment_id=a.id
       WHERE c.teacher_id=$1
       GROUP BY c.id, cl.name ORDER BY c.title`,
      [id]
    );
    const global = await pool.query(
      `SELECT
         COUNT(DISTINCT sub.id) AS total_submissions,
         COUNT(DISTINCT CASE WHEN sub.grade IS NOT NULL THEN sub.id END) AS graded,
         COUNT(DISTINCT CASE WHEN sub.score IS NULL THEN sub.id END)     AS pending,
         ROUND(AVG(sub.grade)::numeric,2) AS global_average
       FROM assignment_submissions sub
       JOIN assignments a ON sub.assignment_id=a.id
       JOIN courses c     ON a.course_id=c.id
       WHERE c.teacher_id=$1`,
      [id]
    );
    res.json({ success: true, avgByCourse: avg.rows, globalStats: global.rows[0] });
  } catch(e) {
    console.error('[STATS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});


// ── GET /courses/:id/students — Étudiants inscrits à un cours ──
router.get('/courses/:id/students', async (req, res) => {
  try {
    const courseId = req.params.id;
    const r = await pool.query(`
      SELECT
        u.id, u.first_name, u.last_name, u.email,
        u.school, u.filiere, u.avatar_url, u.created_at,
        ROUND(AVG(s.grade)::numeric, 1) AS avg_grade,
        COUNT(s.id) AS submitted_count,
        (SELECT COUNT(*) FROM assignments a WHERE a.course_id = $1::uuid) AS total_assignments
      FROM enrollments e
      JOIN users u ON u.id = e.student_id
      LEFT JOIN assignment_submissions s
        ON s.student_id = u.id
        AND s.assignment_id IN (
          SELECT id FROM assignments WHERE course_id = $1::uuid
        )
      WHERE e.course_id = $1::uuid
      GROUP BY u.id, u.first_name, u.last_name, u.email,
               u.school, u.filiere, u.avatar_url, u.created_at
      ORDER BY u.last_name, u.first_name
    `, [courseId]);

    res.json({ success: true, students: r.rows });
  } catch(e) {
    console.error('[TEACHER /courses/:id/students]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  NOTIFICATIONS (diffusion vers une classe ou un cours)
// ═══════════════════════════════════════════
router.post('/notifications/broadcast', async (req, res) => {
  try {
    const { title, message, type, link, target, target_id } = req.body;
    if (!title?.trim() || !target || !target_id) {
      return res.status(400).json({ success: false, message: 'Titre et cible requis.' });
    }
    let studentIds = [];
    if (target === 'course') {
      const check = await pool.query('SELECT id FROM courses WHERE id=$1 AND teacher_id=$2', [target_id, req.user.id]);
      if (!check.rows.length) return res.status(403).json({ success: false, message: 'Cours introuvable.' });
      const r = await pool.query('SELECT student_id FROM enrollments WHERE course_id=$1', [target_id]);
      studentIds = r.rows.map(x => x.student_id);
    } else if (target === 'class') {
      const check = await pool.query('SELECT id FROM classes WHERE id=$1 AND teacher_id=$2', [target_id, req.user.id]);
      if (!check.rows.length) return res.status(403).json({ success: false, message: 'Classe introuvable.' });
      const r = await pool.query('SELECT student_id FROM class_members WHERE class_id=$1', [target_id]);
      studentIds = r.rows.map(x => x.student_id);
    } else {
      return res.status(400).json({ success: false, message: 'Cible invalide.' });
    }
    if (!studentIds.length) return res.json({ success: true, sent: 0 });
    await Promise.all(studentIds.map(sid =>
      pool.query(
        `INSERT INTO notifications (user_id, title, message, type, link) VALUES ($1,$2,$3,$4,$5)`,
        [sid, title.trim(), message||null, type||'info', link||null]
      )
    ));
    res.json({ success: true, sent: studentIds.length });
  } catch(e) {
    console.error('[TEACHER NOTIF BROADCAST]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /teacher/school-students — tous les étudiants de mon établissement ──
// (pas seulement ceux déjà inscrits à une classe ou un cours précis)
router.get('/school-students', async (req, res) => {
  try {
    const u = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const school = u.rows[0]?.school;
    if (!school) return res.json({ success: true, students: [] });

    const r = await pool.query(`
      SELECT u.id, u.first_name, u.last_name, u.email, u.filiere, u.avatar_url, u.created_at,
             (SELECT COUNT(*) FROM enrollments e WHERE e.student_id=u.id) AS course_count,
             (SELECT COUNT(*) FROM class_members cm WHERE cm.student_id=u.id) AS class_count
      FROM users u
      WHERE u.role='etudiant' AND u.school=$1
      ORDER BY u.filiere NULLS LAST, u.last_name, u.first_name
    `, [school]);

    res.json({ success: true, students: r.rows });
  } catch(e) {
    console.error('[SCHOOL STUDENTS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
