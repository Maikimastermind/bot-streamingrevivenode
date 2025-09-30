// whitelist.js
const mysql = require('mysql2/promise');
const env = require('./lib/env');
const logger = require('./lib/logger');

const dbConfig = {
  host: env.DB_HOST,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
};

let cache = { data: new Set(), ts: 0 };
const TTL = 60_000; // 1 minuto

async function obtenerWhitelist() {
  try {
    const connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute(
      "SELECT NUMERO FROM CLIENTES WHERE NUMERO IS NOT NULL AND NUMERO != ''"
    );
    await connection.end();

    return rows
      .map((row) => row.NUMERO?.toString().trim())
      .filter((num) => num && !isNaN(num));
  } catch (error) {
    logger.error({ err: error }, '❌ Error al obtener whitelist');
    return [];
  }
}

async function obtenerWhitelistCached() {
  const now = Date.now();
  if (now - cache.ts > TTL) {
    const lista = await obtenerWhitelist();
    cache = { data: new Set(lista), ts: now };
    logger.debug({ size: lista.length }, '🔄 Whitelist actualizada en caché');
  }
  return cache.data;
}

async function verificarNumero(numero) {
  // ---- INICIO DE LA MEJORA ----
  let numeroParaVerificar = numero;

  // Si el número original empieza con "52" y tiene más de 10 dígitos,
  // le quitamos el prefijo para que coincida con la base de datos.
  if (numeroParaVerificar.startsWith('52') && numeroParaVerificar.length > 10) {
    numeroParaVerificar = numeroParaVerificar.substring(2); // Ahora es "3222669284"
  }
  // ---- FIN DE LA MEJORA ----

  const set = await obtenerWhitelistCached();
  
  // Usamos el número ya normalizado para la verificación
  const autorizado = set.has(numeroParaVerificar);

  // En el log se sigue mostrando el número original para mayor claridad
  logger.info({ numero, autorizado }, 'Verificación de whitelist');
  return autorizado;
}

module.exports = { obtenerWhitelist, verificarNumero };