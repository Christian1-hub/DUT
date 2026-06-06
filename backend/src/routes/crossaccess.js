// ════════════════════════════════════════════════════════
//  crossaccess.js — Inter-universités SIMPLIFIÉ
//  
//  Logique simple :
//  1. Un étudiant voit les cours d'autres universités
//  2. Il clique "Demander accès"
//  3. Le prof accepte ou refuse
//  4. Si accepté → l'étudiant voit le cours dans "Mes Cours"
// ════════════════════════════════════════════════════════
const express = require('express');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

router.use(auth);

// ────────────────────────────────────────────────────────
//  GET /api/cross/courses
//  Étudiant : liste tous les cours des AUTRES universités
// ────────────────────────────────────────────────────────
router.get('/courses', async (req, res) => {
  try {
    const studentId = req.user.id;

    // Récupérer l'école de l'étudiant
    const me = await pool.query(
      'SELECT school FROM users WHERE id=$1::uuid',
      [studentId]
    );
    const mySchool = me.rows[0]?.school || '';

    // Étape 1 : tous les cours des autres universités (simple)
    const coursesResult = await pool.query(
      `SELECT c.id, c.title, c.description, c.filiere,
              c.color, c.file_url,
              c.school AS university,
              u.first_name || ' ' || u.last_name AS teacher_name,
              u.id AS teacher_id
       FROM courses c
       JOIN users u ON c.teacher_id = u.id
       WHERE c.school IS NOT NULL
         AND c.school != ''
         AND c.school != $1
       ORDER BY c.school, c.created_at DESC`,
      [mySchool]
    );

    if (!coursesResult.rows.length) {
      return res.json({ success: true, courses: [] });
    }

    // Étape 2 : pour chaque cours, chercher le statut de la demande
    const courseIds = coursesResult.rows.map(c => c.id);

    // Demandes existantes de cet étudiant
    let requestMap = {};
    try {
      const reqResult = await pool.query(
        `SELECT course_id, status FROM cross_access_requests
         WHERE student_id=$1::uuid AND course_id = ANY($2::uuid[])`,
        [studentId, courseIds]
      );
      reqResult.rows.forEach(r => { requestMap[r.course_id] = r.status; });
    } catch(e) {
      // Table cross_access_requests peut ne pas exister encore
      console.warn('[CROSS] cross_access_requests not ready:', e.message);
    }

    // Inscriptions directes
    let enrolledSet = new Set();
    try {
      const enrollResult = await pool.query(
        `SELECT course_id FROM enrollments
         WHERE student_id=$1::uuid AND course_id = ANY($2::uuid[])`,
        [studentId, courseIds]
      );
      enrollResult.rows.forEach(r => enrolledSet.add(r.course_id));
    } catch(e) {}

    // Comptage inscrits par cours
    let enrollCountMap = {};
    try {
      const countResult = await pool.query(
        `SELECT course_id, COUNT(*) as cnt FROM enrollments
         WHERE course_id = ANY($1::uuid[]) GROUP BY course_id`,
        [courseIds]
      );
      countResult.rows.forEach(r => { enrollCountMap[r.course_id] = parseInt(r.cnt); });
    } catch(e) {}

    // Assembler la réponse
    const courses = coursesResult.rows.map(c => ({
      ...c,
      enrolled_count:      enrollCountMap[c.id] || 0,
      my_request_status:   requestMap[c.id] || null,
      already_enrolled:    enrolledSet.has(c.id),
    }));

    res.json({ success: true, courses });
  } catch(e) {
    console.error('[CROSS /courses]', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ────────────────────────────────────────────────────────
//  POST /api/cross/request
//  Étudiant : envoyer une demande d'accès à un cours
// ────────────────────────────────────────────────────────
router.post('/request', async (req, res) => {
  try {
    const { course_id, message } = req.body;
    if (!course_id) {
      return res.status(400).json({ success: false, message: 'course_id requis.' });
    }

    // Récupérer le prof du cours
    const course = await pool.query(
      'SELECT teacher_id, title, school FROM courses WHERE id=$1',
      [course_id]
    );
    if (!course.rows.length) {
      return res.status(404).json({ success: false, message: 'Cours introuvable.' });
    }

    const teacher_id = course.rows[0].teacher_id;

    // Créer ou mettre à jour la demande
    // D'abord essayer avec ON CONFLICT, sinon faire un simple INSERT
    try {
      await pool.query(`
        INSERT INTO cross_access_requests (student_id, course_id, teacher_id, message, status)
        VALUES ($1, $2, $3, $4, 'pending')
        ON CONFLICT (student_id, course_id)
        DO UPDATE SET message=$4, status='pending', updated_at=NOW()
      `, [req.user.id, course_id, teacher_id, message || null]);
    } catch(conflictErr) {
      // Si pas de contrainte UNIQUE, supprimer l'ancienne et insérer
      await pool.query(
        'DELETE FROM cross_access_requests WHERE student_id=$1 AND course_id=$2',
        [req.user.id, course_id]
      );
      await pool.query(
        `INSERT INTO cross_access_requests (student_id, course_id, teacher_id, message, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [req.user.id, course_id, teacher_id, message || null]
      );
    }

    res.json({
      success: true,
      message: 'Demande envoyée ! Le professeur recevra votre demande.'
    });
  } catch(e) {
    console.error('[CROSS /request]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ────────────────────────────────────────────────────────
//  GET /api/cross/pending
//  Professeur : voir toutes les demandes reçues
// ────────────────────────────────────────────────────────
router.get('/pending', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        car.id,
        car.status,
        car.message,
        car.created_at,
        u.first_name || ' ' || u.last_name  AS student_name,
        u.email       AS student_email,
        u.school      AS student_school,
        u.filiere,
        c.title       AS course_title,
        c.filiere     AS course_filiere
      FROM cross_access_requests car
      JOIN users    u ON car.student_id = u.id
      JOIN courses  c ON car.course_id  = c.id
      WHERE car.teacher_id = $1
      ORDER BY
        CASE car.status WHEN 'pending' THEN 0 ELSE 1 END,
        car.created_at DESC
    `, [req.user.id]);

    res.json({ success: true, requests: r.rows });
  } catch(e) {
    console.error('[CROSS /pending]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ────────────────────────────────────────────────────────
//  PUT /api/cross/request/:id
//  Professeur : accepter ou refuser une demande
// ────────────────────────────────────────────────────────
router.put('/request/:id', async (req, res) => {
  try {
    const { status } = req.body; // 'approved' ou 'rejected'

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Statut invalide.' });
    }

    // Mettre à jour la demande (vérifier que c'est bien ce prof)
    const r = await pool.query(`
      UPDATE cross_access_requests
      SET status=$1, updated_at=NOW()
      WHERE id=$2 AND teacher_id=$3
      RETURNING student_id, course_id
    `, [status, req.params.id, req.user.id]);

    if (!r.rows.length) {
      return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    }

    // Si accepté → inscrire automatiquement l'étudiant au cours
    if (status === 'approved') {
      const { student_id, course_id } = r.rows[0];
      await pool.query(`
        INSERT INTO enrollments (student_id, course_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [student_id, course_id]);
    }

    res.json({
      success: true,
      message: status === 'approved'
        ? "✅ Accès accordé ! L'étudiant peut maintenant voir votre cours."
        : "Demande refusée."
    });
  } catch(e) {
    console.error('[CROSS /request/:id]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
