// db/analytics.js
const mysql = require('mysql2/promise');
const path = require('path');
const dotenv = require('dotenv');

// Carga .env (por si acaso)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

/* =========================================================
   RESOLUTORES DINÁMICOS (aceptan cualquier plataforma/servicio)
   ========================================================= */

// Lista de plataformas presentes en CLIENTES
async function listPlataformasClientes() {
  const [rows] = await pool.query(`
    SELECT DISTINCT TRIM(PLATAFORMA) AS nombre
    FROM CLIENTES
    WHERE COALESCE(TRIM(PLATAFORMA),'') <> ''
    ORDER BY nombre
  `);
  return rows.map(r => r.nombre);
}

// Lista de servicios presentes en codes.service
async function listServiciosCodes() {
  const [rows] = await pool.query(`
    SELECT DISTINCT TRIM(service) AS nombre
    FROM codes
    WHERE COALESCE(TRIM(service),'') <> ''
    ORDER BY nombre
  `);
  return rows.map(r => r.nombre);
}

// Resolver plataforma por coincidencia exacta (case-insensitive) o parcial
async function resolvePlataforma(input) {
  if (!input) return null;
  const q = String(input).trim();

  // 1) exacta case-insensitive
  {
    const [rows] = await pool.query(`
      SELECT DISTINCT PLATAFORMA
      FROM CLIENTES
      WHERE LOWER(TRIM(PLATAFORMA)) = LOWER(TRIM(?))
      LIMIT 1
    `, [q]);
    if (rows.length) return rows[0].PLATAFORMA;
  }

  // 2) parcial (LIKE)
  {
    const [rows] = await pool.query(`
      SELECT DISTINCT PLATAFORMA
      FROM CLIENTES
      WHERE LOWER(TRIM(PLATAFORMA)) LIKE CONCAT('%', LOWER(TRIM(?)), '%')
      ORDER BY PLATAFORMA ASC
      LIMIT 1
    `, [q]);
    if (rows.length) return rows[0].PLATAFORMA;
  }

  return null;
}

// Resolver servicio en codes.service por exacta/parcial
async function resolveServicioCodes(input) {
  if (!input) return null;
  const q = String(input).trim();

  // 1) exacta
  {
    const [rows] = await pool.query(`
      SELECT DISTINCT service
      FROM codes
      WHERE LOWER(TRIM(service)) = LOWER(TRIM(?))
      LIMIT 1
    `, [q]);
    if (rows.length) return rows[0].service;
  }

  // 2) parcial
  {
    const [rows] = await pool.query(`
      SELECT DISTINCT service
      FROM codes
      WHERE LOWER(TRIM(service)) LIKE CONCAT('%', LOWER(TRIM(?)), '%')
      ORDER BY service ASC
      LIMIT 1
    `, [q]);
    if (rows.length) return rows[0].service;
  }

  return null;
}

/* =========================
   CLIENTES: Resúmenes base
   ========================= */
async function resumenGeneralClientes() {
  const [rows] = await pool.query(`
    SELECT
      COUNT(*) AS total_clientes,
      COUNT(CORREO)                 AS correos_totales,
      COUNT(DISTINCT CORREO)        AS correos_unicos,
      SUM(COALESCE(\`CONTRASEÑA\`,'') <> '') AS contrasenas_registradas,
      SUM(COALESCE(PIN,'') <> '')   AS perfiles_con_pin,
      SUM(COALESCE(DIAS_RESTANTES,0) > 0)  AS activos,
      SUM(COALESCE(DIAS_RESTANTES,0) <= 0) AS vencidos
    FROM CLIENTES
  `);

  // Desglose por plataforma dinámico
  const [plat] = await pool.query(`
    SELECT PLATAFORMA, COUNT(*) AS cuentas
    FROM CLIENTES
    WHERE COALESCE(TRIM(PLATAFORMA),'') <> ''
    GROUP BY PLATAFORMA
    ORDER BY cuentas DESC
  `);

  return { ...rows[0], plataformas: plat };
}

async function resumenClientesPorServicio(servicio) {
  const svc = await resolvePlataforma(servicio);
  if (!svc) throw new Error(`Plataforma no encontrada: "${servicio}"`);

  const [rows] = await pool.query(`
    SELECT
      ?                         AS servicio,
      COUNT(*)                  AS total,
      COUNT(CORREO)             AS correos_totales,
      COUNT(DISTINCT CORREO)    AS correos_unicos,
      SUM(COALESCE(\`CONTRASEÑA\`,'') <> '') AS contrasenas_registradas,
      SUM(COALESCE(PIN,'') <> '') AS perfiles_con_pin,
      SUM(COALESCE(DIAS_RESTANTES,0) > 0)  AS activos,
      SUM(COALESCE(DIAS_RESTANTES,0) <= 0) AS vencidos
    FROM CLIENTES
    WHERE PLATAFORMA = ?
  `, [svc, svc]);
  return rows[0] || null;
}

/* =========================
   CODES: Resumen por servicio
   ========================= */
async function resumenCodesPorServicio(servicio) {
  const svc = await resolveServicioCodes(servicio);
  if (!svc) throw new Error(`Servicio (codes) no encontrado: "${servicio}"`);

  const [rows] = await pool.query(`
    SELECT
      ? AS servicio,
      COUNT(*) AS total_codes,
      SUM(mail REGEXP '^[0-9]{4}$') AS codes_en_mail,
      SUM(url  REGEXP '^[0-9]{4}$') AS codes_en_url,
      SUM(url IS NOT NULL AND url <> '' AND NOT (url REGEXP '^[0-9]{4}$')) AS links_en_url,
      COUNT(DISTINCT mail) AS mails_distintos
    FROM codes
    WHERE service = ?
  `, [svc, svc]);

  return rows[0] || null;
}

/* =========================
   CLIENTES: Repetidos
   ========================= */
async function repetidosGlobal(minCount = 2, limit = 30) {
  const [rows] = await pool.query(`
    SELECT
      PLATAFORMA,
      CORREO,
      \`CONTRASEÑA\` AS password,
      COUNT(*) AS veces
    FROM CLIENTES
    WHERE COALESCE(CORREO,'') <> ''
    GROUP BY PLATAFORMA, CORREO, \`CONTRASEÑA\`
    HAVING COUNT(*) >= ?
    ORDER BY veces DESC, PLATAFORMA ASC, CORREO ASC
    LIMIT ?
  `, [minCount, limit]);
  return rows;
}

async function repetidosPorServicio(servicio, minCount = 2, limit = 30) {
  const svc = await resolvePlataforma(servicio);
  if (!svc) throw new Error(`Plataforma no encontrada: "${servicio}"`);

  const [rows] = await pool.query(`
    SELECT
      PLATAFORMA,
      CORREO,
      \`CONTRASEÑA\` AS password,
      COUNT(*) AS veces
    FROM CLIENTES
    WHERE PLATAFORMA = ?
      AND COALESCE(CORREO,'') <> ''
    GROUP BY PLATAFORMA, CORREO, \`CONTRASEÑA\`
    HAVING COUNT(*) >= ?
    ORDER BY veces DESC, CORREO ASC
    LIMIT ?
  `, [svc, minCount, limit]);
  return rows;
}

/* =========================
   CODES: Recientes (con fallback de orden)
   ========================= */
async function codesRecientesServicio(servicio, limit = 10) {
  const svc = await resolveServicioCodes(servicio);
  if (!svc) throw new Error(`Servicio (codes) no encontrado: "${servicio}"`);

  try {
    const [rows] = await pool.query(`
      SELECT service, mail, url, created_at
      FROM codes
      WHERE service = ?
      ORDER BY created_at DESC
      LIMIT ?
    `, [svc, limit]);
    return rows;
  } catch (_) {}

  try {
    const [rows] = await pool.query(`
      SELECT service, mail, url, id
      FROM codes
      WHERE service = ?
      ORDER BY id DESC
      LIMIT ?
    `, [svc, limit]);
    return rows;
  } catch (_) {}

  const [rows] = await pool.query(`
    SELECT service, mail, url
    FROM codes
    WHERE service = ?
    LIMIT ?
  `, [svc, limit]);
  return rows;
}

/* =========================
   CLIENTES: Renovación/vencidos
   ========================= */
async function cuentasPorRenovar(diasUmbral = 3, limit = 30) {
  const [rows] = await pool.query(`
    SELECT
      NUMERO,
      PLATAFORMA,
      CORREO,
      DIAS_RESTANTES,
      DIA_DE_FINALIZACION
    FROM CLIENTES
    WHERE COALESCE(DIAS_RESTANTES, 0) BETWEEN 1 AND ?
    ORDER BY DIAS_RESTANTES ASC, DIA_DE_FINALIZACION ASC
    LIMIT ?
  `, [diasUmbral, limit]);
  return rows;
}

async function cuentasVencidas(limit = 30) {
  const [rows] = await pool.query(`
    SELECT
      NUMERO,
      PLATAFORMA,
      CORREO,
      DIAS_RESTANTES,
      DIA_DE_FINALIZACION
    FROM CLIENTES
    WHERE COALESCE(DIAS_RESTANTES, 0) <= 0
    ORDER BY DIA_DE_FINALIZACION DESC, NUMERO ASC
    LIMIT ?
  `, [limit]);
  return rows;
}

// EXACTO N días (ej. 1 día)
async function cuentasPorRenovarExacto(dias = 1, limit = 50) {
  const [rows] = await pool.query(`
    SELECT
      NUMERO,
      PLATAFORMA,
      CORREO,
      DIAS_RESTANTES,
      DIA_DE_FINALIZACION
    FROM CLIENTES
    WHERE COALESCE(DIAS_RESTANTES, 0) = ?
    ORDER BY DIA_DE_FINALIZACION ASC, NUMERO ASC
    LIMIT ?
  `, [dias, limit]);
  return rows;
}

/* =========================
   Búsquedas / listados por plataforma
   ========================= */
async function correosPorPlataforma(servicio, limit = 100) {
  const svc = await resolvePlataforma(servicio);
  if (!svc) throw new Error(`Plataforma no encontrada: "${servicio}"`);
  const [rows] = await pool.query(`
    SELECT
      CORREO,
      COUNT(*) AS veces
    FROM CLIENTES
    WHERE PLATAFORMA = ?
      AND COALESCE(CORREO,'') <> ''
    GROUP BY CORREO
    ORDER BY veces DESC, CORREO ASC
    LIMIT ?
  `, [svc, limit]);
  return rows;
}

async function topCorreosPorServicio(servicio, limit = 20) {
  return correosPorPlataforma(servicio, limit);
}

async function findByNumero(numero, limit = 20) {
  const [rows] = await pool.query(`
    SELECT NUMERO, PLATAFORMA, CORREO, \`CONTRASEÑA\` AS password, PERFIL, PIN, DIAS_RESTANTES, DIA_DE_FINALIZACION
    FROM CLIENTES
    WHERE NUMERO = ?
    ORDER BY PLATAFORMA ASC
    LIMIT ?
  `, [numero, limit]);
  return rows;
}

async function findByNumeroYServicio(numero, servicio, limit = 20) {
  const svc = await resolvePlataforma(servicio);
  if (!svc) throw new Error(`Plataforma no encontrada: "${servicio}"`);
  const [rows] = await pool.query(`
    SELECT NUMERO, PLATAFORMA, CORREO, \`CONTRASEÑA\` AS password, PERFIL, PIN, DIAS_RESTANTES, DIA_DE_FINALIZACION
    FROM CLIENTES
    WHERE NUMERO = ? AND PLATAFORMA = ?
    ORDER BY PLATAFORMA ASC
    LIMIT ?
  `, [numero, svc, limit]);
  return rows;
}

async function findByCorreoLike(texto, limit = 50) {
  const [rows] = await pool.query(`
    SELECT NUMERO, PLATAFORMA, CORREO, \`CONTRASEÑA\` AS password, DIAS_RESTANTES
    FROM CLIENTES
    WHERE CORREO LIKE CONCAT('%', ?, '%')
    ORDER BY CORREO ASC
    LIMIT ?
  `, [texto, limit]);
  return rows;
}

/* =========================
   SELECT seguro (solo lectura)
   ========================= */
async function selectSafe(sql) {
  const q = String(sql || '').trim();
  if (!/^select/i.test(q)) throw new Error('Solo se permite SELECT.');
  const final = /\blimit\b/i.test(q) ? q : `${q} LIMIT 100`;
  const [rows] = await pool.query(final);
  return rows;
}

/* =========================
   DASHBOARD por fecha (usa DATEDIFF con la fecha actual)
   ========================= */
async function dashboardGlobal() {
  const [rows] = await pool.query(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN DATEDIFF(DIA_DE_FINALIZACION, CURDATE()) >= 0 THEN 1 ELSE 0 END) AS activos,
      SUM(CASE WHEN DATEDIFF(DIA_DE_FINALIZACION, CURDATE()) = 1 THEN 1 ELSE 0 END)  AS por_renovar,
      SUM(CASE WHEN DATEDIFF(DIA_DE_FINALIZACION, CURDATE()) < 0 THEN 1 ELSE 0 END)  AS vencidos
    FROM CLIENTES
  `);
  return rows[0] || null;
}

async function dashboardPorPlataforma() {
  const [rows] = await pool.query(`
    SELECT
      PLATAFORMA,
      COUNT(*) AS total,
      SUM(CASE WHEN DATEDIFF(DIA_DE_FINALIZACION, CURDATE()) >= 0 THEN 1 ELSE 0 END) AS activos,
      SUM(CASE WHEN DATEDIFF(DIA_DE_FINALIZACION, CURDATE()) = 1 THEN 1 ELSE 0 END)  AS por_renovar,
      SUM(CASE WHEN DATEDIFF(DIA_DE_FINALIZACION, CURDATE()) < 0 THEN 1 ELSE 0 END)  AS vencidos
    FROM CLIENTES
    WHERE COALESCE(TRIM(PLATAFORMA),'') <> ''
    GROUP BY PLATAFORMA
    ORDER BY total DESC, PLATAFORMA ASC
  `);
  return rows;
}

async function listarPorRenovarExacto(dias = 1, limit = 50) {
  const [rows] = await pool.query(`
    SELECT
      NUMERO,
      PLATAFORMA,
      CORREO,
      DIAS_RESTANTES,
      DIA_DE_FINALIZACION
    FROM CLIENTES
    WHERE DATEDIFF(DIA_DE_FINALIZACION, CURDATE()) = ?
    ORDER BY DIA_DE_FINALIZACION ASC, PLATAFORMA ASC
    LIMIT ?
  `, [dias, limit]);
  return rows;
}

async function listarVencidos(limit = 50) {
  const [rows] = await pool.query(`
    SELECT
      NUMERO,
      PLATAFORMA,
      CORREO,
      DIAS_RESTANTES,
      DIA_DE_FINALIZACION
    FROM CLIENTES
    WHERE DATEDIFF(DIA_DE_FINALIZACION, CURDATE()) < 0
    ORDER BY DIA_DE_FINALIZACION DESC, PLATAFORMA ASC
    LIMIT ?
  `, [limit]);
  return rows;
}

/* =========================
   Formatters (texto para WhatsApp)
   ========================= */
function formatoResumenGeneral(r) {
  if (!r) return 'Sin datos.';
  const cab = [
    '📊 *Resumen general (CLIENTES)*',
    `👥 Total: ${r.total_clientes}`,
    `✉️ Correos: ${r.correos_totales} (únicos: ${r.correos_unicos})`,
    `🔑 Contraseñas registradas: ${r.contrasenas_registradas}`,
    `🔒 Perfiles con PIN: ${r.perfiles_con_pin}`,
    `⏳ Activos: ${r.activos} | Vencidos: ${r.vencidos}`,
  ].join('\n');

  const plat = (r.plataformas || [])
    .map(p => `• ${p.PLATAFORMA}: ${p.cuentas}`)
    .join('\n');

  return plat ? `${cab}\n\n🎬 *Por plataforma*\n${plat}` : cab;
}

function formatoResumenServicioClientes(r) {
  if (!r) return 'Sin datos.';
  return [
    `📊 *${r.servicio} (CLIENTES)*`,
    `👥 Total: ${r.total}`,
    `✉️ Correos: ${r.correos_totales} (únicos: ${r.correos_unicos})`,
    `🔑 Contraseñas registradas: ${r.contrasenas_registradas}`,
    `🔒 Perfiles con PIN: ${r.perfiles_con_pin}`,
    `⏳ Activos: ${r.activos} | Vencidos: ${r.vencidos}`,
  ].join('\n');
}

function formatoResumenServicioCodes(r) {
  if (!r) return 'Sin datos.';
  return [
    `🧩 *${r.servicio} (CODES)*`,
    `🗂️ Registros: ${r.total_codes}`,
    `🔢 Códigos en mail: ${r.codes_en_mail} | en url: ${r.codes_en_url}`,
    `🔗 Links en url (no-código): ${r.links_en_url}`,
    `📧 Mails distintos: ${r.mails_distintos}`,
  ].join('\n');
}

function formatoPlataformas(listClientes, listCodes) {
  const a = (listClientes && listClientes.length)
    ? '🎬 *Plataformas en CLIENTES:*\n• ' + listClientes.join('\n• ')
    : '🎬 *Plataformas en CLIENTES:* (vacío)';
  const b = (listCodes && listCodes.length)
    ? '🧩 *Servicios en CODES:*\n• ' + listCodes.join('\n• ')
    : '🧩 *Servicios en CODES:* (vacío)';
  return `${a}\n\n${b}`;
}

function formatoRepetidos(rows, title = 'Repetidos') {
  if (!rows || rows.length === 0) return 'No hay repetidos con ese umbral.';
  const lines = rows.map((r, i) =>
    `${i + 1}. [${r.PLATAFORMA}] ×${r.veces}\n   ${r.CORREO} | ${r.password ?? ''}`
  );
  return `🔁 *${title}*\n` + lines.join('\n');
}

function formatoCodes(list, servicio) {
  if (!list || list.length === 0) return `Sin códigos para ${servicio}.`;
  const lines = list.map((r, i) =>
    `${i + 1}. ${r.mail ?? ''} ${r.url ? `| ${r.url}` : ''}`
  );
  return `🧩 *Códigos recientes – ${servicio}*\n` + lines.join('\n');
}

function formatoRenovar(list, diasUmbral) {
  if (!list || list.length === 0) return `No hay cuentas a renovar (≤ ${diasUmbral} días).`;
  const lines = list.map((r, i) =>
    `${i + 1}. ${r.NUMERO} · [${r.PLATAFORMA}]\n   ${r.CORREO} · DR:${r.DIAS_RESTANTES} · Fin:${r.DIA_DE_FINALIZACION ?? ''}`
  );
  return `⏳ *Por renovar (≤ ${diasUmbral} días)*\n` + lines.join('\n');
}

function formatoVencidas(list) {
  if (!list || list.length === 0) return 'No hay cuentas vencidas.';
  const lines = list.map((r, i) =>
    `${i + 1}. ${r.NUMERO} · [${r.PLATAFORMA}]\n   ${r.CORREO} · DR:${r.DIAS_RESTANTES} · Fin:${r.DIA_DE_FINALIZACION ?? ''}`
  );
  return `❌ *Vencidas*\n` + lines.join('\n');
}

function formatoCorreosServicio(rows, servicio) {
  if (!rows || rows.length === 0) return `No hay correos en ${servicio}.`;
  const lines = rows.map((r, i) => `${i + 1}. ${r.CORREO} · ×${r.veces}`);
  return `✉️ *Correos en ${servicio}*\n` + lines.join('\n');
}

function formatoClientesCompact(rows) {
  if (!rows || rows.length === 0) return 'Sin resultados.';
  return rows.map((r, i) =>
    `${i + 1}. ${r.NUMERO ?? ''} · [${r.PLATAFORMA ?? ''}]` +
    `\n   ${r.CORREO ?? ''} ${r.password ? `| ${r.password}` : ''}` +
    (r.DIAS_RESTANTES != null ? ` · DR:${r.DIAS_RESTANTES}` : '')
  ).join('\n');
}

function formatoTopDominios(rows) {
  if (!rows || rows.length === 0) return 'Sin dominios.';
  return rows.map((r, i) => `${i + 1}. ${r.dominio} · ${r.cuentas}`).join('\n');
}

function formatoTopCorreos(rows, servicio) {
  if (!rows || rows.length === 0) return `Sin correos frecuentes en ${servicio}.`;
  return rows.map((r, i) => `${i + 1}. ${r.CORREO} · ×${r.veces}`).join('\n');
}

function formatoPlanRenov(rows, dias) {
  if (!rows || rows.length === 0) return `No hay renovaciones en los próximos ${dias} días.`;
  return rows.map(r => `• ${r.dia}: ${r.cuentas}`).join('\n');
}

/* =========================
   Exports
   ========================= */
module.exports = {
  // resolutores/listados dinámicos
  listPlataformasClientes,
  listServiciosCodes,
  resolvePlataforma,
  resolveServicioCodes,

  // resúmenes
  resumenGeneralClientes,
  resumenClientesPorServicio,
  resumenCodesPorServicio,

  // repetidos / codes / renovar
  repetidosGlobal,
  repetidosPorServicio,
  codesRecientesServicio,
  cuentasPorRenovar,
  cuentasVencidas,
  cuentasPorRenovarExacto,

  // búsquedas/listados
  correosPorPlataforma,
  topCorreosPorServicio: correosPorPlataforma,
  findByNumero,
  findByNumeroYServicio,
  findByCorreoLike,

  // SELECT seguro
  selectSafe,

  // dashboard
  dashboardGlobal,
  dashboardPorPlataforma,
  listarPorRenovarExacto,
  listarVencidos,

  // formatters
  formatoResumenGeneral,
  formatoResumenServicioClientes,
  formatoResumenServicioCodes,
  formatoPlataformas,
  formatoRepetidos,
  formatoCodes,
  formatoRenovar,
  formatoVencidas,
  formatoCorreosServicio,
  formatoClientesCompact,
  formatoTopDominios,
  formatoTopCorreos,
  formatoPlanRenov,
  formatoDashboardGlobal: (r) => [
    '📊 *Dashboard (Global)*',
    r ? `👥 Total: ${r.total}` : 'Sin datos',
    r ? `🟢 Activos: ${r.activos}` : '',
    r ? `⏳ Por renovar (1 día): ${r.por_renovar}` : '',
    r ? `❌ Vencidos: ${r.vencidos}` : ''
  ].filter(Boolean).join('\n'),
  formatoDashboardPlataformas: (rows) => {
    if (!rows || rows.length === 0) return 'No hay plataformas registradas.';
    const lines = rows.map((r) =>
      `• ${r.PLATAFORMA}: total ${r.total} | 🟢 ${r.activos} | ⏳ ${r.por_renovar} | ❌ ${r.vencidos}`
    );
    return `🎬 *Por plataforma*\n` + lines.join('\n');
  },
};
