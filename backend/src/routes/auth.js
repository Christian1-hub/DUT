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

// ═══════════════════════════════════════════════════════
// QR SESSION (intégré ici pour éviter les problèmes de module)
// ═══════════════════════════════════════════════════════
const qrSessions = new Map();

// POST /api/auth/qr/create
router.post('/qr/create', (req, res) => {
  const { v4: uuidv4 } = require('crypto');
  const sessionId = uuidv4 ? uuidv4() : require('crypto').randomUUID();
  qrSessions.set(sessionId, { status: 'pending', role: null, createdAt: Date.now() });
  setTimeout(() => qrSessions.delete(sessionId), 5 * 60 * 1000);
  res.json({ success: true, sessionId });
});

// POST /api/auth/qr/validate/:sessionId
router.post('/qr/validate/:sessionId', async (req, res) => {
  const session = qrSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ success: false, message: 'QR expiré ou invalide.' });
  if (session.status === 'validated') return res.status(400).json({ success: false, message: 'QR déjà utilisé.' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Non authentifié.' });

  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), SECRET);
    const r = await pool.query('SELECT role FROM users WHERE id=$1', [decoded.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
    const realRole = r.rows[0].role;
    session.status = 'validated';
    session.role = realRole;
    qrSessions.set(req.params.sessionId, session);
    res.json({ success: true, role: realRole });
  } catch(e) {
    res.status(401).json({ success: false, message: 'Token invalide.' });
  }
});

// GET /api/auth/qr/status/:sessionId
router.get('/qr/status/:sessionId', (req, res) => {
  const session = qrSessions.get(req.params.sessionId);
  if (!session) return res.json({ status: 'expired' });
  res.json({ status: session.status, role: session.role });
});

// ═══════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════

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

// PUT /api/auth/role
router.put('/role', auth, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['etudiant','enseignant','admin'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Rôle invalide.' });
    }
    const currentUser = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]);
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

// PUT /api/auth/school
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
    if (user.role === 'etudiant' && filiere) {
      await autoEnrollStudent(user.id, school.trim(), filiere, level);
    }
    if (user.role === 'enseignant') {
      await pool.query(`UPDATE classes SET school=$1 WHERE teacher_id=$2 AND (school IS NULL OR school='')`, [school.trim(), req.user.id]);
      await pool.query(`UPDATE courses SET school=$1 WHERE teacher_id=$2 AND (school IS NULL OR school='')`, [school.trim(), req.user.id]);
    }
    res.json({ success: true, token, user });
  } catch(e) {
    console.error('[SCHOOL]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

async function autoEnrollStudent(studentId, school, filiere, level) {
  try {
    let classQuery = `SELECT id FROM classes WHERE school=$1 AND filiere=$2`;
    const classParams = [school, filiere];
    if (level) { classQuery += ` AND (level=$3 OR level IS NULL)`; classParams.push(level); }
    const classes = await pool.query(classQuery, classParams);
    for (const cls of classes.rows) {
      await pool.query(`INSERT INTO class_members (class_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cls.id, studentId]);
      const cours = await pool.query(`SELECT id FROM courses WHERE class_id=$1`, [cls.id]);
      for (const c of cours.rows) {
        await pool.query(`INSERT INTO enrollments (student_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [studentId, c.id]);
      }
    }
    await pool.query(`
      INSERT INTO enrollments (student_id, course_id)
      SELECT $1, c.id FROM courses c
      WHERE c.school=$2 AND (c.filiere=$3 OR c.filiere IS NULL) AND c.class_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id=$1 AND e.course_id=c.id)
      ON CONFLICT DO NOTHING`, [studentId, school, filiere]);
  } catch(e) {
    console.error('[AUTO-ENROLL]', e.message);
  }
}

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, first_name, last_name, email, role, school, filiere,
              bio, phone, avatar_url, discipline, niveau, created_at
       FROM users WHERE id=$1`, [req.user.id]
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

// PUT /api/auth/avatar
router.put('/avatar', auth, async (req, res) => {
  try {
    const { avatar_url } = req.body;
    if (!avatar_url) return res.status(400).json({ success:false, message:'URL requise.' });
    const r = await pool.query('UPDATE users SET avatar_url=$1 WHERE id=$2 RETURNING id, avatar_url', [avatar_url, req.user.id]);
    const token = mkToken(req.user);
    res.json({ success:true, avatar_url: r.rows[0].avatar_url, token });
  } catch(e) {
    console.error('[AVATAR]', e.message);
    res.status(500).json({ success:false, message:'Erreur serveur.' });
  }
});

// POST /api/auth/contact
router.post('/contact', async (req, res) => {
  try {
    const { email, message } = req.body;
    if (!email || !message) return res.status(400).json({ success: false, message: 'Email et message requis.' });
    console.log(`[CONTACT] De: ${email} | Message: ${message.substring(0, 100)}`);
    res.json({ success: true, message: 'Message reçu ! Nous vous répondrons dans les 24h.' });
  } catch(e) {
    console.error('[CONTACT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// POST /api/auth/activate
router.post('/activate', async (req, res) => {
  try {
    const { email, pin } = req.body;
    if (!email || !pin) return res.status(400).json({ success:false, message:'Email et PIN requis.' });
    const r = await pool.query(
      `SELECT id, first_name, last_name, email, role, school, pin_code, pin_used FROM users WHERE email=$1`,
      [email.toLowerCase()]
    );
    if (!r.rows.length) return res.status(404).json({ success:false, message:'Compte introuvable.' });
    const u = r.rows[0];
    if (u.pin_used) return res.status(400).json({ success:false, message:'Ce PIN a déjà été utilisé.' });
    if (u.pin_code !== pin) return res.status(401).json({ success:false, message:'PIN incorrect.' });
    await pool.query(`UPDATE users SET pin_used=true, is_active=true WHERE id=$1`, [u.id]);
    const token = mkToken(u);
    res.json({ success:true, token, user:u, message:'Compte activé ! Bienvenue.' });
  } catch(e) {
    console.error('[ACTIVATE]', e.message);
    res.status(500).json({ success:false, message:'Erreur serveur.' });
  }
});

// POST /api/auth/fix-superadmin
router.post('/fix-superadmin', auth, async (req, res) => {
  try {
    const SA_EMAIL = 'superadmin@camunolearn.cm';
    const current = await pool.query('SELECT email, role FROM users WHERE id=$1', [req.user.id]);
    if (!current.rows.length) return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
    if (current.rows[0].email !== SA_EMAIL) return res.status(403).json({ success: false, message: 'Accès refusé.' });
    const r = await pool.query(
      `UPDATE users SET role='superadmin', is_active=true WHERE id=$1 RETURNING id, first_name, last_name, email, role, school`,
      [req.user.id]
    );
    const token = mkToken(r.rows[0]);
    res.json({ success: true, token, user: r.rows[0] });
  } catch(e) {
    console.error('[FIX-SUPERADMIN]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// POST /api/auth/pricing-interest
router.post('/pricing-interest', async (req, res) => {
  try {
    const { email, plan, school, message } = req.body;
    if (!email || !plan) return res.status(400).json({ success: false, message: 'Email et plan requis.' });
    try {
      await pool.query(
        `INSERT INTO pricing_leads (email, plan, school, message, created_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (email) DO UPDATE SET plan=EXCLUDED.plan, school=EXCLUDED.school, message=EXCLUDED.message, updated_at=NOW()`,
        [email, plan, school||null, message||null]
      );
    } catch(e) { console.log(`[PRICING LEAD] ${email} → ${plan}`); }
    res.json({ success: true, message: 'Votre intérêt a bien été enregistré.' });
  } catch(e) {
    res.json({ success: true, message: 'Message reçu !' });
  }
});

module.exports = router;