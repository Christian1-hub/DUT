// src/db/pool.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 5432,
  database: process.env.DB_NAME     || 'camunolearn',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// Test de connexion au démarrage
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Erreur PostgreSQL :', err.message);
  } else {
    console.log('✅ Connecté à PostgreSQL :', res.rows[0].now);
  }
});

module.exports = pool;