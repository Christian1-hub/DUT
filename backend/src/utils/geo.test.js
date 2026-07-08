// src/utils/geo.test.js
// Script de test autonome (pas de framework de test installé dans ce projet).
// Lancer avec : node src/utils/geo.test.js
const { calculateDistance } = require('./geo');

let failures = 0;

function assertClose(label, actual, expected, tolerance) {
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    console.log(`✅ ${label} — obtenu ${actual.toFixed(2)}m (attendu ~${expected}m ± ${tolerance}m)`);
  } else {
    failures++;
    console.error(`❌ ${label} — obtenu ${actual.toFixed(2)}m, attendu ~${expected}m ± ${tolerance}m`);
  }
}

// 1. Même point → distance nulle
assertClose(
  'Même point',
  calculateDistance(4.0500, 9.7000, 4.0500, 9.7000),
  0,
  0.01
);

// 2. 1° de longitude à l'équateur ≈ 111 195 m (rayon terrestre moyen 6371km)
assertClose(
  '1° de longitude à l\'équateur',
  calculateDistance(0, 0, 0, 1),
  111195,
  1000
);

// 3. 0.0009° de latitude ≈ 100 m, quelle que soit la latitude de départ
assertClose(
  '0.0009° de latitude (~100m)',
  calculateDistance(4.0500, 9.7000, 4.0509, 9.7000),
  100,
  5
);

if (failures > 0) {
  console.error(`\n${failures} test(s) échoué(s).`);
  process.exit(1);
} else {
  console.log('\nTous les tests sont passés.');
}
