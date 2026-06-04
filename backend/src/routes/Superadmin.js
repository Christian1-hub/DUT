// src/routes/superadmin.js
// Super Admin — accès global à toute la plateforme CamunoLearn
const express = require('express');
const bcrypt  = require('bcrypt');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

const superOnly = (req, res, next) => {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ success:false, message:'Accès réservé au Super Admin CamunoLearn.' });
  }
  next();
};
router.use(auth, superOnly);

// ── GET /api/superadmin/stats ─────────────────────────────────
// Vue globale de toute la plateforme
router.get('/stats', async (req, res) => {
  try {
    const [users, schools, courses, communities, submissions, activity] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE role='etudiant')   AS students,
          COUNT(*) FILTER (WHERE role='enseignant') AS teachers,
          COUNT(*) FILTER (WHERE role='admin')      AS admins,
          COUNT(*) FILTER (WHERE role='superadmin') AS superadmins,
          COUNT(*) FILTER (WHERE is_active=false)   AS inactive,
          COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '7 days') AS new_this_week
        FROM users`),
      pool.query(`
        SELECT school,
          COUNT(*) FILTER (WHERE role='etudiant')   AS students,
          COUNT(*) FILTER (WHERE role='enseignant') AS teachers,
          COUNT(*) FILTER (WHERE role='admin')      AS admins
        FROM users WHERE school IS NOT NULL
        GROUP BY school ORDER BY students DESC`),
      pool.query(`SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '30 days') AS last_month
        FROM courses`),
      pool.query(`SELECT COUNT(*) AS total FROM communities`),
      pool.query(`SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE submitted_at >= NOW()-INTERVAL '7 days') AS last_week
        FROM assignment_submissions`),
      pool.query(`
        SELECT u.first_name||' '||u.last_name AS name, u.role, u.school,
               u.email, u.created_at
        FROM users u ORDER BY u.created_at DESC LIMIT 20`),
    ]);

    res.json({
      success: true,
      global: {
        ...users.rows[0],
        courses:     parseInt(courses.rows[0].total),
        courses_month: parseInt(courses.rows[0].last_month),
        communities: parseInt(communities.rows[0].total),
        submissions: parseInt(submissions.rows[0].total),
        submissions_week: parseInt(submissions.rows[0].last_week),
      },
      bySchool:       schools.rows,
      recentActivity: activity.rows,
    });
  } catch(e) {
    console.error('[SUPERADMIN STATS]', e.message);
    res.status(500).json({ success:false, message:'Erreur serveur.' });
  }
});

// ── GET /api/superadmin/universities ─────────────────────────
// Liste toutes les universités avec leurs admins
router.get('/universities', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT school,
        COUNT(*) FILTER (WHERE role='etudiant')   AS students,
        COUNT(*) FILTER (WHERE role='enseignant') AS teachers,
        COUNT(*) FILTER (WHERE role='admin')      AS admins,
        (SELECT COUNT(*) FROM courses WHERE courses.school=u.school) AS courses,
        (SELECT COUNT(*) FROM communities WHERE communities.school=u.school) AS communities,
        (SELECT json_agg(json_build_object('id',id,'name',first_name||' '||last_name,'email',email))
         FROM users WHERE school=u.school AND role='admin') AS admin_list
      FROM users u WHERE school IS NOT NULL
      GROUP BY school ORDER BY students DESC`);
    res.json({ success:true, universities: r.rows });
  } catch(e) {
    res.status(500).json({ success:false, message:'Erreur serveur.' });
  }
});

// ── POST /api/superadmin/admin ────────────────────────────────
// Créer un admin d'université
router.post('/admin', async (req, res) => {
  try {
    const { first_name, last_name, email, password, school } = req.body;
    if (!first_name||!last_name||!email||!password||!school) {
      return res.status(400).json({ success:false, message:'Tous les champs sont requis.' });
    }
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      `INSERT INTO users (first_name,last_name,email,password_hash,role,school,is_active)
       VALUES ($1,$2,$3,$4,'admin',$5,true)
       RETURNING id,first_name,last_name,email,role,school`,
      [first_name,last_name,email.toLowerCase(),hash,school]
    );
    res.status(201).json({ success:true, user:r.rows[0] });
  } catch(e) {
    if (e.code==='23505') return res.status(409).json({ success:false, message:'Email déjà utilisé.' });
    res.status(500).json({ success:false, message:'Erreur serveur.' });
  }
});

// ── PUT /api/superadmin/university/:school/suspend ────────────
// Suspendre/réactiver toute une université
router.put('/university/:school/suspend', async (req, res) => {
  try {
    const { suspend } = req.body; // true = suspendre
    const school = decodeURIComponent(req.params.school);
    await pool.query(
      `UPDATE users SET is_active=$1 WHERE school=$2 AND role != 'superadmin'`,
      [!suspend, school]
    );
    res.json({ success:true, message: suspend
      ? `Université "${school}" suspendue.`
      : `Université "${school}" réactivée.` });
  } catch(e) {
    res.status(500).json({ success:false, message:'Erreur serveur.' });
  }
});

// ── GET /api/superadmin/logs ──────────────────────────────────
// Activité récente globale
router.get('/logs', async (req, res) => {
  try {
    const [newUsers, newCourses, newSubmissions, newPosts] = await Promise.all([
      pool.query(`SELECT u.first_name||' '||u.last_name AS name, u.role, u.school, u.email,
                         u.created_at AS date, 'inscription' AS type
                  FROM users u ORDER BY created_at DESC LIMIT 15`),
      pool.query(`SELECT c.title AS name, c.school, c.filiere,
                         u.first_name||' '||u.last_name AS author,
                         c.created_at AS date, 'nouveau_cours' AS type
                  FROM courses c JOIN users u ON c.teacher_id=u.id
                  ORDER BY c.created_at DESC LIMIT 10`),
      pool.query(`SELECT u.first_name||' '||u.last_name AS name, a.title AS content,
                         c.school, sub.submitted_at AS date, 'soumission' AS type
                  FROM assignment_submissions sub
                  JOIN users u ON sub.student_id=u.id
                  JOIN assignments a ON sub.assignment_id=a.id
                  JOIN courses c ON a.course_id=c.id
                  ORDER BY sub.submitted_at DESC LIMIT 10`),
      pool.query(`SELECT u.first_name||' '||u.last_name AS name, LEFT(p.content,60) AS content,
                         cm.school, p.created_at AS date, 'post_communaute' AS type
                  FROM community_posts p
                  JOIN users u ON p.user_id=u.id
                  JOIN communities cm ON p.community_id=cm.id
                  ORDER BY p.created_at DESC LIMIT 10`),
    ]);
    const logs = [
      ...newUsers.rows,
      ...newCourses.rows,
      ...newSubmissions.rows,
      ...newPosts.rows,
    ].sort((a,b) => new Date(b.date)-new Date(a.date)).slice(0,40);
    res.json({ success:true, logs });
  } catch(e) {
    res.status(500).json({ success:false, message:'Erreur serveur.' });
  }
});

// ── DELETE /api/superadmin/user/:id ──────────────────────────
router.delete('/user/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1 AND role != \'superadmin\'', [req.params.id]);
    res.json({ success:true });
  } catch(e) {
    res.status(500).json({ success:false, message:'Erreur serveur.' });
  }
});

// ── POST /api/superadmin/impersonate/:id ─────────────────────
// Se connecter en tant qu'un utilisateur pour débugger
router.post('/impersonate/:id', async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const SECRET = process.env.JWT_SECRET || 'camunolearn_secret_dev';
    const r = await pool.query('SELECT id,email,role,school,first_name,last_name FROM users WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success:false, message:'Utilisateur introuvable.' });
    const u = r.rows[0];
    const token = jwt.sign(
      { id:u.id, email:u.email, role:u.role, school:u.school, impersonated_by: req.user.id },
      SECRET, { expiresIn:'2h' }
    );
    res.json({ success:true, token, user:u, warning:'Token d\'impersonation — expire dans 2h.' });
  } catch(e) {
    res.status(500).json({ success:false, message:'Erreur serveur.' });
  }
});


// ── GET /api/superadmin/users ─────────────────────────
router.get('/users', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, first_name, last_name, email, role, school, is_active, created_at
       FROM users
       WHERE role != 'superadmin'
       ORDER BY created_at DESC
       LIMIT 500`
    );
    res.json({ success: true, users: r.rows });
  } catch(e) {
    console.error('[SUPERADMIN /users]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});


// ── GET /api/superadmin/search ────────────────────────────────
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ success: true, results: [] });

    const r = await pool.query(`
      SELECT id, first_name, last_name, email, role, school, filiere, is_active, created_at
      FROM users
      WHERE role != 'superadmin'
        AND (
          LOWER(first_name || ' ' || last_name) LIKE LOWER($1)
          OR LOWER(email) LIKE LOWER($1)
          OR LOWER(school) LIKE LOWER($1)
          OR LOWER(filiere) LIKE LOWER($1)
        )
      ORDER BY created_at DESC
      LIMIT 50
    `, ['%' + q + '%']);

    res.json({ success: true, results: r.rows });
  } catch(e) {
    console.error('[SA /search]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /api/superadmin/metrics/:school ───────────────────────
router.get('/metrics/:school', async (req, res) => {
  try {
    const school = decodeURIComponent(req.params.school);

    const [users, courses, assignments, submissions, communities, enrollments] = await Promise.all([
      pool.query(`SELECT role, COUNT(*) as cnt, DATE_TRUNC('month', created_at) as month
        FROM users WHERE school=$1 GROUP BY role, month ORDER BY month`, [school]),
      pool.query(`SELECT COUNT(*) as total, DATE_TRUNC('month', created_at) as month
        FROM courses WHERE school=$1 GROUP BY month ORDER BY month`, [school]),
      pool.query(`SELECT COUNT(*) as total FROM assignments a
        JOIN courses c ON a.course_id=c.id WHERE c.school=$1`, [school]),
      pool.query(`SELECT COUNT(*) as total, ROUND(AVG(grade)::numeric,1) as avg_grade,
        COUNT(CASE WHEN grade IS NOT NULL THEN 1 END) as graded
        FROM assignment_submissions sub
        JOIN assignments a ON sub.assignment_id=a.id
        JOIN courses c ON a.course_id=c.id WHERE c.school=$1`, [school]),
      pool.query(`SELECT COUNT(*) as total FROM communities WHERE school=$1`, [school]),
      pool.query(`SELECT COUNT(*) as total FROM enrollments e
        JOIN courses c ON e.course_id=c.id WHERE c.school=$1`, [school]),
    ]);

    // Nouveaux inscrits par mois (6 derniers mois)
    const monthly = await pool.query(`
      SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YYYY') as month,
             COUNT(*) as count
      FROM users WHERE school=$1
        AND created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at)
    `, [school]);

    res.json({
      success: true,
      school,
      metrics: {
        users:       users.rows,
        courses:     courses.rows,
        assignments: assignments.rows[0],
        submissions: submissions.rows[0],
        communities: communities.rows[0],
        enrollments: enrollments.rows[0],
        monthly:     monthly.rows,
      }
    });
  } catch(e) {
    console.error('[SA /metrics]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── POST /api/superadmin/teacher ──────────────────────────────
router.post('/teacher', async (req, res) => {
  try {
    const { first_name, last_name, email, password, school, discipline } = req.body;
    if (!first_name || !last_name || !email || !password || !school) {
      return res.status(400).json({ success: false, message: 'Champs requis manquants.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const pin  = Math.floor(100000 + Math.random() * 900000).toString();

    const r = await pool.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role, school, discipline, activation_pin, is_active)
       VALUES ($1,$2,$3,$4,'enseignant',$5,$6,$7,true)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, role`,
      [first_name, last_name, email, hash, school, discipline||null, pin]
    );

    if (!r.rows.length) return res.status(409).json({ success: false, message: 'Email déjà utilisé.' });
    res.json({ success: true, message: 'Professeur créé.', pin, user: r.rows[0] });
  } catch(e) {
    console.error('[SA /teacher]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── DELETE /api/superadmin/community/:id ──────────────────────
router.delete('/community/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM communities WHERE id=$1::uuid', [req.params.id]);
    res.json({ success: true, message: 'Communauté supprimée.' });
  } catch(e) {
    console.error('[SA /community]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /api/superadmin/communities ───────────────────────────
router.get('/communities', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.id, c.name, c.description, c.category, c.school, c.created_at,
             u.first_name||' '||u.last_name AS teacher_name,
             COUNT(cm.user_id) AS member_count
      FROM communities c
      LEFT JOIN users u ON c.teacher_id=u.id
      LEFT JOIN community_members cm ON cm.community_id=c.id
      GROUP BY c.id, u.first_name, u.last_name
      ORDER BY c.created_at DESC
    `);
    res.json({ success: true, communities: r.rows });
  } catch(e) {
    console.error('[SA /communities]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── DELETE /api/superadmin/user/:id ───────────────────────────
router.delete('/user/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM users WHERE id=$1::uuid AND role != 'superadmin' RETURNING email, role`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
    res.json({ success: true, message: 'Utilisateur supprimé : ' + r.rows[0].email });
  } catch(e) {
    console.error('[SA /user delete]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── PUT /api/superadmin/user/:id/toggle ───────────────────────
router.put('/user/:id/toggle', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE users SET is_active = NOT COALESCE(is_active, true)
       WHERE id=$1::uuid AND role != 'superadmin'
       RETURNING email, is_active`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Introuvable.' });
    res.json({ success: true, is_active: r.rows[0].is_active, email: r.rows[0].email });
  } catch(e) {
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});


// ── GET /api/superadmin/pricing-leads ─────────────────────────
router.get('/pricing-leads', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, email, plan, school, message, contacted, created_at
      FROM pricing_leads
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json({ success: true, leads: r.rows });
  } catch(e) {
    res.status(500).json({ success: false, message: 'Table pricing_leads non créée.', leads: [] });
  }
});

// ── PUT /api/superadmin/pricing-leads/:id/contacted ────────────
router.put('/pricing-leads/:id/contacted', async (req, res) => {
  try {
    await pool.query(
      'UPDATE pricing_leads SET contacted=true WHERE id=$1::uuid',
      [req.params.id]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false });
  }
});


// ════════════════════════════════════════════════════════════
//  ABONNEMENTS — Gestion commerciale des universités
// ════════════════════════════════════════════════════════════

const PLAN_PRICES = {
  decouverte: 0,
  starter:    19900,
  pro:        49000,
  universite: 120000,
  reseau:     350000,
};

const PLAN_LABELS = {
  decouverte: 'Découverte',
  starter:    'Starter',
  pro:        'Pro',
  universite: 'Université',
  reseau:     'Réseau National',
};

// ── GET /api/superadmin/subscriptions ─────────────────────────
router.get('/subscriptions', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*,
        CASE
          WHEN s.status = 'active'    AND s.expires_at > NOW()  THEN 'active'
          WHEN s.status = 'trial'                                THEN 'trial'
          WHEN s.status = 'suspended'                            THEN 'suspended'
          WHEN s.expires_at < NOW()                              THEN 'expired'
          ELSE s.status
        END AS computed_status,
        EXTRACT(DAY FROM s.expires_at - NOW()) AS days_remaining
      FROM subscriptions s
      ORDER BY s.created_at DESC
    `);
    res.json({ success: true, subscriptions: r.rows });
  } catch(e) {
    console.error('[SA /subscriptions]', e.message);
    res.status(500).json({ success: false, message: 'Table subscriptions non créée. Exécutez le script SQL.' });
  }
});

// ── POST /api/superadmin/subscriptions ────────────────────────
// Créer ou renouveler un abonnement
router.post('/subscriptions', async (req, res) => {
  try {
    const { school, plan, billing, notes, months } = req.body;
    if (!school || !plan) {
      return res.status(400).json({ success: false, message: 'École et plan requis.' });
    }

    const amount   = PLAN_PRICES[plan] || 0;
    const duration = months || (billing === 'yearly' ? 12 : 1);
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + duration);

    const r = await pool.query(
      `INSERT INTO subscriptions (school, plan, status, amount, billing, started_at, expires_at, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
       RETURNING *`,
      [school, plan, plan === 'decouverte' ? 'trial' : 'active',
       billing === 'yearly' ? Math.round(amount * 12 * 0.8) : amount,
       billing || 'monthly', expiresAt, notes || null, req.user.id]
    );

    res.json({ success: true, subscription: r.rows[0], message: `Abonnement ${PLAN_LABELS[plan]} activé pour "${school}"` });
  } catch(e) {
    console.error('[SA POST /subscriptions]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── PUT /api/superadmin/subscriptions/:id ─────────────────────
// Modifier un abonnement (changer plan, statut, renouveler)
router.put('/subscriptions/:id', async (req, res) => {
  try {
    const { plan, status, notes, months } = req.body;

    let sets = [], vals = [], i = 1;
    if (plan)   { sets.push(`plan=$${i++}`);   vals.push(plan); }
    if (status) { sets.push(`status=$${i++}`); vals.push(status); }
    if (notes !== undefined) { sets.push(`notes=$${i++}`); vals.push(notes); }
    if (months) {
      const exp = new Date();
      exp.setMonth(exp.getMonth() + parseInt(months));
      sets.push(`expires_at=$${i++}`, `renewed_at=NOW()`);
      vals.push(exp);
    }
    sets.push(`updated_at=NOW()`);
    vals.push(req.params.id);

    const r = await pool.query(
      `UPDATE subscriptions SET ${sets.join(',')} WHERE id=$${i}::uuid RETURNING *`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Abonnement introuvable.' });
    res.json({ success: true, subscription: r.rows[0] });
  } catch(e) {
    console.error('[SA PUT /subscriptions]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── DELETE /api/superadmin/subscriptions/:id ──────────────────
router.delete('/subscriptions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM subscriptions WHERE id=$1::uuid', [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false });
  }
});

// ── GET /api/superadmin/subscriptions/stats ───────────────────
// Revenus et métriques commerciales
router.get('/subscriptions/stats', async (req, res) => {
  try {
    const [revenue, byPlan, expiringSoon] = await Promise.all([
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE status='active') AS active_count,
        COUNT(*) FILTER (WHERE status='trial')  AS trial_count,
        SUM(amount) FILTER (WHERE status='active') AS monthly_revenue,
        COUNT(*) FILTER (WHERE expires_at < NOW() + INTERVAL '7 days' AND status='active') AS expiring_soon
        FROM subscriptions`),
      pool.query(`SELECT plan, COUNT(*) as count, SUM(amount) as total
        FROM subscriptions WHERE status='active' GROUP BY plan`),
      pool.query(`SELECT school, plan, expires_at,
        EXTRACT(DAY FROM expires_at - NOW()) AS days_left
        FROM subscriptions WHERE status='active'
        AND expires_at < NOW() + INTERVAL '7 days'
        ORDER BY expires_at ASC LIMIT 10`),
    ]);
    res.json({
      success: true,
      revenue: revenue.rows[0],
      byPlan:  byPlan.rows,
      expiringSoon: expiringSoon.rows,
    });
  } catch(e) {
    res.status(500).json({ success: false, message: 'Erreur stats.', revenue:{}, byPlan:[], expiringSoon:[] });
  }
});


// ════════════════════════════════════════════════════════════
//  DELETE EN MASSE
// ════════════════════════════════════════════════════════════

// ── DELETE /api/superadmin/university/:school ─────────────────
// Supprimer une université et optionnellement ses utilisateurs
router.delete('/university/:school', async (req, res) => {
  try {
    const school = decodeURIComponent(req.params.school);
    // Supprimer les utilisateurs de cette école (sauf superadmin)
    await pool.query(
      "DELETE FROM users WHERE school=$1 AND role != 'superadmin'",
      [school]
    );
    res.json({ success: true, message: `Université "${school}" supprimée.` });
  } catch(e) {
    console.error('[SA DELETE /university]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── DELETE /api/superadmin/logs ───────────────────────────────
// Vider les logs (si table existe)
router.delete('/logs', async (req, res) => {
  try {
    // Essayer de vider la table logs si elle existe
    await pool.query('TRUNCATE TABLE activity_logs RESTART IDENTITY CASCADE');
    res.json({ success: true });
  } catch(e) {
    // Table peut ne pas exister
    res.json({ success: true, message: 'Logs nettoyés.' });
  }
});

module.exports = router;