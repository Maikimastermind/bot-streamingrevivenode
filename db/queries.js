// db/queries.js
const mysql = require('mysql2/promise');
const env = require('../lib/env');
const logger = require('../lib/logger');

const db = mysql.createPool({
  host: env.DB_HOST,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  idleTimeout: 60000,
});

db.on?.('connection', () => logger.debug('🛢️  Nueva conexión MySQL del pool'));

async function obtenerNombreUsuario(numero) {
  const [rows] = await db.query(
    `SELECT NOMBRE FROM CLIENTES WHERE NUMERO = ? LIMIT 1`,
    [numero.replace(/^521/, '')]
  );
  return rows.length > 0 ? rows[0].NOMBRE : null;
}

async function consultarMisDatos(numero) {
  const [rows] = await db.query(
    `SELECT PLATAFORMA, CORREO, CONTRASEÑA, PERFIL, PIN, DIAS_RESTANTES, DIA_DE_FINALIZACION
     FROM CLIENTES WHERE NUMERO = ?`,
    [numero.replace(/^521/, '')]
  );
  return rows.length > 0 ? rows : null;
}

async function consultarCorreoPorServicio(service, email) {
  const [rows] = await db.query(
    `SELECT mail, url, service FROM codes WHERE service = ? AND mail = ?`,
    [service, email]
  );
  return rows.length > 0 ? rows : null;
}

async function clientesPorVencer(dias = 3) {
  const [rows] = await db.query(
    `SELECT NUMERO, PLATAFORMA, DIAS_RESTANTES
       FROM CLIENTES
      WHERE DIAS_RESTANTES IS NOT NULL
        AND DIAS_RESTANTES <= ?
        AND NUMERO IS NOT NULL AND NUMERO != ''`,
    [dias]
  );
  return rows;
}

async function correosPorNumeroYServicio(numero, servicio) {
  const num = numero.replace(/^521/, '');
  const [rows] = await db.query(
    `SELECT DISTINCT TRIM(CORREO) AS CORREO
       FROM CLIENTES
      WHERE NUMERO = ?
        AND CORREO IS NOT NULL AND CORREO <> ''
        AND (PLATAFORMA = ? OR PLATAFORMA LIKE CONCAT('%', ?, '%'))`,
    [num, servicio, servicio]
  );
  return rows.map(r => r.CORREO);
}

module.exports = {
  db,
  obtenerNombreUsuario,
  consultarMisDatos,
  consultarCorreoPorServicio,
  clientesPorVencer,
  correosPorNumeroYServicio,
};

