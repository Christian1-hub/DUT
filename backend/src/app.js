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
const calendarRoutes   = require('./routes/calendar');
const notificationRoutes = require('./routes/notifications');
const attendanceRoutes   = require('./routes/attendance');
const projectRoutes      = require('./routes/projects');
const resourceRoutes     = require('./routes/resources');
const messageRoutes      = require('./routes/messages');
const certificateRoutes  = require('./routes/certificates');
const scheduleRoutes     = require('./routes/schedule');

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
app.use('/api/calendar',   calendarRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/attendance',    attendanceRoutes);
app.use('/api/projects',      projectRoutes);
app.use('/api/resources',     resourceRoutes);
app.use('/api/messages',      messageRoutes);
app.use('/api/certificates',  certificateRoutes);
app.use('/api/schedule',      scheduleRoutes);

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
      'GET  /api/notifications',
      'PUT  /api/notifications/:id/read',
      'POST /api/attendance/sessions',
      'GET  /api/attendance/me',
      'POST /api/projects',
      'GET  /api/projects/student',
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

    // Colonne anti-triche : nombre de changements d'onglet pendant un quiz
    if (tableNames.includes('assignment_submissions')) {
      await pool.query(`ALTER TABLE assignment_submissions ADD COLUMN IF NOT EXISTS tab_switches INTEGER DEFAULT 0`);
      console.log('✅ assignment_submissions.tab_switches : OK');
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

    // Table calendrier académique
    await pool.query(`
      CREATE TABLE IF NOT EXISTS academic_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(200) NOT NULL,
        description TEXT,
        category VARCHAR(50) NOT NULL,
        color VARCHAR(7) DEFAULT '#3b82f6',
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP NOT NULL,
        all_day BOOLEAN DEFAULT FALSE,
        department VARCHAR(100),
        school VARCHAR(100),
        created_by UUID REFERENCES users(id),
        is_recurring BOOLEAN DEFAULT FALSE,
        recurrence_rule VARCHAR(100),
        parent_event_id UUID REFERENCES academic_events(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ academic_events : OK');

    // Table notifications
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(200) NOT NULL,
        message TEXT,
        type VARCHAR(30) DEFAULT 'info',
        link VARCHAR(255),
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ notifications : OK');

    // Tables présences (gestion des présences des étudiants)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
        teacher_id UUID REFERENCES users(id),
        title VARCHAR(200),
        session_date DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'present',
        note VARCHAR(255),
        UNIQUE(session_id, student_id)
      )
    `);
    console.log('✅ attendance_sessions + attendance_records : OK');

    // Géolocalisation des écoles (geofencing des présences)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schools (
        school VARCHAR(100) PRIMARY KEY,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        geofence_radius_meters INTEGER NOT NULL DEFAULT 150,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Une ligne par école déjà connue de school_codes — coordonnées à renseigner
    // par l'admin de chaque école (voir PUT /api/admin/school-location). Tant que
    // latitude/longitude sont NULL, le geofencing est simplement ignoré pour
    // cette école (validation automatique) plutôt que de bloquer tout le monde.
    await pool.query(`
      INSERT INTO schools (school)
      SELECT school FROM school_codes
      ON CONFLICT (school) DO NOTHING
    `);
    console.log('✅ schools (geofencing) : OK');

    // Colonnes de vérification géolocalisée sur attendance_records
    await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS checkin_status VARCHAR(30)`);
    await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS checkin_lat DOUBLE PRECISION`);
    await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS checkin_lng DOUBLE PRECISION`);
    await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS checkin_accuracy_m DOUBLE PRECISION`);
    await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS checkin_distance_m DOUBLE PRECISION`);
    await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS checkin_at TIMESTAMP`);
    console.log('✅ attendance_records.checkin_* (geofencing) : OK');

    // Tables projets académiques
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(200) NOT NULL,
        description TEXT,
        course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
        teacher_id UUID REFERENCES users(id),
        school VARCHAR(100),
        filiere VARCHAR(100),
        deadline TIMESTAMP,
        status VARCHAR(20) DEFAULT 'active',
        file_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_submissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_name VARCHAR(200),
        content TEXT,
        file_url TEXT,
        grade NUMERIC(4,2),
        feedback TEXT,
        submitted_at TIMESTAMP DEFAULT NOW(),
        graded_at TIMESTAMP,
        UNIQUE(project_id, student_id)
      )
    `);
    console.log('✅ projects + project_submissions : OK');

    // Table bibliothèque de ressources
    await pool.query(`
      CREATE TABLE IF NOT EXISTS resources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(200) NOT NULL,
        description TEXT,
        category VARCHAR(50) DEFAULT 'autre',
        file_url TEXT,
        link_url TEXT,
        course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
        teacher_id UUID REFERENCES users(id),
        school VARCHAR(100),
        filiere VARCHAR(100),
        downloads_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ resources : OK');

    // Tables messagerie directe
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_a UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_b UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ conversations + messages : OK');

    // Table attestations / certificats numériques
    await pool.query(`
      CREATE TABLE IF NOT EXISTS certificates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        certificate_number VARCHAR(50) UNIQUE NOT NULL,
        student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
        teacher_id UUID REFERENCES users(id),
        title VARCHAR(200) NOT NULL,
        school VARCHAR(100),
        grade NUMERIC(4,2),
        status VARCHAR(20) DEFAULT 'valid',
        issued_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ certificates : OK');

    // Table emploi du temps (séances récurrentes hebdomadaires)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schedule_slots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        teacher_id UUID REFERENCES users(id),
        day_of_week SMALLINT NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        room VARCHAR(100),
        school VARCHAR(100),
        filiere VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ schedule_slots : OK');

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

    // Communautés par défaut — 7 par école, avec un post de lancement
    // (créées une seule fois : si l'école a déjà au moins une communauté, on ne touche à rien)
    try {
      const DEFAULT_COMMUNITIES = [
        { name:'Mathématiques & Logique',     icon:'calculate',       category:'Sciences',
          desc:"Le vieux tableau noir version numérique : théorèmes, exercices corrigés et astuces de calcul entre étudiants.",
          post:"Quelqu'un a une méthode simple pour retenir les formules de trigonométrie avant les examens ? 📐" },
        { name:'Sciences & Découvertes',      icon:'science',         category:'Sciences',
          desc:"Physique, chimie, biologie : le vieux labo du campus où on partage expériences et curiosités scientifiques.",
          post:"Le prof a fait une démonstration incroyable aujourd'hui, quelqu'un a pris des notes ? 🔬" },
        { name:'Littérature & Langues',       icon:'menu_book',       category:'Lettres',
          desc:"Un salon de lecture à l'ancienne pour discuter des œuvres au programme et s'entraider en langues.",
          post:"On lance un club de lecture ce semestre, des volontaires pour choisir le premier livre ? 📚" },
        { name:'Histoire & Culture Générale', icon:'account_balance', category:'Humanités',
          desc:"La salle des archives du campus : dates clés, débats d'idées et culture générale pour briller aux examens.",
          post:"Qui a des fiches de révision bien faites à partager avant l'examen de ce semestre ? 🏛️" },
        { name:'Vie Étudiante & Entraide',    icon:'groups',          category:'Communauté',
          desc:"Le foyer des étudiants de toujours : bons plans, entraide entre promotions et petites annonces du campus.",
          post:"Bienvenue à tous les nouveaux inscrits ! N'hésitez pas à vous présenter ici 👋" },
        { name:'Sport & Détente',             icon:'sports_soccer',   category:'Bien-être',
          desc:"Le stade universitaire version forum : matchs entre filières, séances de sport et bons plans détente.",
          post:"Match inter-filières ce week-end, qui est partant pour former une équipe ? ⚽" },
        { name:'Orientation & Débouchés',     icon:'work',            category:'Carrière',
          desc:"Le bureau des anciens : stages, débouchés professionnels et conseils d'orientation entre étudiants et diplômés.",
          post:"Des anciens de la filière déjà en poste qui peuvent partager leur expérience de stage ? 💼" },
      ];

      const superadminRes = await pool.query(`SELECT id FROM users WHERE email='superadmin@camunolearn.cm'`);
      const superadminId  = superadminRes.rows[0]?.id || null;

      const schoolsRes = await pool.query(`SELECT DISTINCT school FROM school_codes`);
      for (const { school } of schoolsRes.rows) {
        const existing = await pool.query(`SELECT COUNT(*) FROM communities WHERE school=$1`, [school]);
        if (parseInt(existing.rows[0].count) > 0) continue;

        for (const c of DEFAULT_COMMUNITIES) {
          const comm = await pool.query(
            `INSERT INTO communities (name, description, category, icon, teacher_id, school)
             VALUES ($1,$2,$3,$4,NULL,$5) RETURNING id`,
            [c.name, c.desc, c.category, c.icon, school]
          );
          if (superadminId) {
            await pool.query(
              `INSERT INTO community_posts (community_id, author_id, content) VALUES ($1,$2,$3)`,
              [comm.rows[0].id, superadminId, c.post]
            );
          }
        }
      }
      console.log('✅ communautés par défaut : OK');
    } catch(e) {
      console.warn('⚠️  communautés par défaut non initialisées:', e.message);
    }

    // Rattrapage class_members / enrollments — un étudiant dont la filière était
    // enregistrée sous un format différent de celui de la classe/du cours
    // ("GI" vs "GI — Génie Informatique") n'était jamais lié automatiquement à
    // son inscription (cause du "0 étudiants" vu côté prof alors qu'ils existent
    // bien). Requête tolérante aux deux formats, sûre à rejouer à chaque
    // démarrage (ON CONFLICT DO NOTHING).
    try {
      const backfillClasses = await pool.query(`
        INSERT INTO class_members (class_id, student_id)
        SELECT cl.id, u.id
        FROM classes cl
        JOIN users u ON u.role='etudiant' AND u.school=cl.school
          AND (u.filiere=cl.filiere OR SPLIT_PART(u.filiere,' — ',1)=SPLIT_PART(cl.filiere,' — ',1))
        ON CONFLICT DO NOTHING
        RETURNING class_id
      `);
      const backfillEnrollClass = await pool.query(`
        INSERT INTO enrollments (student_id, course_id)
        SELECT cm.student_id, c.id
        FROM class_members cm
        JOIN courses c ON c.class_id = cm.class_id
        ON CONFLICT DO NOTHING
        RETURNING student_id
      `);
      const backfillEnrollStandalone = await pool.query(`
        INSERT INTO enrollments (student_id, course_id)
        SELECT u.id, c.id
        FROM courses c
        JOIN users u ON u.role='etudiant' AND u.school=c.school
          AND (u.filiere=c.filiere OR SPLIT_PART(u.filiere,' — ',1)=SPLIT_PART(c.filiere,' — ',1) OR c.filiere IS NULL)
        WHERE c.class_id IS NULL
        ON CONFLICT DO NOTHING
        RETURNING student_id
      `);
      console.log(`✅ rattrapage class_members/enrollments : ${backfillClasses.rowCount} membre(s) de classe, ${backfillEnrollClass.rowCount + backfillEnrollStandalone.rowCount} inscription(s) ajoutée(s)`);
    } catch(e) {
      console.warn('⚠️  rattrapage class_members/enrollments échoué:', e.message);
    }

    // Code de classe (L1, L2, Master...) — chaque classe a un code unique que
    // l'étudiant saisit lui-même pour la rejoindre, au lieu de dépendre d'un
    // recoupement automatique fragile par filière/niveau qui peut mélanger deux
    // promotions différentes de la même filière.
    try {
      await pool.query(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS class_code VARCHAR(10)`);
      await pool.query(`
        UPDATE classes SET class_code = UPPER(SUBSTRING(MD5(id::text || random()::text) FROM 1 FOR 6))
        WHERE class_code IS NULL
      `);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS classes_class_code_idx ON classes(class_code)`);
      console.log('✅ classes.class_code : OK');
    } catch(e) {
      console.warn('⚠️  classes.class_code non initialisé:', e.message);
    }

    console.log('\n✅ Serveur prêt !\n');
  } catch(e) {
    console.error('❌ PostgreSQL non connecté:', e.message);
    console.error('→ Vérifiez votre fichier .env\n');
  }
});

module.exports = app;