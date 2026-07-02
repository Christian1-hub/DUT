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


// POST /api/auth/verify-code — codes réutilisables hardcodés
router.post('/verify-code', async (req, res) => {
  try {
    const { code, role, sessionId, user_info } = req.body;
    if (!code || !role) return res.status(400).json({ success: false, message: 'Code et rôle requis.' });

    const PROF_CODES  = ['2H8L','3VQH','4F9C','4JQ5','7WSK','AJDD','AKTD','BKWJ','BZR7','C8G9',
      'DYXQ','EFXB','FYWL','G4UF','G92Z','HNPK','L2L4','ML82','MNHF','NWGA',
      'P4UW','PLC2','QEFV','RDEU','S2RJ','SMXY','W3VX','WN3T','XCZE','XNYY'];
    const ADMIN_CODES = ['23P4ZE','2V7MWQ','47WCAC','4N79LD','5BLMHW','5P6L26','5V8J2Q','74YUUY','7R2DVA','9BG62G',
      '9JEGR5','DDG3V3','DZRZ6X','EXQHC7','FBGA76','KLMGY6','KVMREC','MHG89Y','MMC45Y','MNMQL3',
      'PDDSVN','PLXUDC','RW9CMV','U8MY32','USLLXM','V9WBB2','VWND5X','X8HU6N','YES68T','YXDJNU'];

    const codeUp     = code.toUpperCase().trim();
    const validCodes = role === 'enseignant' ? PROF_CODES : ADMIN_CODES;

    if (!validCodes.includes(codeUp)) {
      return res.status(401).json({ success: false, message: 'Code invalide.' });
    }

    const firstName = user_info?.first_name || '';
    const lastName  = user_info?.last_name  || '';
    const email     = user_info?.email      || '';

    await pool.query(
      `INSERT INTO role_requests (requested_role, session_id, status, user_email, user_name, created_at)
       VALUES ($1, $2, 'pending', $3, $4, NOW())
       ON CONFLICT (session_id) DO UPDATE SET requested_role=$1, status='pending', created_at=NOW()`,
      [role, sessionId || null, email, (firstName + ' ' + lastName).trim()]
    );

    console.log('[VERIFY-CODE]', email, '→', role, codeUp);
    res.json({ success: true, message: 'Code valide !' });
  } catch(e) {
    console.error('[VERIFY-CODE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});


// GET /api/auth/role-requests — liste des demandes en attente (SuperAdmin)
router.get('/role-requests', auth, async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') return res.status(403).json({ success: false, message: 'Accès refusé.' });
    const r = await pool.query(
      `SELECT rr.id, rr.requested_role, rr.session_id, rr.status, rr.created_at,
              COALESCE(u.first_name, split_part(rr.user_name, ' ', 1)) AS first_name,
              COALESCE(u.last_name,  split_part(rr.user_name, ' ', 2)) AS last_name,
              COALESCE(u.email, rr.user_email) AS email,
              COALESCE(u.school, '') AS school
       FROM role_requests rr
       LEFT JOIN users u ON u.id = rr.user_id
       WHERE rr.status = 'pending'
       ORDER BY rr.created_at DESC`
    );
    res.json({ success: true, requests: r.rows });
  } catch(e) {
    console.error('[ROLE-REQUESTS]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// POST /api/auth/role-requests/:id/approve — approuver une demande
router.post('/role-requests/:id/approve', auth, async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') return res.status(403).json({ success: false, message: 'Accès refusé.' });

    // Récupérer la demande
    const rq = await pool.query(`SELECT * FROM role_requests WHERE id=$1`, [req.params.id]);
    if (!rq.rows.length) return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    const request = rq.rows[0];

    // Mettre à jour le rôle de l'utilisateur
    await pool.query(`UPDATE users SET role=$1 WHERE id=$2`, [request.requested_role, request.user_id]);

    // Mettre à jour la session QR si elle existe
    if (request.session_id) {
      await pool.query(
        `UPDATE qr_sessions SET status='validated', role=$1 WHERE session_id=$2`,
        [request.requested_role, request.session_id]
      );
    }

    // Marquer la demande comme approuvée
    await pool.query(`UPDATE role_requests SET status='approved' WHERE id=$1`, [req.params.id]);

    console.log('[APPROVE]', request.user_id, '→', request.requested_role);
    res.json({ success: true, message: 'Demande approuvée !' });
  } catch(e) {
    console.error('[APPROVE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// POST /api/auth/role-requests/:id/reject — refuser une demande
router.post('/role-requests/:id/reject', auth, async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') return res.status(403).json({ success: false, message: 'Accès refusé.' });

    const rq = await pool.query(`SELECT * FROM role_requests WHERE id=$1`, [req.params.id]);
    if (!rq.rows.length) return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    const request = rq.rows[0];

    // Session QR → expired
    if (request.session_id) {
      await pool.query(`UPDATE qr_sessions SET status='expired' WHERE session_id=$1`, [request.session_id]);
    }

    await pool.query(`UPDATE role_requests SET status='rejected' WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Demande refusée.' });
  } catch(e) {
    console.error('[REJECT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});


// POST /api/auth/verify-school-code — vérifier code école pour prof/admin
router.post('/verify-school-code', auth, async (req, res) => {
  try {
    const { school, code } = req.body;
    if (!school || !code) return res.status(400).json({ success: false, message: 'École et code requis.' });

    // Lire le vrai rôle depuis la base (pas le JWT qui peut être ancien)
    const userResult = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]);
    if (!userResult.rows.length) return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
    const role = userResult.rows[0].role;

    if (role !== 'enseignant' && role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Réservé aux profs et admins.' });
    }

    const r = await pool.query(
      'SELECT prof_code, admin_code, is_active FROM school_codes WHERE school=$1',
      [school]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Aucun code trouvé pour cet établissement.' });
    if (!r.rows[0].is_active) return res.status(403).json({ success: false, message: 'Les codes de cet établissement sont désactivés.' });

    const expectedCode = role === 'enseignant' ? r.rows[0].prof_code : r.rows[0].admin_code;
    if (code.toUpperCase().trim() !== expectedCode) {
      return res.status(401).json({ success: false, message: 'Code incorrect. Vérifiez avec vos collègues.' });
    }

    res.json({ success: true, message: 'Code valide !' });
  } catch(e) {
    console.error('[VERIFY-SCHOOL-CODE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;