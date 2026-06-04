// src/routes/student.js
const express = require('express');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

router.use(auth);

// GET /api/student/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const id = req.user.id;
    const user = await pool.query(
      `SELECT id, first_name, last_name, email, role, school, filiere, bio, phone, created_at
       FROM users WHERE id=$1`, [id]
    );
    // Nombre de cours inscrits
    const courses = await pool.query(
      `SELECT COUNT(*) FROM enrollments WHERE student_id=$1`, [id]
    );
    // Devoirs en attente (non rendus)
    const assignments = await pool.query(
      `SELECT COUNT(*)
       FROM assignments a
       JOIN courses c ON a.course_id=c.id
       JOIN enrollments e ON e.course_id=c.id AND e.student_id=$1
       LEFT JOIN assignment_submissions sub ON sub.assignment_id=a.id AND sub.student_id=$1
       WHERE sub.id IS NULL AND a.status='pending'`, [id]
    );
    // Communautés rejointes
    const communities = await pool.query(
      `SELECT COUNT(*) FROM community_members WHERE user_id=$1`, [id]
    );
    // Derniers cours (3 max)
    const recentCourses = await pool.query(
      `SELECT c.id, c.title, c.description, c.filiere, c.color, c.file_url,
              u.first_name||' '||u.last_name AS teacher_name,
              0 AS progress
       FROM enrollments e
       JOIN courses c ON e.course_id=c.id
       LEFT JOIN users u ON c.teacher_id=u.id
       WHERE e.student_id=$1
       ORDER BY e.enrolled_at DESC LIMIT 3`, [id]
    );
    res.json({
      success: true,
      user: user.rows[0],
      stats: {
        courses:     parseInt(courses.rows[0].count),
        assignments: parseInt(assignments.rows[0].count),
        communities: parseInt(communities.rows[0].count),
      },
      recentCourses: recentCourses.rows,
    });
  } catch(e) {
    console.error('[STUDENT DASHBOARD]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// GET /api/student/courses — cours de l'étudiant
// Stratégie : enrollments directs + cours de la même école/filière (si pas encore inscrit)
router.get('/courses', async (req, res) => {
  try {
    const me = await pool.query(
      'SELECT school, filiere FROM users WHERE id=$1', [req.user.id]
    );
    const { school, filiere } = me.rows[0] || {};

    // Cours : même école ET (même filière OU filière non définie par le prof)
    // Extraire le code court : "GTE — Génie Thermique" → "GTE"
    const filiereShort = filiere ? filiere.split(' — ')[0].trim() : null;

    const r = await pool.query(
      `SELECT DISTINCT c.id, c.title, c.description, c.filiere, c.color, c.file_url, c.created_at,
              u.first_name||' '||u.last_name AS teacher_name,
              (SELECT COUNT(*) FROM assignments a WHERE a.course_id=c.id) AS assignment_count,
              0 AS progress
       FROM courses c
       LEFT JOIN users u ON c.teacher_id=u.id
       WHERE c.school = $1::text
         AND (
           -- Cours sans filière = visible par tous de l'école
           c.filiere IS NULL
           OR c.filiere = ''
           -- Filière exacte (ex: étudiant="GTE — Génie Thermique", cours="GTE — Génie Thermique")
           OR c.filiere = $2::text
           -- Code court du cours = code court étudiant (ex: cours="GTE", étudiant="GTE — ...")
           OR c.filiere = $3::text
           -- Code court du COURS matche code court étudiant (ex: cours="GTE — ...", étudiant="GTE")
           OR SPLIT_PART(c.filiere, ' ', 1) = $3::text
           OR SPLIT_PART(c.filiere, ' — ', 1) = $3::text
           -- Étudiant inscrit directement via inter-universités
           OR c.id IN (SELECT course_id FROM enrollments WHERE student_id=$4)
         )
       ORDER BY c.created_at DESC`,
      [school || null, filiere || null, filiereShort || null, req.user.id]
    );

    // Auto-inscrire l'étudiant dans les cours trouvés (pour la prochaine fois)
    if (r.rows.length > 0 && school) {
      for (const c of r.rows) {
        await pool.query(
          `INSERT INTO enrollments (student_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [req.user.id, c.id]
        );
      }
    }

    res.json({ success: true, courses: r.rows });
  } catch(e) {
    console.error('[STUDENT COURSES]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// GET /api/student/assignments — devoirs des cours inscrits
router.get('/assignments', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.id, a.title, a.due_date, a.instructions, a.is_quiz, a.quiz_data, a.file_url,
              c.title AS course_title, c.filiere,
              u.first_name||' '||u.last_name AS teacher_name,
              sub.id AS submission_id, sub.grade, sub.feedback,
              sub.submitted_at, sub.content AS submitted_content, sub.file_url AS submitted_file_url,
              CASE
                WHEN sub.grade IS NOT NULL THEN 'graded'
                WHEN sub.id IS NOT NULL    THEN 'submitted'
                ELSE 'pending'
              END AS status
       FROM assignments a
       JOIN courses c ON a.course_id=c.id
       LEFT JOIN users u ON c.teacher_id=u.id
       LEFT JOIN assignment_submissions sub ON sub.assignment_id=a.id AND sub.student_id=$1
       WHERE c.school = (SELECT school FROM users WHERE id=$1::uuid)
         AND (
           c.filiere IS NULL
           OR c.filiere = ''
           OR c.filiere = (SELECT filiere FROM users WHERE id=$1::uuid)
           OR c.filiere = SPLIT_PART((SELECT filiere FROM users WHERE id=$1::uuid), ' — ', 1)
           OR c.id IN (SELECT course_id FROM enrollments WHERE student_id=$1::uuid)
         )
       ORDER BY
         CASE WHEN sub.id IS NULL THEN 0 ELSE 1 END,
         a.due_date ASC NULLS LAST`,
      [req.user.id]
    );
    res.json({ success: true, assignments: r.rows });
  } catch(e) {
    console.error('[STUDENT ASSIGNMENTS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// POST /api/student/assignments/:id/submit — rendre un devoir (texte ou URL fichier)
router.post('/assignments/:id/submit', async (req, res) => {
  try {
    const { content, file_url } = req.body;
    if (!content?.trim() && !file_url) {
      return res.status(400).json({ success: false, message: 'Contenu ou fichier requis.' });
    }
    // Vérifier que l'étudiant est inscrit au cours de ce devoir
    const check = await pool.query(
      `SELECT a.id FROM assignments a
       JOIN courses c ON a.course_id=c.id
       JOIN enrollments e ON e.course_id=c.id AND e.student_id=$1
       WHERE a.id=$2`,
      [req.user.id, req.params.id]
    );
    if (!check.rows.length) {
      return res.status(403).json({ success: false, message: 'Vous n\'êtes pas inscrit à ce cours.' });
    }
    const r = await pool.query(
      `INSERT INTO assignment_submissions (assignment_id, student_id, content, file_url)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (assignment_id, student_id) DO UPDATE
         SET content=$3, file_url=$4, submitted_at=NOW()
       RETURNING *`,
      [req.params.id, req.user.id, content?.trim()||null, file_url||null]
    );
    res.json({ success: true, submission: r.rows[0] });
  } catch(e) {
    console.error('[SUBMIT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// GET /api/student/profile
router.get('/profile', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, first_name, last_name, email, role, school, filiere, bio, phone, created_at
       FROM users WHERE id=$1`, [req.user.id]
    );
    res.json({ success: true, user: r.rows[0] });
  } catch(e) {
    console.error('[STUDENT PROFILE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// PUT /api/student/profile
router.put('/profile', async (req, res) => {
  try {
    const { first_name, last_name, bio, phone } = req.body;
    if (!first_name?.trim() || !last_name?.trim()) {
      return res.status(400).json({ success: false, message: 'Prénom et nom requis.' });
    }
    const r = await pool.query(
      `UPDATE users SET first_name=$1, last_name=$2, bio=$3, phone=$4
       WHERE id=$5
       RETURNING id, first_name, last_name, email, role, school, filiere, bio, phone`,
      [first_name.trim(), last_name.trim(), bio||null, phone||null, req.user.id]
    );
    res.json({ success: true, user: r.rows[0] });
  } catch(e) {
    console.error('[STUDENT PROFILE PUT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;

// ── GET /api/student/classroom ────────────────────────────────
// Ma salle de classe : infos classe, camarades, classement, emploi du temps
router.get('/classroom', async (req, res) => {
  try {
    const id = req.user.id;

    // Infos de l'étudiant
    const me = await pool.query(
      'SELECT school, filiere FROM users WHERE id=$1', [id]
    );
    const { school, filiere } = me.rows[0] || {};
    if (!school || !filiere) {
      return res.json({ success: true, classroom: null, message: 'Université ou filière non définie.' });
    }

    // Trouver la classe de l'étudiant
    const classInfo = await pool.query(`
      SELECT cl.id, cl.name, cl.filiere, cl.level, cl.academic_year, cl.description,
             u.first_name||' '||u.last_name AS teacher_name,
             u.discipline AS teacher_discipline,
             COUNT(DISTINCT cm2.student_id) AS student_count
      FROM class_members cm
      JOIN classes cl ON cm.class_id = cl.id
      LEFT JOIN users u ON cl.teacher_id = u.id
      LEFT JOIN class_members cm2 ON cm2.class_id = cl.id
      WHERE cm.student_id = $1
        AND cl.school = $2
      GROUP BY cl.id, u.first_name, u.last_name, u.discipline
      ORDER BY cl.created_at DESC
      LIMIT 1`,
      [id, school]
    );

    // Si pas de classe formelle → créer une classe virtuelle par filière
    let classroom = classInfo.rows[0] || null;
    let classId   = classroom?.id || null;

    // Camarades (même filière, même école)
    const classmates = await pool.query(`
      SELECT u.id, u.first_name, u.last_name, u.filiere,
             (SELECT ROUND(AVG(sub.grade)::numeric, 1)
              FROM assignment_submissions sub
              JOIN assignments a ON sub.assignment_id = a.id
              JOIN courses c ON a.course_id = c.id
              WHERE sub.student_id = u.id
                AND c.school = $2
                AND sub.grade IS NOT NULL
             ) AS avg_grade,
             (SELECT COUNT(*)
              FROM assignment_submissions sub
              WHERE sub.student_id = u.id
             ) AS submitted_count
      FROM users u
      WHERE u.role = 'etudiant'
        AND u.school = $2
        AND u.filiere = $3
        AND u.id != $1
      ORDER BY avg_grade DESC NULLS LAST
      LIMIT 20`,
      [id, school, filiere]
    );

    // Ma moyenne personnelle
    const myAvg = await pool.query(`
      SELECT ROUND(AVG(sub.grade)::numeric, 1) AS avg_grade,
             COUNT(*) FILTER (WHERE sub.grade IS NOT NULL) AS graded_count,
             COUNT(*) AS total_submitted
      FROM assignment_submissions sub
      JOIN assignments a ON sub.assignment_id = a.id
      JOIN courses c ON a.course_id = c.id
      WHERE sub.student_id = $1
        AND c.school = $2`,
      [id, school]
    );

    // Classement complet de la filière
    const ranking = await pool.query(`
      SELECT u.id, u.first_name, u.last_name,
             ROUND(AVG(sub.grade)::numeric, 1) AS avg_grade,
             COUNT(sub.id) FILTER (WHERE sub.grade IS NOT NULL) AS graded_count
      FROM users u
      LEFT JOIN assignment_submissions sub ON sub.student_id = u.id
      LEFT JOIN assignments a ON sub.assignment_id = a.id
      LEFT JOIN courses c ON a.course_id = c.id AND c.school = $1
      WHERE u.role = 'etudiant'
        AND u.school = $1
        AND u.filiere = $2
      GROUP BY u.id
      ORDER BY avg_grade DESC NULLS LAST`,
      [school, filiere]
    );

    // Position de l'étudiant dans le classement
    const myRank = ranking.rows.findIndex(r => r.id === id) + 1;

    // Cours de la semaine (prochains cours de la filière)
    const weeklyCourses = await pool.query(`
      SELECT c.id, c.title, c.filiere, c.color, c.file_url,
             u.first_name||' '||u.last_name AS teacher_name,
             (SELECT COUNT(*) FROM assignments a WHERE a.course_id = c.id) AS assignment_count,
             (SELECT COUNT(*) FROM assignment_submissions sub
              JOIN assignments a ON sub.assignment_id = a.id
              WHERE a.course_id = c.id AND sub.student_id = $1
             ) AS my_submitted
      FROM enrollments e
      JOIN courses c ON e.course_id = c.id
      LEFT JOIN users u ON c.teacher_id = u.id
      WHERE e.student_id = $1
      ORDER BY c.created_at DESC
      LIMIT 5`,
      [id]
    );

    // Devoirs urgents (non rendus, date limite proche)
    const urgentAssignments = await pool.query(`
      SELECT a.id, a.title, a.due_date, a.is_quiz,
             c.title AS course_title,
             u.first_name||' '||u.last_name AS teacher_name
      FROM assignments a
      JOIN courses c ON a.course_id = c.id
      LEFT JOIN users u ON c.teacher_id = u.id
      JOIN enrollments e ON e.course_id = c.id AND e.student_id = $1
      LEFT JOIN assignment_submissions sub ON sub.assignment_id = a.id AND sub.student_id = $1
      WHERE sub.id IS NULL
        AND a.due_date IS NOT NULL
        AND a.due_date > NOW()
      ORDER BY a.due_date ASC
      LIMIT 3`,
      [id]
    );

    // Mes notes par cours (pour graphique)
    const gradesByCourse = await pool.query(`
      SELECT c.title AS course_title, c.color,
             ROUND(AVG(sub.grade)::numeric, 1) AS avg_grade,
             COUNT(sub.id) FILTER (WHERE sub.grade IS NOT NULL) AS graded,
             COUNT(sub.id) AS total
      FROM assignment_submissions sub
      JOIN assignments a ON sub.assignment_id = a.id
      JOIN courses c ON a.course_id = c.id
      JOIN enrollments e ON e.course_id = c.id AND e.student_id = $1
      WHERE sub.student_id = $1
        AND c.school = $2
      GROUP BY c.id
      ORDER BY avg_grade DESC NULLS LAST`,
      [id, school]
    );

    res.json({
      success: true,
      classroom: classroom ? {
        ...classroom,
        school,
        filiere,
      } : {
        name: `${filiere} — ${school}`,
        filiere,
        school,
        academic_year: '2025/2026',
        student_count: classmates.rows.length + 1,
      },
      me: {
        rank:      myRank || null,
        total:     ranking.rows.length,
        avg_grade: myAvg.rows[0]?.avg_grade || null,
        graded:    myAvg.rows[0]?.graded_count || 0,
        submitted: myAvg.rows[0]?.total_submitted || 0,
      },
      classmates:        classmates.rows,
      ranking:           ranking.rows.slice(0, 10),
      weeklyCourses:     weeklyCourses.rows,
      urgentAssignments: urgentAssignments.rows,
      gradesByCourse:    gradesByCourse.rows,
    });
  } catch(e) {
    console.error('[STUDENT CLASSROOM]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});