// ════════════════════════════════════════════════════════
//  CamunoLearn — app.js
//  Serveur principal Express + PostgreSQL
// ════════════════════════════════════════════════════════
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');

// ── Chargement des routes ────────────────────────────────
const authRoutes       = require('./routes/auth');
const teacherRoutes    = require('./routes/teacher');
const studentRoutes    = require('./routes/student');
const forumRoutes      = require('./routes/forum');
const adminRoutes      = require('./routes/admin');
const superadminRoutes = require('./routes/Superadmin');
const crossRoutes      = require('./routes/crossaccess');
const qrSessionRoutes  = require('./routes/qrsession');

const app = express();

// ── Sécurité ─────────────────────────────────────────────
app.use(helmet());

// ── CORS — accepte tous les ports locaux ─────────────────
app.use(cors({
  origin: function(origin, callback) {
    // Accepter toutes les origines localhost/127 (dev) et learnx.cm (prod)
    if (!origin) return callback(null, true); // file://, Postman, etc.
    if (
      origin.includes('localhost') ||
      origin.includes('127.0.0.1') ||
      origin.includes('learnx.cm') ||
      origin.includes('0.0.0.0') ||
      origin.includes('onrender.com')
    ) return callback(null, true);
    callback(new Error('CORS non autorisé: ' + origin));
  },
  methods:      ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// ── Corps des requêtes (JSON + base64 images) ────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Routes API ───────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/teacher',    teacherRoutes);
app.use('/api/student',    studentRoutes);
app.use('/api/forum',      forumRoutes);
app.use('/api/admin',      adminRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/cross',      crossRoutes);
app.use('/api/qrsession',  qrSessionRoutes);

// ── Santé ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'CamunoLearn API v2.0',
    routes: [
      'GET  /api/auth/me',
      'POST /api/auth/login',
      'POST /api/auth/register',
      'PUT  /api/auth/school',
      'PUT  /api/auth/avatar',
      'POST /api/auth/activate',
      'GET  /api/student/dashboard',
      'GET  /api/student/courses',
      'GET  /api/student/assignments',
      'GET  /api/teacher/dashboard',
      'GET  /api/teacher/courses',
      'GET  /api/forum/communities',
      'GET  /api/cross/courses',
      'POST /api/cross/request',
      'GET  /api/cross/pending',
      'PUT  /api/cross/request/:id',
      'GET  /api/admin/stats',
      'GET  /api/superadmin/stats',
      'POST /api/qrsession/create',
      'POST /api/qrsession/validate/:sessionId',
      'GET  /api/qrsession/status/:sessionId',
    ]
  });
});

// ── 404 ──────────────────────────────────────────────────
app.use((req, res) => {
  console.warn(`[404] ${req.method} ${req.path}`);
  res.status(404).json({
    success: false,
    message: `Route introuvable: ${req.method} ${req.path}`,
  });
});

// ── Erreur globale ───────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERREUR GLOBALE]', err.message);
  res.status(500).json({
    success: false,
    message: 'Erreur interne du serveur.',
    detail:  process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ── Démarrage ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log('\n' + '═'.repeat(50));
  console.log(`🚀 CamunoLearn API → http://localhost:${PORT}`);
  console.log('═'.repeat(50));

  try {
    const pool = require('./db/pool');
    const r    = await pool.query('SELECT NOW() AS now');
    console.log('✅ PostgreSQL connecté :', r.rows[0].now);

    // Vérifier les tables critiques
    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    const tableNames = tables.rows.map(t => t.table_name);
    console.log('\n📋 Tables disponibles:', tableNames.join(', '));

    const required = ['users','courses','assignments','assignment_submissions',
                      'enrollments','classes','class_members',
                      'communities','community_posts','community_replies','post_likes'];
    const missing  = required.filter(t => !tableNames.includes(t));
    if (missing.length) {
      console.warn('⚠️  Tables manquantes:', missing.join(', '));
    }

    // Vérifier cross_access_requests
    if (tableNames.includes('cross_access_requests')) {
      console.log('✅ cross_access_requests : OK');
    } else {
      console.warn('⚠️  cross_access_requests MANQUANTE → exécutez create_cross_table.sql dans pgAdmin');
    }

    // Créer les tables de codes si elles n'existent pas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prof_codes (
        code VARCHAR(4) PRIMARY KEY,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_codes (
        code VARCHAR(6) PRIMARY KEY,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Insérer les codes s'ils n'existent pas encore
    await pool.query(`
      INSERT INTO prof_codes (code) VALUES
      ('2H8L'),('3VQH'),('4F9C'),('4JQ5'),('7WSK'),('AJDD'),('AKTD'),('BKWJ'),('BZR7'),('C8G9'),
      ('DYXQ'),('EFXB'),('FYWL'),('G4UF'),('G92Z'),('HNPK'),('L2L4'),('ML82'),('MNHF'),('NWGA'),
      ('P4UW'),('PLC2'),('QEFV'),('RDEU'),('S2RJ'),('SMXY'),('W3VX'),('WN3T'),('XCZE'),('XNYY')
      ON CONFLICT DO NOTHING
    `);
    await pool.query(`
      INSERT INTO admin_codes (code) VALUES
      ('23P4ZE'),('2V7MWQ'),('47WCAC'),('4N79LD'),('5BLMHW'),('5P6L26'),('5V8J2Q'),('74YUUY'),('7R2DVA'),('9BG62G'),
      ('9JEGR5'),('DDG3V3'),('DZRZ6X'),('EXQHC7'),('FBGA76'),('KLMGY6'),('KVMREC'),('MHG89Y'),('MMC45Y'),('MNMQL3'),
      ('PDDSVN'),('PLXUDC'),('RW9CMV'),('U8MY32'),('USLLXM'),('V9WBB2'),('VWND5X'),('X8HU6N'),('YES68T'),('YXDJNU')
      ON CONFLICT DO NOTHING
    `);
    console.log('✅ prof_codes + admin_codes : OK');

    // Créer la table school_codes si elle n'existe pas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS school_codes (
        id SERIAL PRIMARY KEY,
        school VARCHAR(100) UNIQUE NOT NULL,
        prof_code VARCHAR(6) NOT NULL,
        admin_code VARCHAR(8) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Insérer les codes par défaut si table vide
    const scCount = await pool.query('SELECT COUNT(*) FROM school_codes');
    if (parseInt(scCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO school_codes (school, prof_code, admin_code) VALUES
        ('IUT de Douala', '7VUVMG', 'ZSENCLRN'),
        ('ENSET de Douala', 'ZNC32A', 'KH67L6Y4'),
        ('Université de Douala', 'U3YVCV', 'AXX8QG9B'),
        ('UCAC - ICAM', 'Q8F24D', 'H7RGCB82'),
        ('FMSP Douala', 'A8ML8X', 'RZAMQZDL'),
        ('Institut Universitaire de la Côte', 'MD3ZLV', 'GY978Z7R'),
        ('ESSEC Douala', 'G5VYVQ', 'SMDCCQL8'),
        ('Université de Yaoundé I', 'BAZ54K', 'C4FY5PS7'),
        ('Université de Yaoundé II', 'AB4TDT', 'HVFP2SSF'),
        ('SUP''PTIC Douala', '3LHVRE', 'M6RJBRJ9')
        ON CONFLICT DO NOTHING
      `);
      console.log('✅ school_codes : codes insérés');
    }
    console.log('✅ school_codes : OK');

    // Créer la table role_requests si elle n'existe pas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS role_requests (
        id SERIAL PRIMARY KEY,
        user_email VARCHAR(255),
        user_name VARCHAR(255),
        requested_role VARCHAR(20),
        session_id VARCHAR(36) UNIQUE,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ role_requests : OK');

    // Créer la table qr_sessions si elle n'existe pas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS qr_sessions (
        session_id VARCHAR(36) PRIMARY KEY,
        status VARCHAR(20) DEFAULT 'pending',
        role VARCHAR(20),
        user_info JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '15 minutes'
      )
    `);
    await pool.query(`ALTER TABLE qr_sessions ADD COLUMN IF NOT EXISTS user_info JSONB`);
    console.log('✅ qr_sessions : OK');
    console.log('\n✅ Serveur prêt !\n');
  } catch(e) {
    console.error('❌ PostgreSQL non connecté:', e.message);
    console.error('→ Vérifiez votre fichier .env\n');
  }
});

module.exports = app;