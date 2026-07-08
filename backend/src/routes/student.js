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
      `SELECT id, first_name, last_name, email, role, school, filiere, bio, created_at
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
       WHERE sub.id IS NULL AND COALESCE(a.status,'pending')='pending'`, [id]
    );
    // Communautés rejointes
    const communities = await pool.query(
      `SELECT COUNT(*) FROM community_members WHERE user_id=$1`, [id]
    );
    // Derniers cours (3 max)
    const recentCourses = await pool.query(
      `SELECT c.id, c.title, c.description, c.filiere, '#4ade80' AS color, NULL AS file_url,
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
      `SELECT DISTINCT c.id, c.title, c.description, c.filiere, c.level, COALESCE(c.color,'orange') AS color, c.file_url, c.created_at,
              u.first_name||' '||u.last_name AS teacher_name,
              (SELECT COUNT(*) FROM assignments a WHERE a.course_id=c.id) AS assignment_count,
              0 AS progress
       FROM courses c
       LEFT JOIN users u ON c.teacher_id=u.id
       WHERE c.school = $1::text
         AND (
           -- Cours rattaché à une classe précise (L1, L2, Master...) : uniquement si l'étudiant a rejoint cette classe
           (c.class_id IS NOT NULL AND c.class_id IN (SELECT class_id FROM class_members WHERE student_id=$4))
           OR (
             -- Cours SANS classe : visible par filière, et par niveau si le prof en a précisé un
             c.class_id IS NULL
             AND (
               c.filiere IS NULL
               OR c.filiere = ''
               OR c.filiere = $2::text
               OR c.filiere = $3::text
               OR SPLIT_PART(c.filiere, ' ', 1) = $3::text
               OR SPLIT_PART(c.filiere, ' — ', 1) = $3::text
             )
             AND (
               c.level IS NULL
               OR c.level IN (SELECT cl.level FROM class_members cm JOIN classes cl ON cm.class_id=cl.id WHERE cm.student_id=$4)
             )
           )
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
           (c.class_id IS NOT NULL AND c.class_id IN (SELECT class_id FROM class_members WHERE student_id=$1::uuid))
           OR (
             c.class_id IS NULL
             AND (
               c.filiere IS NULL
               OR c.filiere = ''
               OR c.filiere = (SELECT filiere FROM users WHERE id=$1::uuid)
               OR c.filiere = SPLIT_PART((SELECT filiere FROM users WHERE id=$1::uuid), ' — ', 1)
             )
             AND (
               c.level IS NULL
               OR c.level IN (SELECT cl.level FROM class_members cm JOIN classes cl ON cm.class_id=cl.id WHERE cm.student_id=$1::uuid)
             )
           )
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

// POST /api/student/assignments/:id/submit — rendre un devoir ou un quiz (texte ou URL fichier)
router.post('/assignments/:id/submit', async (req, res) => {
  try {
    const { content, file_url, tab_switches } = req.body;
    if (!content?.trim() && !file_url) {
      return res.status(400).json({ success: false, message: 'Contenu ou fichier requis.' });
    }
    // Anti-triche léger : nombre de fois où l'étudiant a quitté l'onglet du quiz.
    const tabSwitches = Number.isFinite(parseInt(tab_switches)) ? Math.max(0, parseInt(tab_switches)) : 0;
    // Vérifier que l'étudiant est inscrit au cours de ce devoir
    const check = await pool.query(
      `SELECT a.id, a.is_quiz FROM assignments a
       JOIN courses c ON a.course_id=c.id
       JOIN enrollments e ON e.course_id=c.id AND e.student_id=$1
       WHERE a.id=$2`,
      [req.user.id, req.params.id]
    );
    if (!check.rows.length) {
      return res.status(403).json({ success: false, message: 'Vous n\'êtes pas inscrit à ce cours.' });
    }

    // Pour un quiz, le score est déjà calculé côté client (content contient {answers,score,total,note})
    // → on le récupère pour noter automatiquement la copie ("quiz auto-corrigé")
    let autoGrade = null;
    if (check.rows[0].is_quiz && content) {
      try {
        const parsed = JSON.parse(content);
        if (typeof parsed.note === 'number' && parsed.note >= 0 && parsed.note <= 20) autoGrade = parsed.note;
      } catch(e) { /* pas du JSON valide, on laisse la note vide */ }
    }

    // Pas de dépendance à une contrainte UNIQUE (assignment_id, student_id) qui peut ne pas
    // exister réellement en base : on vérifie et on choisit UPDATE ou INSERT nous-mêmes.
    const existing = await pool.query(
      `SELECT id FROM assignment_submissions WHERE assignment_id=$1 AND student_id=$2`,
      [req.params.id, req.user.id]
    );

    const doSave = async (grade) => {
      // Note : graded_at est calculé côté JS (et non via un CASE WHEN $n IS NOT NULL
      // en SQL) car réutiliser le même paramètre dans un test booléen ET dans une
      // affectation typée fait échouer l'inférence de type de Postgres avec l'erreur
      // "could not determine data type of parameter $n".
      const gradedAt = grade !== null ? new Date() : null;
      if (existing.rows.length) {
        return pool.query(
          `UPDATE assignment_submissions
           SET content=$1, file_url=$2, submitted_at=NOW(), tab_switches=$3,
               grade=COALESCE($4, grade),
               graded_at=COALESCE($5, graded_at)
           WHERE id=$6 RETURNING *`,
          [content?.trim()||null, file_url||null, tabSwitches, grade, gradedAt, existing.rows[0].id]
        );
      }
      return pool.query(
        `INSERT INTO assignment_submissions (assignment_id, student_id, content, file_url, grade, graded_at, tab_switches)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [req.params.id, req.user.id, content?.trim()||null, file_url||null, grade, gradedAt, tabSwitches]
      );
    };

    let r;
    try {
      r = await doSave(autoGrade);
    } catch(e) {
      // Si la note auto-calculée du quiz fait échouer l'écriture (ex: colonne
      // "grade" d'un type qui n'accepte pas de décimales sur cette base), on
      // retente sans la note plutôt que de faire perdre la copie de l'étudiant.
      if (autoGrade !== null) {
        console.warn('[SUBMIT] échec avec note auto-calculée, nouvelle tentative sans note:', e.message);
        r = await doSave(null);
      } else {
        throw e;
      }
    }
    res.json({ success: true, submission: r.rows[0] });
  } catch(e) {
    console.error('[SUBMIT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.', detail: e.message });
  }
});

// GET /api/student/profile
router.get('/profile', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, first_name, last_name, email, role, school, filiere, bio, created_at
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

    // Trouver la classe de l'étudiant — uniquement via class_members, JAMAIS via un
    // simple recoupement de filière : deux classes (ex. L1 et L2) peuvent partager
    // la même filière, et mélanger leurs étudiants dans le classement/les camarades
    // serait une vraie fuite d'information entre niveaux.
    const classInfo = await pool.query(`
      SELECT cl.id, cl.name, cl.filiere, cl.level, cl.academic_year, cl.description, cl.class_code,
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

    const classroom = classInfo.rows[0] || null;

    // Pas encore rattaché à une classe formelle : on demande le code plutôt que
    // d'improviser un classement par filière qui mélangerait tous les niveaux.
    if (!classroom) {
      return res.json({ success: true, classroom: null, needsCode: true });
    }
    const classId = classroom.id;

    // Camarades — uniquement les membres de LA MÊME classe (même id)
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
      FROM class_members cm
      JOIN users u ON u.id = cm.student_id
      WHERE cm.class_id = $1
        AND u.id != $3
      ORDER BY avg_grade DESC NULLS LAST
      LIMIT 20`,
      [classId, school, id]
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

    // Classement — uniquement les membres de LA MÊME classe
    const ranking = await pool.query(`
      SELECT u.id, u.first_name, u.last_name,
             ROUND(AVG(sub.grade)::numeric, 1) AS avg_grade,
             COUNT(sub.id) FILTER (WHERE sub.grade IS NOT NULL) AS graded_count
      FROM class_members cm
      JOIN users u ON u.id = cm.student_id
      LEFT JOIN assignment_submissions sub ON sub.student_id = u.id
      LEFT JOIN assignments a ON sub.assignment_id = a.id
      LEFT JOIN courses c ON a.course_id = c.id AND c.school = $2
      WHERE cm.class_id = $1
      GROUP BY u.id
      ORDER BY avg_grade DESC NULLS LAST`,
      [classId, school]
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
      SELECT a.id, a.title, a.due_date, false AS is_quiz,
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
      classroom: { ...classroom, school, filiere },
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

// GET /api/student/classroom/available — liste des classes (L1, L2, Master...)
// de l'école de l'étudiant, pour choisir laquelle rejoindre avant de saisir le
// code. Le code lui-même n'est jamais exposé ici (secret partagé par le prof).
router.get('/classroom/available', async (req, res) => {
  try {
    const me = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const school = me.rows[0]?.school;
    const r = await pool.query(
      `SELECT cl.id, cl.name, cl.filiere, cl.level, cl.academic_year,
              u.first_name||' '||u.last_name AS teacher_name,
              (SELECT COUNT(*) FROM class_members cm WHERE cm.class_id=cl.id) AS student_count
       FROM classes cl
       LEFT JOIN users u ON u.id=cl.teacher_id
       WHERE cl.school=$1
       ORDER BY cl.level NULLS LAST, cl.name`,
      [school || null]
    );
    res.json({ success: true, classes: r.rows });
  } catch(e) {
    console.error('[CLASSROOM AVAILABLE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// POST /api/student/classroom/join — rejoindre une classe (L1, L2, Master...) via
// le code partagé par l'enseignant, plutôt que de deviner par filière/niveau.
router.post('/classroom/join', async (req, res) => {
  try {
    const code = (req.body.code || '').trim().toUpperCase();
    const classIdHint = req.body.class_id || null;
    if (!code) return res.status(400).json({ success: false, message: 'Code de classe requis.' });

    const me = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const school = me.rows[0]?.school;

    const cls = await pool.query('SELECT * FROM classes WHERE class_code=$1', [code]);
    if (!cls.rows.length) {
      return res.status(404).json({ success: false, message: 'Code de classe introuvable. Vérifiez auprès de votre enseignant.' });
    }
    const classe = cls.rows[0];
    if (classIdHint && classe.id !== classIdHint) {
      return res.status(400).json({ success: false, message: 'Ce code ne correspond pas à la classe sélectionnée.' });
    }
    if (school && classe.school && classe.school !== school) {
      return res.status(403).json({ success: false, message: 'Cette classe appartient à une autre université.' });
    }

    await pool.query(
      'INSERT INTO class_members (class_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [classe.id, req.user.id]
    );
    const courses = await pool.query('SELECT id FROM courses WHERE class_id=$1', [classe.id]);
    for (const c of courses.rows) {
      await pool.query(
        'INSERT INTO enrollments (student_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [req.user.id, c.id]
      );
    }

    res.json({ success: true, class: classe });
  } catch(e) {
    console.error('[CLASSROOM JOIN]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});
