// src/routes/admin.js
const express = require('express');
const bcrypt  = require('bcrypt');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

// Middleware admin — vérifie le rôle dans le token JWT
const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs.' });
  }
  next();
};

router.use(auth, adminOnly);

// ── GET /api/admin/stats ─────────────────────────────────────
// Statistiques filtrées par université de l'admin
router.get('/stats', async (req, res) => {
  try {
    // Récupérer l'école de l'admin
    const adminInfo = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const school    = adminInfo.rows[0]?.school;
    const filter    = school ? ` WHERE school=$1` : '';
    const filterCourse = school ? ` WHERE school=$1` : '';
    const params    = school ? [school] : [];

    const [
      students, teachers, courses, classes,
      communities, assignments, submissions,
      newThisWeek, schoolStats
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM users WHERE role='etudiant'${school?" AND school=$1":''}`, params),
      pool.query(`SELECT COUNT(*) FROM users WHERE role='enseignant'${school?" AND school=$1":''}`, params),
      pool.query(`SELECT COUNT(*) FROM courses${filterCourse}`, params),
      pool.query(`SELECT COUNT(*) FROM classes${school?" WHERE school=$1":''}`, params),
      pool.query(`SELECT COUNT(*) FROM communities${school?" WHERE school=$1":''}`, params),
      pool.query(`SELECT COUNT(*) FROM assignments${school?` WHERE course_id IN (SELECT id FROM courses WHERE school=$1)`:''}`, params),
      pool.query(`SELECT COUNT(*) FROM assignment_submissions${school?` WHERE assignment_id IN (SELECT a.id FROM assignments a JOIN courses c ON a.course_id=c.id WHERE c.school=$1)`:''}`, params),
      pool.query(`SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days'${school?" AND school=$1":''}`, params),
      pool.query(`
        SELECT school,
               COUNT(*) FILTER (WHERE role='etudiant')   AS students,
               COUNT(*) FILTER (WHERE role='enseignant') AS teachers
        FROM users
        WHERE school IS NOT NULL${school?" AND school=$1":''}
        GROUP BY school
        ORDER BY students DESC
      `, params),
    ]);

    res.json({
      success: true,
      stats: {
        students:    parseInt(students.rows[0].count),
        teachers:    parseInt(teachers.rows[0].count),
        courses:     parseInt(courses.rows[0].count),
        classes:     parseInt(classes.rows[0].count),
        communities: parseInt(communities.rows[0].count),
        assignments: parseInt(assignments.rows[0].count),
        submissions: parseInt(submissions.rows[0].count),
        newThisWeek: parseInt(newThisWeek.rows[0].count),
      },
      schoolStats: schoolStats.rows,
    });
  } catch(e) {
    console.error('[ADMIN STATS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/users ─────────────────────────────────────
// Liste tous les utilisateurs avec filtres
router.get('/users', async (req, res) => {
  try {
    const { role, school, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params     = [];
    let   pi         = 1;

    if (role)   { conditions.push(`role=$${pi++}`);   params.push(role); }
    if (school) { conditions.push(`school=$${pi++}`); params.push(school); }
    if (search) {
      conditions.push(`(first_name ILIKE $${pi} OR last_name ILIKE $${pi} OR email ILIKE $${pi})`);
      params.push(`%${search}%`); pi++;
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT id, first_name, last_name, email, role, school, filiere, discipline, created_at
         FROM users ${where}
         ORDER BY created_at DESC
         LIMIT $${pi} OFFSET $${pi+1}`,
        [...params, parseInt(limit), offset]
      ),
      pool.query(`SELECT COUNT(*) FROM users ${where}`, params),
    ]);

    res.json({
      success: true,
      users: rows.rows,
      total: parseInt(total.rows[0].count),
      pages: Math.ceil(parseInt(total.rows[0].count) / parseInt(limit)),
      page:  parseInt(page),
    });
  } catch(e) {
    console.error('[ADMIN USERS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/users/:id ─────────────────────────────────
// Détail d'un utilisateur
router.get('/users/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, first_name, last_name, email, role, school, filiere, discipline, bio, phone, created_at
       FROM users WHERE id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });

    // Stats selon le rôle
    let extra = {};
    const u = r.rows[0];

    if (u.role === 'etudiant') {
      const [courses, assignments, submitted] = await Promise.all([
        pool.query(`SELECT COUNT(*) FROM enrollments WHERE student_id=$1`, [u.id]),
        pool.query(`
          SELECT COUNT(*) FROM assignments a
          JOIN courses c ON a.course_id=c.id
          JOIN enrollments e ON e.course_id=c.id AND e.student_id=$1`, [u.id]),
        pool.query(`SELECT COUNT(*) FROM assignment_submissions WHERE student_id=$1`, [u.id]),
      ]);
      extra = {
        courses_count:    parseInt(courses.rows[0].count),
        assignments_count: parseInt(assignments.rows[0].count),
        submitted_count:  parseInt(submitted.rows[0].count),
      };
    } else if (u.role === 'enseignant') {
      const [classes, courses, students] = await Promise.all([
        pool.query(`SELECT COUNT(*) FROM classes WHERE teacher_id=$1`, [u.id]),
        pool.query(`SELECT COUNT(*) FROM courses WHERE teacher_id=$1`, [u.id]),
        pool.query(`
          SELECT COUNT(DISTINCT cm.student_id) FROM class_members cm
          JOIN classes cl ON cm.class_id=cl.id WHERE cl.teacher_id=$1`, [u.id]),
      ]);
      extra = {
        classes_count:  parseInt(classes.rows[0].count),
        courses_count:  parseInt(courses.rows[0].count),
        students_count: parseInt(students.rows[0].count),
      };
    }

    res.json({ success: true, user: { ...u, ...extra } });
  } catch(e) {
    console.error('[ADMIN USER DETAIL]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── POST /api/admin/users ────────────────────────────────────
// Créer un utilisateur (admin peut créer n'importe quel rôle)
router.post('/users', async (req, res) => {
  try {
    const { first_name, last_name, email, password, role, school, filiere, discipline } = req.body;
    if (!first_name || !last_name || !email || !password || !role) {
      return res.status(400).json({ success: false, message: 'Champs obligatoires manquants.' });
    }
    const exists = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(409).json({ success: false, message: 'Email déjà utilisé.' });

    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role, school, filiere, discipline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, first_name, last_name, email, role, school, filiere, discipline, created_at`,
      [first_name, last_name, email.toLowerCase(), hash, role, school||null, filiere||null, discipline||null]
    );
    res.status(201).json({ success: true, user: r.rows[0] });
  } catch(e) {
    console.error('[ADMIN CREATE USER]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── PUT /api/admin/users/:id ─────────────────────────────────
// Modifier un utilisateur (rôle, école, etc.)
router.put('/users/:id', async (req, res) => {
  try {
    const { first_name, last_name, role, school, filiere, discipline, password } = req.body;
    let updateParts = [];
    let params      = [];
    let pi          = 1;

    if (first_name)  { updateParts.push(`first_name=$${pi++}`);  params.push(first_name); }
    if (last_name)   { updateParts.push(`last_name=$${pi++}`);   params.push(last_name); }
    if (role)        { updateParts.push(`role=$${pi++}`);        params.push(role); }
    if (school)      { updateParts.push(`school=$${pi++}`);      params.push(school); }
    if (filiere)     { updateParts.push(`filiere=$${pi++}`);     params.push(filiere); }
    if (discipline)  { updateParts.push(`discipline=$${pi++}`);  params.push(discipline); }
    if (password)    {
      const hash = await bcrypt.hash(password, 12);
      updateParts.push(`password_hash=$${pi++}`);
      params.push(hash);
    }

    if (!updateParts.length) return res.status(400).json({ success: false, message: 'Rien à modifier.' });

    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE users SET ${updateParts.join(',')} WHERE id=$${pi}
       RETURNING id, first_name, last_name, email, role, school, filiere, discipline`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
    res.json({ success: true, user: r.rows[0] });
  } catch(e) {
    console.error('[ADMIN UPDATE USER]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── DELETE /api/admin/users/:id ──────────────────────────────
// Supprimer un utilisateur
router.delete('/users/:id', async (req, res) => {
  try {
    // Empêcher de se supprimer soi-même
    if (req.params.id === req.user.id) {
      return res.status(400).json({ success: false, message: 'Impossible de supprimer votre propre compte.' });
    }
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    console.error('[ADMIN DELETE USER]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/schools ───────────────────────────────────
// Liste des universités avec stats
router.get('/schools', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        school,
        COUNT(*) FILTER (WHERE role='etudiant')   AS students,
        COUNT(*) FILTER (WHERE role='enseignant') AS teachers,
        (SELECT COUNT(*) FROM courses WHERE courses.school=u.school) AS courses,
        (SELECT COUNT(*) FROM classes WHERE classes.school=u.school) AS classes,
        (SELECT COUNT(*) FROM communities WHERE communities.school=u.school) AS communities
      FROM users u
      WHERE school IS NOT NULL
      GROUP BY school
      ORDER BY students DESC
    `);
    res.json({ success: true, schools: r.rows });
  } catch(e) {
    console.error('[ADMIN SCHOOLS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/activity ──────────────────────────────────
// Activité récente (dernières inscriptions, soumissions)
router.get('/activity', async (req, res) => {
  try {
    const [registrations, submissions] = await Promise.all([
      pool.query(`
        SELECT id, first_name, last_name, email, role, school, filiere, created_at
        FROM users ORDER BY created_at DESC LIMIT 10
      `),
      pool.query(`
        SELECT sub.submitted_at,
               u.first_name||' '||u.last_name AS student_name,
               a.title AS assignment_title,
               c.title AS course_title,
               sub.grade
        FROM assignment_submissions sub
        JOIN users u ON sub.student_id=u.id
        JOIN assignments a ON sub.assignment_id=a.id
        JOIN courses c ON a.course_id=c.id
        ORDER BY sub.submitted_at DESC LIMIT 10
      `),
    ]);

    res.json({
      success: true,
      recentUsers:       registrations.rows,
      recentSubmissions: submissions.rows,
    });
  } catch(e) {
    console.error('[ADMIN ACTIVITY]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── DELETE /api/admin/courses/:id ───────────────────────────
router.delete('/courses/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM courses WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    console.error('[ADMIN DELETE COURSE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── DELETE /api/admin/communities/:id ───────────────────────
router.delete('/communities/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM communities WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    console.error('[ADMIN DELETE COMMUNITY]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/courses ──────────────────────────────────
// Tous les cours de l'université de l'admin avec trajet complet
router.get('/courses', async (req, res) => {
  try {
    const adminInfo = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const school    = adminInfo.rows[0]?.school;
    const params    = school ? [school] : [];
    const where     = school ? 'WHERE c.school=$1' : '';

    const r = await pool.query(`
      SELECT
        c.id, c.title, c.description, c.filiere, c.color, c.file_url, c.created_at,
        -- Infos prof
        u.first_name||' '||u.last_name AS teacher_name,
        u.email    AS teacher_email,
        u.discipline AS teacher_discipline,
        -- Classe liée
        cl.name    AS class_name,
        cl.level   AS class_level,
        -- Stats
        (SELECT COUNT(DISTINCT e.student_id) FROM enrollments e WHERE e.course_id=c.id) AS student_count,
        (SELECT COUNT(*) FROM assignments a WHERE a.course_id=c.id)                      AS assignment_count,
        (SELECT COUNT(*) FROM assignment_submissions sub
         JOIN assignments a ON sub.assignment_id=a.id
         WHERE a.course_id=c.id)                                                          AS submission_count,
        (SELECT COUNT(*) FROM assignment_submissions sub
         JOIN assignments a ON sub.assignment_id=a.id
         WHERE a.course_id=c.id AND sub.grade IS NOT NULL)                                AS graded_count,
        (SELECT ROUND(AVG(sub.grade),1) FROM assignment_submissions sub
         JOIN assignments a ON sub.assignment_id=a.id
         WHERE a.course_id=c.id AND sub.grade IS NOT NULL)                                AS avg_grade
      FROM courses c
      LEFT JOIN users u  ON c.teacher_id = u.id
      LEFT JOIN classes cl ON c.class_id = cl.id
      ${where}
      ORDER BY c.created_at DESC
    `, params);

    res.json({ success: true, courses: r.rows });
  } catch(e) {
    console.error('[ADMIN COURSES]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/courses/:id/journey ──────────────────────
// Trajet complet d'un cours : prof → classe → étudiants → devoirs → notes
router.get('/courses/:id/journey', async (req, res) => {
  try {
    // Infos du cours
    const course = await pool.query(`
      SELECT c.*, u.first_name||' '||u.last_name AS teacher_name,
             u.email AS teacher_email, '—' AS discipline,
             cl.name AS class_name, cl.level, cl.filiere AS class_filiere
      FROM courses c
      LEFT JOIN users u ON c.teacher_id=u.id
      LEFT JOIN classes cl ON c.class_id=cl.id
      WHERE c.id=$1`, [req.params.id]);

    if (!course.rows.length) return res.status(404).json({ success:false, message:'Cours introuvable.' });

    // Étudiants inscrits
    const students = await pool.query(`
      SELECT u.id, u.first_name, u.last_name, u.email, u.filiere,
             (SELECT COUNT(*) FROM assignment_submissions sub
              JOIN assignments a ON sub.assignment_id=a.id
              WHERE a.course_id=$1 AND sub.student_id=u.id) AS submitted_count,
             (SELECT ROUND(AVG(sub.grade),1) FROM assignment_submissions sub
              JOIN assignments a ON sub.assignment_id=a.id
              WHERE a.course_id=$1 AND sub.student_id=u.id AND sub.grade IS NOT NULL) AS avg_grade
      FROM enrollments e
      JOIN users u ON e.student_id=u.id
      WHERE e.course_id=$1
      ORDER BY u.last_name`, [req.params.id]);

    // Devoirs et résultats
    const assignments = await pool.query(`
      SELECT a.id, a.title, a.due_date, a.is_quiz,
             COUNT(sub.id)                                    AS submission_count,
             COUNT(sub.id) FILTER (WHERE sub.grade IS NOT NULL) AS graded_count,
             ROUND(AVG(sub.grade),1)                          AS avg_grade
      FROM assignments a
      LEFT JOIN assignment_submissions sub ON sub.assignment_id=a.id
      WHERE a.course_id=$1
      GROUP BY a.id
      ORDER BY a.created_at`, [req.params.id]);

    res.json({
      success: true,
      course:      course.rows[0],
      students:    students.rows,
      assignments: assignments.rows,
    });
  } catch(e) {
    console.error('[ADMIN JOURNEY]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/communities ──────────────────────────────
// Toutes les communautés de l'université de l'admin
router.get('/communities', async (req, res) => {
  try {
    const adminInfo = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const school    = adminInfo.rows[0]?.school;
    const params    = school ? [school] : [];
    const where     = school ? 'WHERE c.school=$1' : '';

    const r = await pool.query(`
      SELECT
        c.id, c.name, c.description, c.category, c.icon, c.school, c.created_at,
        u.first_name||' '||u.last_name AS teacher_name,
        u.email AS teacher_email,
        COUNT(DISTINCT cm.user_id)                                           AS member_count,
        COUNT(DISTINCT cm.user_id) FILTER (WHERE us.role='etudiant')        AS student_members,
        COUNT(DISTINCT cm.user_id) FILTER (WHERE us.role='enseignant')      AS teacher_members,
        (SELECT COUNT(*) FROM community_posts p WHERE p.community_id=c.id)  AS post_count,
        (SELECT MAX(p.created_at) FROM community_posts p WHERE p.community_id=c.id) AS last_activity
      FROM communities c
      LEFT JOIN users u  ON c.teacher_id=u.id
      LEFT JOIN community_members cm ON cm.community_id=c.id
      LEFT JOIN users us ON cm.user_id=us.id
      ${where}
      GROUP BY c.id, u.first_name, u.last_name, u.email
      ORDER BY last_activity DESC NULLS LAST, c.created_at DESC
    `, params);

    res.json({ success: true, communities: r.rows });
  } catch(e) {
    console.error('[ADMIN COMMUNITIES]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;