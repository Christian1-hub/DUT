// src/routes/auth.js
const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

const SECRET = process.env.JWT_SECRET || 'camunolearn_secret_dev';
const mkToken = (user) => jwt.sign(
  { id: user.id, email: user.email, role: user.role, school: user.school },
  SECRET, { expiresIn: '7d' }
);

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { first_name, last_name, email, password, bio } = req.body;
    if (!first_name?.trim() || !last_name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ success: false, message: 'Tous les champs sont obligatoires.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Mot de passe trop court (min 8 caractères).' });
    }
    const exists = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    if (exists.rows.length) {
      return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé.' });
    }
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, bio)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, first_name, last_name, email, role, school, filiere, bio, created_at`,
      [first_name.trim(), last_name.trim(), email.toLowerCase().trim(), hash, bio||null]
    );
    const user = r.rows[0];
    const token = mkToken(user);
    res.status(201).json({ success: true, token, user, needsRole: true });
  } catch(e) {
    console.error('[REGISTER]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email et mot de passe requis.' });
    }
    const r = await pool.query(
      `SELECT id, first_name, last_name, email, password_hash, role, school, filiere, discipline, created_at
       FROM users WHERE email=$1`,
      [email.toLowerCase().trim()]
    );
    if (!r.rows.length) {
      return res.status(401).json({ success: false, message: 'Email ou mot de passe incorrect.' });
    }
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ success: false, message: 'Email ou mot de passe incorrect.' });
    }
    delete user.password_hash;
    const token = mkToken(user);
    const needsRole   = !user.role || user.role === 'etudiant';
    const needsSchool = !user.school;
    res.json({ success: true, token, user, needsRole, needsSchool });
  } catch(e) {
    console.error('[LOGIN]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// PUT /api/auth/role — nouveau token avec rôle mis à jour
router.put('/role', auth, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['etudiant','enseignant','admin'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Rôle invalide.' });
    }
    // PROTECTION: ne jamais écraser le rôle superadmin
    const currentUser = await pool.query(
      'SELECT role FROM users WHERE id=$1', [req.user.id]
    );
    if (currentUser.rows[0]?.role === 'superadmin') {
      return res.status(403).json({ success: false, message: 'Impossible de modifier le rôle superadmin.' });
    }
    const r = await pool.query(
      `UPDATE users SET role=$1 WHERE id=$2
       RETURNING id, first_name, last_name, email, role, school, filiere`,
      [role, req.user.id]
    );
    const user = r.rows[0];
    const token = mkToken(user);
    res.json({ success: true, token, user });
  } catch(e) {
    console.error('[ROLE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// PUT /api/auth/school — nouveau token avec école, filière et niveau
router.put('/school', auth, async (req, res) => {
  try {
    const { school, filiere, level } = req.body;
    if (!school?.trim()) return res.status(400).json({ success: false, message: 'École requise.' });

    const r = await pool.query(
      `UPDATE users SET school=$1, filiere=COALESCE($2, filiere)
       WHERE id=$3
       RETURNING id, first_name, last_name, email, role, school, filiere`,
      [school.trim(), filiere||null, req.user.id]
    );
    const user = r.rows[0];
    const token = mkToken(user);

    // Si étudiant avec filière → l'inscrire automatiquement dans les classes correspondantes
    if (user.role === 'etudiant' && filiere) {
      await autoEnrollStudent(user.id, school.trim(), filiere, level);
    }

    res.json({ success: true, token, user });
  } catch(e) {
    console.error('[SCHOOL]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// Inscription automatique de l'étudiant dans les classes de sa filière/école
async function autoEnrollStudent(studentId, school, filiere, level) {
  try {
    // ── ÉTAPE 1 : Inscrire dans les classes de sa filière/école ──────────
    let classQuery = `SELECT id FROM classes WHERE school=$1 AND filiere=$2`;
    const classParams = [school, filiere];
    if (level) {
      classQuery += ` AND (level=$3 OR level IS NULL)`;
      classParams.push(level);
    }
    const classes = await pool.query(classQuery, classParams);

    for (const cls of classes.rows) {
      await pool.query(
        `INSERT INTO class_members (class_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [cls.id, studentId]
      );
      // Inscrire dans tous les cours de cette classe
      const cours = await pool.query(`SELECT id FROM courses WHERE class_id=$1`, [cls.id]);
      for (const c of cours.rows) {
        await pool.query(
          `INSERT INTO enrollments (student_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [studentId, c.id]
        );
      }
    }

    // ── ÉTAPE 2 : Inscrire aussi dans les cours sans classe mais de la même école/filière ──
    // Ex: prof publie un cours filière="GEII L2" sans le lier à une classe explicite
    await pool.query(`
      INSERT INTO enrollments (student_id, course_id)
      SELECT $1, c.id FROM courses c
      WHERE c.school = $2
        AND (c.filiere = $3 OR c.filiere IS NULL)
        AND c.class_id IS NULL  -- cours non liés à une classe spécifique
        AND NOT EXISTS (
          SELECT 1 FROM enrollments e
          WHERE e.student_id=$1 AND e.course_id=c.id
        )
      ON CONFLICT DO NOTHING`,
      [studentId, school, filiere]
    );

    console.log(`[AUTO-ENROLL] Étudiant ${studentId} inscrit dans ${classes.rows.length} classe(s) + cours libres (${filiere}, ${school})`);
  } catch(e) {
    console.error('[AUTO-ENROLL]', e.message);
  }
}

// GET /api/auth/me — rafraîchir le token
router.get('/me', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, first_name, last_name, email, role, school, filiere, 
              bio, phone, avatar_url, discipline, niveau, created_at
       FROM users WHERE id=$1`,
      [req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
    const user = r.rows[0];
    const token = mkToken(user);
    res.json({ success: true, token, user });
  } catch(e) {
    console.error('[ME]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── PUT /api/auth/avatar — Mettre à jour la photo de profil
router.put('/avatar', auth, async (req, res) => {
  try {
    const { avatar_url } = req.body;
    if (!avatar_url) return res.status(400).json({ success:false, message:'URL requise.' });
    const r = await pool.query(
      'UPDATE users SET avatar_url=$1 WHERE id=$2 RETURNING id, avatar_url',
      [avatar_url, req.user.id]
    );
    const token = require('jsonwebtoken').sign(
      { id: req.user.id, email: req.user.email, role: req.user.role, school: req.user.school },
      process.env.JWT_SECRET || 'camunolearn_secret_dev', { expiresIn: '7d' }
    );
    res.json({ success:true, avatar_url: r.rows[0].avatar_url, token });
  } catch(e) {
    console.error('[AVATAR]', e.message);
    res.status(500).json({ success:false, message:'Erreur serveur.' });
  }
});


// ── POST /api/auth/contact — Message d'aide
router.post('/contact', async (req, res) => {
  try {
    const { email, message, name } = req.body;
    if (!email || !message) {
      return res.status(400).json({ success: false, message: 'Email et message requis.' });
    }
    // Logger le message (en production on enverrait un email)
    console.log(`[CONTACT] De: ${email} | Message: ${message.substring(0, 100)}`);
    // On pourrait stocker en BDD mais pour l'instant on logue
    res.json({ success: true, message: 'Message reçu ! Nous vous répondrons dans les 24h.' });
  } catch(e) {
    console.error('[CONTACT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});


// ── POST /api/auth/fix-superadmin ──────────────────────────────
// Correction d'urgence du rôle superadmin (protégée par JWT valide)
router.post('/fix-superadmin', auth, async (req, res) => {
  try {
    // Vérifier que l'email correspond bien au compte superadmin officiel
    const SA_EMAIL = 'superadmin@camunolearn.cm';
    const current = await pool.query('SELECT email, role FROM users WHERE id=$1', [req.user.id]);
    if (!current.rows.length) {
      return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
    }
    const u = current.rows[0];
    if (u.email !== SA_EMAIL) {
      return res.status(403).json({ success: false, message: 'Seul le compte superadmin officiel peut utiliser cette route.' });
    }
    // Forcer le rôle superadmin
    const r = await pool.query(
      `UPDATE users SET role='superadmin', is_active=true WHERE id=$1
       RETURNING id, first_name, last_name, email, role, school`,
      [req.user.id]
    );
    const user = r.rows[0];
    const token = mkToken(user);
    console.log('[FIX-SUPERADMIN] Rôle corrigé pour', user.email);
    res.json({ success: true, token, user });
  } catch(e) {
    console.error('[FIX-SUPERADMIN]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;

// ── POST /api/auth/activate — Activation compte prof avec PIN
router.post('/activate', async (req, res) => {
  try {
    const { email, pin } = req.body;
    if (!email || !pin) return res.status(400).json({ success:false, message:'Email et PIN requis.' });

    const r = await pool.query(
      `SELECT id, first_name, last_name, email, role, school, activation_pin, pin_used
       FROM users WHERE email=$1`, [email.toLowerCase()]
    );
    if (!r.rows.length) return res.status(404).json({ success:false, message:'Compte introuvable.' });

    const u = r.rows[0];
    if (u.pin_used) return res.status(400).json({ success:false, message:'Ce PIN a déjà été utilisé. Contactez votre administrateur.' });
    if (u.activation_pin !== pin) return res.status(401).json({ success:false, message:'PIN incorrect.' });

    // Activer le compte
    await pool.query(
      `UPDATE users SET pin_used=true, is_active=true WHERE id=$1`, [u.id]
    );
    const token = jwt.sign(
      { id:u.id, email:u.email, role:u.role, school:u.school },
      SECRET, { expiresIn:'7d' }
    );
    res.json({ success:true, token, user:u, message:'Compte activé ! Bienvenue sur CamunoLearn.' });
  } catch(e) {
    console.error('[ACTIVATE]', e.message);
    res.status(500).json({ success:false, message:'Erreur serveur.' });
  }
});


// ── POST /api/auth/contact — Message d'aide
router.post('/contact', async (req, res) => {
  try {
    const { email, message, name } = req.body;
    if (!email || !message) {
      return res.status(400).json({ success: false, message: 'Email et message requis.' });
    }
    // Logger le message (en production on enverrait un email)
    console.log(`[CONTACT] De: ${email} | Message: ${message.substring(0, 100)}`);
    // On pourrait stocker en BDD mais pour l'instant on logue
    res.json({ success: true, message: 'Message reçu ! Nous vous répondrons dans les 24h.' });
  } catch(e) {
    console.error('[CONTACT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;

// ── POST /api/auth/pricing-interest ─────────────────────────
// Enregistre l'intérêt d'un visiteur pour un plan tarifaire
router.post('/pricing-interest', async (req, res) => {
  try {
    const { email, plan, school, message } = req.body;
    if (!email || !plan) {
      return res.status(400).json({ success: false, message: 'Email et plan requis.' });
    }

    // Stocker dans une table pricing_leads (à créer avec le SQL ci-dessous)
    await pool.query(
      `INSERT INTO pricing_leads (email, plan, school, message, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (email) DO UPDATE SET
         plan = EXCLUDED.plan,
         school = EXCLUDED.school,
         message = EXCLUDED.message,
         updated_at = NOW()`,
      [email, plan, school || null, message || null]
    );

    console.log(`[PRICING LEAD] ${email} → Plan ${plan} (${school || 'N/A'})`);
    res.json({ success: true, message: 'Votre intérêt a bien été enregistré. Notre équipe vous contacte sous 24h.' });
  } catch(e) {
    // Si la table n'existe pas encore, on logue juste
    console.log(`[PRICING LEAD - no table yet] ${req.body.email} → ${req.body.plan}`);
    res.json({ success: true, message: 'Message reçu ! Nous vous contactons sous 24h.' });
  }
});
