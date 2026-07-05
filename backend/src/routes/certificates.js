// src/routes/certificates.js
// Attestations / certificats numériques — émis par un enseignant à un étudiant
const crypto  = require('crypto');
const express = require('express');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

const teacherOnly = (req, res, next) => {
  if (req.user.role !== 'enseignant' && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Accès réservé aux enseignants.' });
  }
  next();
};

function genCertificateNumber() {
  const year = new Date().getFullYear();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `CL-${year}-${rand}`;
}

// ═══════════════════════════════════════════
//  ENSEIGNANT / ADMIN — Émettre une attestation
// ═══════════════════════════════════════════
router.post('/', auth, teacherOnly, async (req, res) => {
  try {
    const { student_id, course_id, title, grade } = req.body;
    if (!student_id || !title?.trim()) {
      return res.status(400).json({ success: false, message: 'Étudiant et titre requis.' });
    }

    const student = await pool.query('SELECT school FROM users WHERE id=$1 AND role=$2', [student_id, 'etudiant']);
    if (!student.rows.length) return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });

    let number;
    for (let i = 0; i < 5; i++) {
      number = genCertificateNumber();
      const dup = await pool.query('SELECT id FROM certificates WHERE certificate_number=$1', [number]);
      if (!dup.rows.length) break;
    }

    const r = await pool.query(
      `INSERT INTO certificates (certificate_number, student_id, course_id, teacher_id, title, school, grade)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [number, student_id, course_id||null, req.user.id, title.trim(), student.rows[0].school, grade!=null?parseFloat(grade):null]
    );

    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, link) VALUES ($1,$2,$3,'certificate',$4)`,
      [student_id, 'Nouvelle attestation', `Vous avez reçu : ${title.trim()}`, '/certificates']
    ).catch(()=>{});

    res.status(201).json({ success: true, certificate: r.rows[0] });
  } catch(e) {
    console.error('[CERT ISSUE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.get('/teacher', auth, teacherOnly, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, u.first_name||' '||u.last_name AS student_name, co.title AS course_title
      FROM certificates c
      JOIN users u ON c.student_id=u.id
      LEFT JOIN courses co ON c.course_id=co.id
      WHERE c.teacher_id=$1
      ORDER BY c.issued_at DESC
    `, [req.user.id]);
    res.json({ success: true, certificates: r.rows });
  } catch(e) {
    console.error('[CERT TEACHER]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.put('/:id/revoke', auth, teacherOnly, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE certificates SET status='revoked' WHERE id=$1 AND teacher_id=$2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Attestation introuvable.' });
    res.json({ success: true });
  } catch(e) {
    console.error('[CERT REVOKE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  ÉTUDIANT — Mes attestations
// ═══════════════════════════════════════════
router.get('/student', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, u.first_name||' '||u.last_name AS teacher_name, co.title AS course_title
      FROM certificates c
      LEFT JOIN users u ON c.teacher_id=u.id
      LEFT JOIN courses co ON c.course_id=co.id
      WHERE c.student_id=$1
      ORDER BY c.issued_at DESC
    `, [req.user.id]);
    res.json({ success: true, certificates: r.rows });
  } catch(e) {
    console.error('[CERT STUDENT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  ADMIN — Vue d'ensemble de l'école
// ═══════════════════════════════════════════
router.get('/admin', auth, teacherOnly, async (req, res) => {
  try {
    const u = await pool.query('SELECT school FROM users WHERE id=$1', [req.user.id]);
    const r = await pool.query(`
      SELECT c.*, u.first_name||' '||u.last_name AS student_name, t.first_name||' '||t.last_name AS teacher_name
      FROM certificates c
      JOIN users u ON c.student_id=u.id
      LEFT JOIN users t ON c.teacher_id=t.id
      WHERE c.school=$1
      ORDER BY c.issued_at DESC
    `, [u.rows[0]?.school || null]);
    res.json({ success: true, certificates: r.rows });
  } catch(e) {
    console.error('[CERT ADMIN]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ═══════════════════════════════════════════
//  PUBLIC — Vérifier l'authenticité (sans auth)
// ═══════════════════════════════════════════
router.get('/verify/:number', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.certificate_number, c.title, c.school, c.grade, c.issued_at, c.status,
             u.first_name||' '||u.last_name AS student_name,
             t.first_name||' '||t.last_name AS teacher_name
      FROM certificates c
      JOIN users u ON c.student_id=u.id
      LEFT JOIN users t ON c.teacher_id=t.id
      WHERE c.certificate_number=$1
    `, [req.params.number]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Attestation introuvable.' });
    res.json({ success: true, certificate: r.rows[0] });
  } catch(e) {
    console.error('[CERT VERIFY]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
