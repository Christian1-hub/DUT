const { Pool } = require('pg');

// Sur Render, DATABASE_URL est toujours défini
// On force SSL en production
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 
    `postgresql://${process.env.DB_USER||'postgres'}:${process.env.DB_PASSWORD||'1234'}@${process.env.DB_HOST||'localhost'}:${process.env.DB_PORT||5432}/${process.env.DB_NAME||'camunolearn'}`,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

module.exports = pool;