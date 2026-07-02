// src/routes/calendar.js
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');

// ── GET /api/calendar/events ──────────────────────────────────
// ?school=IUT de Douala&month=7&year=2026
router.get('/events', auth, async (req, res) => {
  try {
    const { school, month, year, category, department } = req.query;

    let conditions = ['e.school = $1'];
    let params     = [school || req.user.school || ''];
    let idx        = 2;

    if (month && year) {
      conditions.push(`(
        (EXTRACT(MONTH FROM e.start_date) = $${idx} AND EXTRACT(YEAR FROM e.start_date) = $${idx+1})
        OR
        (EXTRACT(MONTH FROM e.end_date) = $${idx} AND EXTRACT(YEAR FROM e.end_date) = $${idx+1})
      )`);
      params.push(parseInt(month), parseInt(year));
      idx += 2;
    }

    if (category) {
      conditions.push(`e.category = $${idx}`);
      params.push(category);
      idx++;
    }

    if (department) {
      conditions.push(`(e.department = $${idx} OR e.department IS NULL)`);
      params.push(department);
      idx++;
    }

    const r = await pool.query(`
      SELECT e.*,
             u.first_name || ' ' || u.last_name AS created_by_name
      FROM academic_events e
      LEFT JOIN users u ON e.created_by = u.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.start_date ASC
    `, params);

    res.json({ success: true, events: r.rows });
  } catch(e) {
    console.error('[CAL GET]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── POST /api/calendar/events ─────────────────────────────────
router.post('/events', auth, async (req, res) => {
  try {
    const role = req.user.role;
    if (!['enseignant','admin','superadmin'].includes(role)) {
      return res.status(403).json({ success: false, message: 'Réservé aux enseignants et admins.' });
    }

    const {
      title, description, category, color,
      start_date, end_date, all_day,
      department, school, is_recurring, recurrence_rule
    } = req.body;

    if (!title || !category || !start_date || !end_date) {
      return res.status(400).json({ success: false, message: 'Titre, catégorie, dates requises.' });
    }

    const CATEGORY_COLORS = {
      cours:          '#3b82f6',
      cc:             '#f59e0b',
      examen:         '#ef4444',
      tp:             '#8b5cf6',
      rattrapage:     '#f97316',
      reunion:        '#6b7280',
      caq:            '#0ea5e9',
      vie_etudiante:  '#10b981',
      conge:          '#94a3b8',
      stage:          '#84cc16',
    };

    const finalColor = color || CATEGORY_COLORS[category] || '#3b82f6';
    const finalSchool = school || req.user.school;

    const r = await pool.query(`
      INSERT INTO academic_events
        (title, description, category, color, start_date, end_date, all_day,
         department, school, created_by, is_recurring, recurrence_rule)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [
      title, description||null, category, finalColor,
      start_date, end_date, all_day||false,
      department||null, finalSchool, req.user.id,
      is_recurring||false, recurrence_rule||null
    ]);

    res.status(201).json({ success: true, event: r.rows[0] });
  } catch(e) {
    console.error('[CAL POST]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── PUT /api/calendar/events/:id ──────────────────────────────
router.put('/events/:id', auth, async (req, res) => {
  try {
    const role = req.user.role;
    if (!['enseignant','admin','superadmin'].includes(role)) {
      return res.status(403).json({ success: false, message: 'Accès refusé.' });
    }

    const {
      title, description, category, color,
      start_date, end_date, all_day, department
    } = req.body;

    const CATEGORY_COLORS = {
      cours:'#3b82f6', cc:'#f59e0b', examen:'#ef4444', tp:'#8b5cf6',
      rattrapage:'#f97316', reunion:'#6b7280', caq:'#0ea5e9',
      vie_etudiante:'#10b981', conge:'#94a3b8', stage:'#84cc16',
    };

    const finalColor = color || (category ? CATEGORY_COLORS[category] : undefined);

    // Vérifier que l'événement appartient à l'école de l'utilisateur
    const check = await pool.query(
      'SELECT id, created_by, school FROM academic_events WHERE id=$1',
      [req.params.id]
    );
    if (!check.rows.length) return res.status(404).json({ success: false, message: 'Événement introuvable.' });
    if (role !== 'superadmin' && check.rows[0].school !== req.user.school) {
      return res.status(403).json({ success: false, message: 'Accès refusé.' });
    }

    const r = await pool.query(`
      UPDATE academic_events SET
        title       = COALESCE($1, title),
        description = COALESCE($2, description),
        category    = COALESCE($3, category),
        color       = COALESCE($4, color),
        start_date  = COALESCE($5, start_date),
        end_date    = COALESCE($6, end_date),
        all_day     = COALESCE($7, all_day),
        department  = COALESCE($8, department),
        updated_at  = NOW()
      WHERE id = $9
      RETURNING *
    `, [title, description, category, finalColor, start_date, end_date, all_day, department, req.params.id]);

    res.json({ success: true, event: r.rows[0] });
  } catch(e) {
    console.error('[CAL PUT]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── DELETE /api/calendar/events/:id ──────────────────────────
router.delete('/events/:id', auth, async (req, res) => {
  try {
    const role = req.user.role;
    if (!['enseignant','admin','superadmin'].includes(role)) {
      return res.status(403).json({ success: false, message: 'Accès refusé.' });
    }

    const check = await pool.query(
      'SELECT id, created_by, school FROM academic_events WHERE id=$1',
      [req.params.id]
    );
    if (!check.rows.length) return res.status(404).json({ success: false, message: 'Introuvable.' });

    const ev = check.rows[0];
    // Seul le créateur, un admin ou superadmin peut supprimer
    if (role === 'enseignant' && ev.created_by !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Seul le créateur peut supprimer.' });
    }

    await pool.query('DELETE FROM academic_events WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    console.error('[CAL DELETE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── POST /api/calendar/events/:id/duplicate ───────────────────
// Dupliquer un événement (ex: réunion mensuelle récurrente)
router.post('/events/:id/duplicate', auth, async (req, res) => {
  try {
    const { offset_days } = req.body; // décalage en jours

    const src = await pool.query(
      'SELECT * FROM academic_events WHERE id=$1', [req.params.id]
    );
    if (!src.rows.length) return res.status(404).json({ success: false, message: 'Introuvable.' });

    const ev = src.rows[0];
    const offset = parseInt(offset_days) || 30; // par défaut +30 jours

    const newStart = new Date(ev.start_date);
    const newEnd   = new Date(ev.end_date);
    newStart.setDate(newStart.getDate() + offset);
    newEnd.setDate(newEnd.getDate() + offset);

    const r = await pool.query(`
      INSERT INTO academic_events
        (title, description, category, color, start_date, end_date, all_day,
         department, school, created_by, is_recurring, parent_event_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [
      ev.title, ev.description, ev.category, ev.color,
      newStart, newEnd, ev.all_day,
      ev.department, ev.school, req.user.id,
      true, ev.id
    ]);

    res.status(201).json({ success: true, event: r.rows[0] });
  } catch(e) {
    console.error('[CAL DUPLICATE]', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// ── GET /api/calendar/events/upcoming ────────────────────────
// Prochains événements (pour dashboard)
router.get('/events/upcoming', auth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    const r = await pool.query(`
      SELECT e.*, u.first_name || ' ' || u.last_name AS created_by_name
      FROM academic_events e
      LEFT JOIN users u ON e.created_by = u.id
      WHERE e.school = $1 AND e.start_date >= NOW()
      ORDER BY e.start_date ASC
      LIMIT $2
    `, [req.user.school, limit]);
    res.json({ success: true, events: r.rows });
  } catch(e) {
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;