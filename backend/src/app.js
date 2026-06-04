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
const superadminRoutes = require('./routes/superadmin');
const crossRoutes      = require('./routes/crossaccess');

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
      origin.includes('0.0.0.0')
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

    console.log('\n✅ Serveur prêt !\n');
  } catch(e) {
    console.error('❌ PostgreSQL non connecté:', e.message);
    console.error('→ Vérifiez votre fichier .env\n');
  }
});

module.exports = app;