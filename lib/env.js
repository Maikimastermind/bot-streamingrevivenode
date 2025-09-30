// lib/env.js
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Intentamos .env en CWD y también relativo al proyecto (padre de /lib)
const candidatePaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '..', '.env'),
];

let loadedPath = null;
for (const p of candidatePaths) {
  if (fs.existsSync(p)) {
    const res = dotenv.config({ path: p });
    if (!res.error) {
      loadedPath = p;
      break;
    } else {
      console.warn('[env] ⚠️ Error cargando', p, res.error.message);
    }
  }
}

if (!loadedPath) {
  console.warn('[env] ⚠️ No se pudo encontrar/cargar .env en:', candidatePaths.join(' | '));
} else {
  console.log('[env] ✓ .env cargado desde:', loadedPath);
}

module.exports = process.env;
