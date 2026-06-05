const { Pool } = require('pg');

const p = new Pool({
  connectionString: 'postgresql://camunolearn_db_user:3nm1DFDVV3I6QVwfhVbd7Nq6wFulcywG@dpg-d8ge8km7r5hc73b3afbg-a.frankfurt-postgres.render.com/camunolearn_db?sslmode=require'
});

p.query(`
  ALTER TABLE courses ADD COLUMN IF NOT EXISTS file_url TEXT;
  ALTER TABLE courses ADD COLUMN IF NOT EXISTS color VARCHAR(50) DEFAULT 'orange';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS discipline VARCHAR(255);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
  ALTER TABLE assignments ADD COLUMN IF NOT EXISTS instructions TEXT;
  ALTER TABLE assignments ADD COLUMN IF NOT EXISTS is_quiz BOOLEAN DEFAULT false;
  ALTER TABLE assignments ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';
`).then(() => {
  console.log('✅ SUCCES - Toutes les colonnes ajoutées !');
  p.end();
}).catch(e => {
  console.log('❌ ERREUR:', e.message);
  p.end();
});