// bot/handlers/messageHandler.js
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const logger = require('../../lib/logger');
require('../../lib/env'); // asegura process.env cargado

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const {
  obtenerNombreUsuario,
  consultarMisDatos,
  consultarCorreoPorServicio,
  correosPorNumeroYServicio,
} = require('../../db/queries');

const {
  listPlataformasClientes,
  listServiciosCodes,
  resumenGeneralClientes,
  resumenClientesPorServicio,
  resumenCodesPorServicio,
  correosPorPlataforma,
  findByNumero,
  findByNumeroYServicio,
  findByCorreoLike,
  repetidosGlobal,
  repetidosPorServicio,
  codesRecientesServicio,
  cuentasPorRenovar,
  cuentasVencidas,
  cuentasPorRenovarExacto,
  planRenovacion,
  selectSafe,
  dashboardGlobal,
  dashboardPorPlataforma,
  listarPorRenovarExacto,
  listarVencidos,
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
  formatoTopCorreos,
  formatoPlanRenov,
  formatoDashboardGlobal,
  formatoDashboardPlataformas,
} = require('../../db/analytics');

const { verificarNumero } = require('../../whitelist');
const { enviarMenu } = require('../helpers/menu');
const { getFileInfo, sendVideoWithRetry, sendImageWithRetry } = require('../../lib/media');
const { autoLoginAndSendCode } = require('../helpers/autoLogin'); // ➕ NUEVO (Código TV Netflix)

// Rate limit (compat)
let allow;
try { ({ allow } = require('../guards/rateLimit')); } catch {
  ({ allow } = require('../guards/ratelimit'));
}

const { sleep, sendTypingText, sendAckAndHold, withTyping, DELAY } =
  require('../helpers/timing');

// 🔒 Flow guard (anti-duplicados + candados por paso)
const {
  shouldDropDuplicate, markMessage,
  isLocked, withLock, busyIfLocked, resetSenderLocks,
} = require('../helpers/flowGuard');

/* =======================
   Ayuda / Cheatsheet
   ======================= */
const HELP_USER = [
  '🤖 *Ayuda (usuario)*',
  '',
  'Menú principal:',
  '  0️⃣  Datos de acceso',
  '  1️⃣  Código Netflix',
  '  2️⃣  Código TV Netflix (8 dígitos)', // ← reutilizamos 2 para TV
  '  3️⃣  Código PrimeVideo',
  '',
  'Extras:',
  '  escribe: *menu*  → reenvía el menú',
].join('\n');

const HELP_ADMIN = [
  '🛠️ *Ayuda admin*',
  '',
  '📊 Resúmenes / Dashboard',
  '  #dashboard [porRenovar=25] [vencidos=25]',
  '  #stats                → global',
  '  #stats <plataforma>   → ej: #stats netflix',
  '',
  '⏳ Renovaciones / Vencidos',
  '  #renovar <días> [limit]',
  '  #renovar1 [limit]',
  '  #vencidos [limit]',
  '  #planrenov [días] [limit]',
  '',
  '🔎 Búsquedas',
  '  #findnum <numero> [plataforma]',
  '  #findmail <texto>',
  '',
  '✉️ Correos / Códigos',
  '  #mails <plataforma> [limit]',
  '  #topcorreos <plataforma> [limit]',
  '  #codes <servicio_en_codes> [limit]',
  '',
  '🔁 Duplicados',
  '  #dup [min] | #dup <plat> [min]',
  '',
  '🧭 Descubrimiento',
  '  #services',
  '',
  '🧪 SQL SOLO LECTURA',
  '  #sql SELECT ...',
  '',
  '👤 Utilidad',
  '  #whoami',
  '  #maintenance on|off',
  '  #reset',
  '  #health',
  '  #checkmedia',
].join('\n');

/* =======================
   Admins por .env
   ======================= */
function normalizeLocal(num) {
  const digits = String(num || '').replace(/\D/g, '');
  return digits.replace(/^52/, '').slice(-10);
}
const rawAdmins = (process.env.ADMIN_NUMBERS && process.env.ADMIN_NUMBERS.trim())
  ? process.env.ADMIN_NUMBERS
  : '';

const ADMINS = rawAdmins
  .split(',')
  .map(s => s.replace(/#.*$/, ''))
  .map(s => s.trim())
  .filter(Boolean)
  .map(normalizeLocal);

const isAdmin = (num) => ADMINS.includes(normalizeLocal(num));
logger.info({ rawAdmins, ADMINS }, 'Admins cargados');

/* =======================
   Estado global
   ======================= */
const userServiceSelection = {};
const usuariosBienvenidos = new Set();
const userCooldowns = new Map();
const cooldownTime = 10_000;
const userEmailOptions = new Map();
const userWaitingEmailPick = new Set();

// ➕ Estados para flujo Código TV Netflix
const userWaitingTvCode = new Set();     // esperando el código de 8 dígitos
const userPickForTv = new Set();         // la selección de correo es para TV Netflix

let MAINTENANCE = false;
const userStateTTL = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function armState(id) { userStateTTL.set(id, Date.now() + STATE_TTL_MS); }
function clearState(id) {
  userStateTTL.delete(id);
  userWaitingEmailPick.delete(id);
  userEmailOptions.delete(id);
  userWaitingTvCode.delete(id);
  userPickForTv.delete(id);
  delete userServiceSelection[id];
}
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of userStateTTL) if (now > exp) clearState(k);
}, 60_000);

/* =======================
   MENÚ: cooldown + helper
   ======================= */
const menuCooldown = new Map(); // sender -> timestamp hasta cuándo no reenviar
const MENU_COOLDOWN_MS = parseInt(process.env.MENU_COOLDOWN_MS || '15000', 10); // 15s por defecto

function _ttlSecs(ts) {
  return Math.max(0, Math.ceil((ts - Date.now()) / 1000));
}

async function sendMenuOnce(sock, jid, { notifyIfCooldown = false } = {}) {
  const now = Date.now();
  const until = menuCooldown.get(jid) || 0;

  if (now < until) {
    if (notifyIfCooldown) {
      await sock.sendMessage(jid, {
        text: `🕒 Ya te envié el menú hace unos segundos. Intenta de nuevo en ${_ttlSecs(until)}s.`
      });
    }
    return false;
  }

  await enviarMenu(sock, jid);
  menuCooldown.set(jid, now + MENU_COOLDOWN_MS);
  return true;
}

// ¿Hay algún paso “largo” en curso? (evitar menú mientras tanto)
function anyLockActive(sender) {
  return ['welcome', 'misdatos', 'serviceLookup', 'codeLookup'].some(k => isLocked(sender, k));
}

/* =======================
   Helper: imagen menú + reset
   ======================= */
async function sendMenuImageAndReset(sock, jid) {
  await sleep(3000);
  const pathImg = process.env.MENU_IMAGE_PATH || './media/imagen.png';
  const caption = '✨ Para más plataformas y promociones visita https://www.streamingplus.store ✨\n🙌 Estamos para servirte.';
  const ok = await sendImageWithRetry(sock, jid, pathImg, caption, { attempts: 3, delayMs: 900 });

  // Cerrar flujo y limpiar guardas/estado
  clearState(jid);
  usuariosBienvenidos.delete(jid);
  resetSenderLocks(jid);

  // Enfriar el menú para evitar reenvíos inmediatos
  menuCooldown.set(jid, Date.now() + MENU_COOLDOWN_MS);

  // Si falló la imagen, intenta un menú textual (respetando cooldown)
  if (!ok) await sendMenuOnce(sock, jid);
}

function renderMenuCorreos(servicio, emails) {
  return [
    '╔═ ✉️ *Correos vinculados* ═╗',
    `   Servicio: *${servicio}*`,
    '──────────────────────────',
    ...emails.map((e, i) => `${i + 1}️⃣  ${e}`),
    '──────────────────────────',
    'Responde con el *número* del correo (ej: 1)',
    '╚══════════════════════════╝',
  ].join('\n');
}

async function handleMessage(sock, message) {
  if (!message?.message || message.key.fromMe) return;

  const sender = message.key.remoteJid;
  const senderNumber = sender.replace(/[@].*/, '').replace(/^521/, '');

  const textRaw =
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    message.message?.buttonsResponseMessage?.selectedButtonId ||
    message.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    '';

  const text = textRaw.trim().toLowerCase();
  const opt = text.replace(/^menu_/, '');
  if (!text) return;

  // 🔁 Anti-duplicados global (suprime texto idéntico en ventana corta)
  if (shouldDropDuplicate(sender, text)) {
    logger.info({ sender, text }, '[flowGuard] drop duplicate');
    return;
  }
  markMessage(sender, text);

  logger.info({ sender, senderNumber, text }, '📩 Mensaje entrante');

  if (!allow(sender)) {
    await sock.sendMessage(sender, { text: '🚦 Estás enviando mensajes muy rápido. Intenta en un momento.' });
    return;
  }
  if (userCooldowns.has(sender) && Date.now() < userCooldowns.get(sender)) {
    await sock.sendMessage(sender, { text: '⏳ Espera 10 segundos antes de otra consulta.' });
    return;
  }

  /* =======================
     Comandos ADMIN
     ======================= */
  if (text === '#help') {
    await sendAckAndHold(sock, sender, '📖 Enviando ayuda…', 500);
    await sock.sendMessage(sender, {
      text: HELP_USER + (isAdmin(senderNumber)
        ? '\n\nℹ️ Eres admin: usa *#helpadmin* para ver todos los comandos.'
        : '')
    });
    return;
  }

  if (text === '#helpadmin') {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    await sendAckAndHold(sock, sender, '📖 Enviando ayuda admin…', 500);
    await sock.sendMessage(sender, { text: HELP_ADMIN });
    return;
  }

  if (text === '#whoami') {
    await sock.sendMessage(sender, {
      text: `num: ${senderNumber}\nadmin: ${isAdmin(senderNumber)}\nadmins: ${ADMINS.join(',')}\nraw: ${rawAdmins}`
    });
    return;
  }

  if (text.startsWith('#maintenance')) {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    const arg = text.split(/\s+/)[1]?.toLowerCase();
    if (arg === 'on') { MAINTENANCE = true;  await sock.sendMessage(sender, { text: '🛠️ Modo mantenimiento: *ON*' }); }
    else if (arg === 'off') { MAINTENANCE = false; await sock.sendMessage(sender, { text: '🟢 Modo mantenimiento: *OFF*' }); }
    else await sock.sendMessage(sender, { text: 'Uso: #maintenance on|off' });
    logger.info({ MAINTENANCE }, 'maintenance toggled');
    return;
  }

  if (text === '#reset') {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    clearState(sender);
    usuariosBienvenidos.delete(sender);
    resetSenderLocks(sender);
    await sock.sendMessage(sender, { text: '♻️ Estado reiniciado para este chat.' });
    await sendMenuOnce(sock, sender);
    logger.info({ senderNumber }, 'reset chat state');
    return;
  }

  // #services
  if (text === '#services') {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    await sendAckAndHold(sock, sender, '🔎 Descubriendo servicios…', 600);
    const [pl, sv] = await withTyping(sock, sender, async () => {
      const a = await listPlataformasClientes();
      const b = await listServiciosCodes();
      return [a, b];
    }, 1500);
    await sock.sendMessage(sender, { text: formatoPlataformas(pl, sv) });
    return;
  }

  // #health
  if (text === '#health') {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    await sendAckAndHold(sock, sender, '🩺 Verificando estado…', 500);
    try {
      const pong = await withTyping(sock, sender, () => selectSafe('SELECT 1 AS ok'), 900);
      const okDb = Array.isArray(pong) && pong[0]?.ok === 1;
      const r = await withTyping(sock, sender, () => resumenGeneralClientes(), 900);
      const lines = [
        '🩺 *Health check*',
        `• WA Socket: ${sock?.user?.id ? '🟢 OK' : '🟡 Conectando…'}`,
        `• DB MySQL: ${okDb ? '🟢 OK' : '🔴 ERROR'}`,
        '',
        formatoResumenGeneral(r)
      ].join('\n');
      await sock.sendMessage(sender, { text: lines });
    } catch (err) {
      await sock.sendMessage(sender, { text: `❌ Health error: ${err.message}` });
    }
    return;
  }

  // #checkmedia
  if (text === '#checkmedia') {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    const info = getFileInfo('./media/tutorial.mp4');
    if (!info.exists) {
      await sock.sendMessage(sender, { text: '❌ No existe ./media/tutorial.mp4' });
    } else {
      await sock.sendMessage(sender, {
        text: `📁 tutorial.mp4\n• Ruta: ${info.abs}\n• Tamaño: ${info.sizeMB} MB\n• MTime: ${info.mtime.toLocaleString()}`
      });
    }
    return;
  }

  // #stats
  if (text.startsWith('#stats')) {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    const parts = text.split(/\s+/);
    const svcInput = parts[1] || null;

    await sendAckAndHold(sock, sender, '📊 Calculando estadísticas…', 800);
    try {
      if (!svcInput) {
        const r = await withTyping(sock, sender, () => resumenGeneralClientes(), 1500);
        await sock.sendMessage(sender, { text: formatoResumenGeneral(r) });
      } else {
        const [rc, rcode] = await withTyping(sock, sender, async () => {
          const a = await resumenClientesPorServicio(svcInput);
          const b = await resumenCodesPorServicio(svcInput);
          return [a, b];
        }, 1800);

        const bloque1 = formatoResumenServicioClientes(rc);
        const bloque2 = rcode ? `\n\n${formatoResumenServicioCodes(rcode)}` : '';
        await sock.sendMessage(sender, { text: `${bloque1}${bloque2}` });
      }
    } catch (err) {
      await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` });
    }
    return;
  }

  // #codes
  if (text.startsWith('#codes')) {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    const parts = text.split(/\s+/);
    if (!parts[1]) return await sock.sendMessage(sender, { text: '⚠️ Uso: #codes <servicioEnCodes> [limit=10]' });
    const svcInput = parts[1];
    const limit = parts[2] ? Math.max(1, parseInt(parts[2], 10) || 10) : 10;

    await sendAckAndHold(sock, sender, `🧩 Revisando códigos de ${svcInput}…`, 600);
    try {
      const list = await withTyping(sock, sender, () => codesRecientesServicio(svcInput, limit), 1500);
      await sock.sendMessage(sender, { text: formatoCodes(list, svcInput) });
    } catch (err) {
      await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` });
    }
    return;
  }

  // #mails
  if (text.startsWith('#mails')) {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    const parts = text.split(/\s+/);
    if (!parts[1]) return await sock.sendMessage(sender, { text: 'Uso: #mails <plataforma> [limit=100]' });
    const svcInput = parts[1];
    const limit = parts[2] ? Math.max(1, parseInt(parts[2], 10) || 100) : 100;

    await sendAckAndHold(sock, sender, `✉️ Listando correos de ${svcInput}…`, 600);
    try {
      const rows = await withTyping(sock, sender, () => correosPorPlataforma(svcInput, limit), 1500);
      await sock.sendMessage(sender, { text: formatoCorreosServicio(rows, svcInput) });
    } catch (err) {
      await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` });
    }
    return;
  }

  // #topcorreos
  if (text.startsWith('#topcorreos')) {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    const parts = text.split(/\s+/);
    if (!parts[1]) return await sock.sendMessage(sender, { text: 'Uso: #topcorreos <plataforma> [limit=20]' });
    const svcInput = parts[1];
    const limit = parts[2] ? Math.max(1, parseInt(parts[2], 10) || 20) : 20;

    await sendAckAndHold(sock, sender, `📈 Top correos en ${svcInput}…`, 600);
    try {
      const rows = await withTyping(sock, sender, () => correosPorPlataforma(svcInput, limit), 1500);
      await sock.sendMessage(sender, { text: formatoTopCorreos(rows, svcInput) });
    } catch (err) {
      await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` });
    }
    return;
  }

  // #dup
  if (text.startsWith('#dup')) {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    const parts = text.split(/\s+/);
    let svc = null;
    let min = 2;

    if (parts[1]) {
      const maybeNum = parseInt(parts[1], 10);
      if (!Number.isNaN(maybeNum)) min = Math.max(2, maybeNum);
      else {
        svc = parts[1];
        if (parts[2]) {
          const n = parseInt(parts[2], 10);
          if (!Number.isNaN(n)) min = Math.max(2, n);
        }
      }
    }

    await sendAckAndHold(sock, sender, '🔁 Buscando repetidos…', 1000);
    try {
      const rows = svc
        ? await withTyping(sock, sender, () => repetidosPorServicio(svc, min, 30), 2000)
        : await withTyping(sock, sender, () => repetidosGlobal(min, 30), 2000);
      await sock.sendMessage(sender, { text: formatoRepetidos(rows, svc ? `Repetidos ${svc} (min=${min})` : `Repetidos (min=${min})`) });
    } catch (err) {
      await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` });
    }
    return;
  }

  // #findnum
  if (text.startsWith('#findnum')) {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    const parts = text.split(/\s+/);
    const numero = parts[1];
    const svcInput = parts[2] || null;
    if (!numero) return await sock.sendMessage(sender, { text: 'Uso: #findnum <numeroSinPrefijo> [plataforma]' });

    await sendAckAndHold(sock, sender, `🔎 Buscando por número ${numero}${svcInput ? ' en ' + svcInput : ''}…`, 600);
    try {
      const rows = await withTyping(
        sock,
        sender,
        () => (svcInput ? findByNumeroYServicio(numero, svcInput, 50) : findByNumero(numero, 50)),
        1500
      );
      await sock.sendMessage(sender, { text: formatoClientesCompact(rows) });
    } catch (err) {
      await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` });
    }
    return;
  }

  // #findmail
  if (text.startsWith('#findmail')) {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    const q = text.split(/\s+/)[1];
    if (!q) return await sock.sendMessage(sender, { text: 'Uso: #findmail <texto>' });
    await sendAckAndHold(sock, sender, `🔎 Buscando correos que contengan "${q}"…`, 800);
    const rows = await withTyping(sock, sender, () => findByCorreoLike(q, 50), 1500);
    await sock.sendMessage(sender, { text: formatoClientesCompact(rows) });
    return;
  }

  // #renovar
  if (text.startsWith('#renovar ')) {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    const parts = text.split(/\s+/);
    const dias = parts[1] ? Math.max(1, parseInt(parts[1], 10) || 3) : 3;
    const limit = parts[2] ? Math.max(1, parseInt(parts[2], 10) || 30) : 30;

    await sendAckAndHold(sock, sender, `⏳ Buscando cuentas por renovar (≤ ${dias} días)…`, 1000);
    try {
      const list = await withTyping(sock, sender, () => cuentasPorRenovar(dias, limit), 2000);
      await sock.sendMessage(sender, { text: formatoRenovar(list, dias) });
    } catch (err) {
      await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` });
    }
    return;
  }

  // #renovar1
  if (text.startsWith('#renovar1')) {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    const parts = text.split(/\s+/);
    const limit = parts[1] ? Math.max(1, parseInt(parts[1], 10) || 50) : 50;

    await sendAckAndHold(sock, sender, '⏳ Buscando cuentas con 1 día restante…', 800);
    try {
      const rows = await withTyping(sock, sender, () => cuentasPorRenovarExacto(1, limit), 1500);
      await sock.sendMessage(sender, { text: formatoClientesCompact(rows) });
    } catch (err) {
      await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` });
    }
    return;
  }

  // #vencidos
  if (text.startsWith('#vencidos')) {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    const parts = text.split(/\s+/);
    const limit = parts[1] ? Math.max(1, parseInt(parts[1], 10) || 30) : 30;

    await sendAckAndHold(sock, sender, '❌ Buscando cuentas vencidas…', 1000);
    try {
      const list = await withTyping(sock, sender, () => cuentasVencidas(limit), 2000);
      await sock.sendMessage(sender, { text: formatoVencidas(list) });
    } catch (err) {
      await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` });
    }
    return;
  }

  // #planrenov
  if (text.startsWith('#planrenov')) {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 Sin permisos.' });
    const parts = text.split(/\s+/);
    const dias = parts[1] ? Math.max(1, parseInt(parts[1], 10) || 7) : 7;
    const limit = parts[2] ? Math.max(1, parseInt(parts[2], 10) || 100) : 100;
    await sendAckAndHold(sock, sender, `🗓️ Planeando renovaciones (próx. ${dias} días)…`, 800);
    try {
      const rows = await withTyping(sock, sender, () => planRenovacion(dias, limit), 1500);
      await sock.sendMessage(sender, { text: `🗓️ *Renovaciones próximas (${dias} días)*\n${formatoPlanRenov(rows, dias)}` });
    } catch (err) {
      await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` });
    }
    return;
  }

  // #dashboard
  if (text.startsWith('#dashboard')) {
    if (!isAdmin(senderNumber)) return await sock.sendMessage(sender, { text: '🚫 No tienes permisos para este comando.' });
    const parts = text.split(/\s+/);
    const limPR = parts[1] ? Math.max(1, parseInt(parts[1], 10) || 25) : 25;
    const limV  = parts[2] ? Math.max(1, parseInt(parts[2], 10) || 25) : 25;

    await sendAckAndHold(sock, sender, '📊 Calculando dashboard…', 1200);
    try {
      const [glob, porPlat] = await withTyping(sock, sender, async () => {
        const g  = await dashboardGlobal();
        const pp = await dashboardPorPlataforma();
        return [g, pp];
      }, 1800);

      await sock.sendMessage(sender, { text: `${formatoDashboardGlobal(glob)}\n\n${formatoDashboardPlataformas(porPlat)}` });

      if (limPR > 0) {
        const pr = await withTyping(sock, sender, () => listarPorRenovarExacto(1, limPR), 1200);
        const bloque = pr && pr.length
          ? `\n⏳ *Por renovar (1 día) – top ${limPR}*\n${formatoClientesCompact(pr)}`
          : `\n⏳ *Por renovar (1 día)*\nNo hay cuentas.`;
        await sock.sendMessage(sender, { text: bloque });
      }

      if (limV > 0) {
        const ve = await withTyping(sock, sender, () => listarVencidos(limV), 1200);
        const bloque = ve && ve.length
          ? `\n❌ *Vencidos – top ${limV}*\n${formatoClientesCompact(ve)}`
          : `\n❌ *Vencidos*\nNo hay cuentas.`;
        await sock.sendMessage(sender, { text: bloque });
      }
    } catch (err) {
      await sock.sendMessage(sender, { text: `❌ Error en dashboard: ${err.message}` });
    }
    return;
  }

  /* ===== WHITELIST / mantenimiento ===== */
  if (!(await verificarNumero(senderNumber)) && !isAdmin(senderNumber)) {
    await sock.sendMessage(sender, {
      text: '🚫 Acceso Denegado\n\nRecuerda haz tu consulta, con tu numero ligado a tu servicio:\nhttps://wa.me/5623717393?text=Solicito+acceso'
    });
    return;
  }
  if (MAINTENANCE && !isAdmin(senderNumber)) {
    await sock.sendMessage(sender, { text: '🛠️ Estamos en mantenimiento. Intenta más tarde.' });
    return;
  }

  // Expiración de estado
  const exp = userStateTTL.get(sender);
  if (exp && Date.now() > exp) {
    clearState(sender);
    await sock.sendMessage(sender, { text: '⌛ Tu sesión anterior expiró por inactividad. Volvamos a empezar.' });
    await sendMenuOnce(sock, sender);
    return;
  }

  /* ===== Flujo usuario con CANDADOS ===== */

  // A) Bienvenida (candado: 'welcome')
  if (!usuariosBienvenidos.has(sender)) {
    if (isLocked(sender, 'welcome')) return busyIfLocked(sock, sender);

    await withLock(sender, 'welcome', 25000, async () => {
      usuariosBienvenidos.add(sender); // marcar ya para no reentrar

      const nombre = await obtenerNombreUsuario(senderNumber).catch(() => null);
      const saludo = nombre
        ? `👋 Bienvenido ${nombre} al bot 🤖 de Streamingplus.`
        : '👋 Bienvenido al bot 🤖 de Streamingplus.';

      await sendTypingText(sock, sender, saludo, DELAY.GREETING);
      await sendTypingText(sock, sender, '📦 Te enviaré un video explicando cómo usar el bot.', 700);

      const ok = await sendVideoWithRetry(
        sock, sender, './media/tutorial.mp4',
        '📽️ Mira el video y sigue las instrucciones.',
        { attempts: 3, delayMs: 1500 }
      );
      if (!ok) await sock.sendMessage(sender, { text: '🔗 Si no ves el video, avísame.' });

      await sleep(1200);
      await sendMenuOnce(sock, sender);
    });
    return;
  }

  // A.1) Selección de correo específicamente para TV Netflix
  if (userWaitingEmailPick.has(sender) && userPickForTv.has(sender)) {
    const idx = parseInt(text, 10);
    const emails = userEmailOptions.get(sender) || [];

    if (!Number.isInteger(idx) || idx < 1 || idx > emails.length) {
      await sock.sendMessage(sender, {
        text: `⚠️ Opción inválida. Responde con un número del *1* al *${emails.length}*.`
      });
      return;
    }

    const email = emails[idx - 1];

    // Verificar credenciales Netflix
    const datos = await consultarMisDatos(senderNumber).catch(() => []);
    const cred = Array.isArray(datos)
      ? datos.find(d => String(d.PLATAFORMA || '').toLowerCase() === 'netflix')
      : null;

    if (!cred) {
      await sock.sendMessage(sender, { text: '⚠️ No se encontró la contraseña de Netflix.' });
      await sendMenuImageAndReset(sock, sender);
      return;
    }

    userWaitingEmailPick.delete(sender);
    userWaitingTvCode.add(sender);
    userEmailOptions.set(sender, [email]);

    await sock.sendMessage(sender, {
      text: `📧 Has elegido: *${email}*.\n✍️ Envía ahora tu *Código TV Netflix* (8 dígitos).`
    });
    return;
  }

  // B) Si está eligiendo un correo de la lista (flujo general) (candado: 'codeLookup')
  if (userWaitingEmailPick.has(sender)) {
    if (isLocked(sender, 'codeLookup')) return busyIfLocked(sock, sender);

    await withLock(sender, 'codeLookup', 25000, async () => {
      const idx = parseInt(text, 10);
      const emails = userEmailOptions.get(sender) || [];
      const servicio = userServiceSelection[sender];

      if (!Number.isInteger(idx) || idx < 1 || idx > emails.length) {
        await sock.sendMessage(sender, { text: `⚠️ Opción inválida. Responde con un número del *1* al *${emails.length}*.` });
        return;
      }

      const email = emails[idx - 1];

      await sendAckAndHold(sock, sender, `🔍 Consultando *${servicio}* para: *${email}*`, DELAY.CONFIRM_ACK);
      const rows = await withTyping(sock, sender, () =>
        consultarCorreoPorServicio(servicio, email), DELAY.CONFIRM_MIN);

      if (rows) {
        let msgOut = `✅ Resultado de ${servicio}:\n\n`;
        rows.forEach((r) => {
          if (/^\d{4}$/.test(r.mail)) msgOut += `🔢 Código: ${r.mail}\n`;
          if (r.url) msgOut += /^\d{4}$/.test(r.url) ? `🔢 Código: ${r.url}\n` : `🔗 Link: ${r.url}\n`;
        });
        await sock.sendMessage(sender, { text: msgOut });
      } else {
        await sock.sendMessage(sender, { text: `⚠️ No hay datos para ${email} en ${servicio}.` });
      }

      userCooldowns.set(sender, Date.now() + cooldownTime);
      await sendMenuImageAndReset(sock, sender);
    });
    return;
  }

  // C) Menú 0: Datos de acceso (candado: 'misdatos')
  if (opt === '0') {
    if (isLocked(sender, 'misdatos')) return busyIfLocked(sock, sender);

    await withLock(sender, 'misdatos', 20000, async () => {
      await sendAckAndHold(sock, sender, '🔄 Consultando tus datos…', DELAY.QUERY_ACK);

      const datos = await withTyping(sock, sender, () =>
        consultarMisDatos(senderNumber), DELAY.QUERY_MIN);

      const hoy = new Date().toLocaleDateString('es-MX');
      await sock.sendMessage(sender, { text: `📅 Actualizado al ${hoy}` });

      if (datos) {
        let resp = '✅ Tus datos de acceso:\n\n';
        datos.forEach((f) => {
          resp += `📺 Plataforma: ${f.PLATAFORMA}\n📧 Correo: ${f.CORREO}\n🔑 Contraseña: ${f.CONTRASEÑA}\n👤 Perfil: ${f.PERFIL}\n🔢 PIN: ${f.PIN}\n🗓️ Días restantes: ${f.DIAS_RESTANTES}\n📅 Finaliza: ${f.DIA_DE_FINALIZACION}\n\n`;
        });
        await sock.sendMessage(sender, { text: resp });
      } else {
        await sock.sendMessage(sender, { text: '⚠️ No hay datos para tu número.' });
      }

      userCooldowns.set(sender, Date.now() + cooldownTime);
      await sendMenuImageAndReset(sock, sender);
    });
    return;
  }

  // D) Selección de servicio 1/3 (candado: 'serviceLookup') — flujo general
  if (['1', '3'].includes(opt)) {
    if (isLocked(sender, 'serviceLookup')) return busyIfLocked(sock, sender);

    await withLock(sender, 'serviceLookup', 25000, async () => {
      const servicios = { '1': 'Netflix', '3': 'PrimeVideo' }; // 2 queda para TV
      const servicio = servicios[opt];
      userServiceSelection[sender] = servicio;
      armState(sender);

      await sendAckAndHold(sock, sender, `🔎 Revisando correos vinculados a *${servicio}*…`, DELAY.EMAIL_LOOKUP_ACK);
      const emails = await withTyping(sock, sender, () =>
        correosPorNumeroYServicio(senderNumber, servicio), DELAY.EMAIL_LOOKUP_MIN);

      if (!emails || emails.length === 0) {
        await sock.sendMessage(sender, {
          text: `✉️ No encontré correos vinculados a *${servicio}* para tu número.\nPor favor escribe el correo que quieres consultar.`
        });
        return;
      }

      if (emails.length === 1) {
        const email = emails[0];
        await sendAckAndHold(sock, sender, `🔍 Usaré el correo detectado: *${email}*`, DELAY.SINGLE_EMAIL_ACK);
        await sendAckAndHold(sock, sender, `🔄 Buscando código de *${servicio}*…`, DELAY.SEARCH_CODE_ACK);
        const rows = await withTyping(sock, sender, () =>
          consultarCorreoPorServicio(servicio, email), DELAY.SEARCH_CODE_MIN);

        if (rows) {
          let msgOut = `✅ Resultado de ${servicio}:\n\n`;
          rows.forEach((r) => {
            if (/^\d{4}$/.test(r.mail)) msgOut += `🔢 Código: ${r.mail}\n`;
            if (r.url) msgOut += /^\d{4}$/.test(r.url) ? `🔢 Código: ${r.url}\n` : `🔗 Link: ${r.url}\n`;
          });
          await sock.sendMessage(sender, { text: msgOut });
        } else {
          await sock.sendMessage(sender, { text: `⚠️ No hay datos para ${email} en ${servicio}.` });
        }

        userCooldowns.set(sender, Date.now() + cooldownTime);
        await sendMenuImageAndReset(sock, sender);
        return;
      }

      await sendTypingText(
        sock, sender,
        `📧 Encontré *${emails.length}* correo(s) para *${servicio}*.`,
        DELAY.MULTI_EMAIL_ANNOUNCE
      );

      userEmailOptions.set(sender, emails);
      userWaitingEmailPick.add(sender);
      await sock.sendMessage(sender, { text: renderMenuCorreos(servicio, emails) });
    });
    return;
  }

  // D.1) Opción 2: Código TV Netflix (flujo especial)
  if (opt === '2') {
    if (isLocked(sender, 'serviceLookup')) return busyIfLocked(sock, sender);

    await withLock(sender, 'serviceLookup', 30000, async () => {
      const servicio = 'Netflix';
      userServiceSelection[sender] = servicio;
      armState(sender);

      await sendAckAndHold(sock, sender, `🔎 Buscando correos vinculados a *${servicio}*…`, DELAY.EMAIL_LOOKUP_ACK);
      const emails = await withTyping(sock, sender, () =>
        correosPorNumeroYServicio(senderNumber, servicio), DELAY.EMAIL_LOOKUP_MIN);

      if (!emails || emails.length === 0) {
        await sock.sendMessage(sender, { text: `⚠️ No encontré correos de *${servicio}* para tu número.` });
        await sendMenuImageAndReset(sock, sender);
        return;
      }

      // Verificar credenciales Netflix
      const datos = await consultarMisDatos(senderNumber).catch(() => []);
      const cred = Array.isArray(datos)
        ? datos.find(d => String(d.PLATAFORMA || '').toLowerCase() === 'netflix')
        : null;

      if (!cred) {
        await sock.sendMessage(sender, { text: `⚠️ No se encontró la contraseña de *${servicio}*.` });
        await sendMenuImageAndReset(sock, sender);
        return;
      }

      if (emails.length === 1) {
        const email = emails[0];
        userEmailOptions.set(sender, [email]);
        userWaitingTvCode.add(sender);
        userPickForTv.delete(sender);
        await sock.sendMessage(sender, {
          text: `📧 Usaré el correo: *${email}*.\n✍️ Envía ahora tu *Código TV Netflix* (8 dígitos).`
        });
      } else {
        userEmailOptions.set(sender, emails);
        userWaitingEmailPick.add(sender);
        userPickForTv.add(sender); // marca que esta selección es para TV
        await sock.sendMessage(sender, { text: renderMenuCorreos(servicio, emails) });
      }
    });
    return;
  }

  // E) Correo manual con servicio activo (candado: 'codeLookup') — flujo general
  if (userServiceSelection[sender] && !userWaitingTvCode.has(sender)) {
    if (isLocked(sender, 'codeLookup')) return busyIfLocked(sock, sender);

    await withLock(sender, 'codeLookup', 25000, async () => {
      const servicio = userServiceSelection[sender];
      const email = opt;

      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!isEmail) {
        await sock.sendMessage(sender, { text: '📧 Por favor, envía un correo válido (ej: nombre@dominio.com).' });
        return;
      }

      await sendAckAndHold(sock, sender, `🔍 Validando el correo: ${email}`, DELAY.VALIDATE_ACK);
      const rows = await withTyping(sock, sender, () =>
        consultarCorreoPorServicio(servicio, email), DELAY.VALIDATE_MIN);

      if (rows) {
        let msgOut = `✅ Resultado de ${servicio}:\n\n`;
        rows.forEach((r) => {
          if (/^\d{4}$/.test(r.mail)) msgOut += `🔢 Código: ${r.mail}\n`;
          if (r.url) msgOut += /^\d{4}$/.test(r.url) ? `🔢 Código: ${r.url}\n` : `🔗 Link: ${r.url}\n`;
        });
        await sock.sendMessage(sender, { text: msgOut });
      } else {
        await sock.sendMessage(sender, { text: `⚠️ No hay datos para ${email} en ${servicio}.` });
      }

      userCooldowns.set(sender, Date.now() + cooldownTime);
      await sendMenuImageAndReset(sock, sender);
    });
    return;
  }

  // F) Recepción del Código TV Netflix (8 dígitos)
  if (userWaitingTvCode.has(sender)) {
    const tvCode = text.trim();

    if (!/^\d{8}$/.test(tvCode)) {
      await sock.sendMessage(sender, { text: '⚠️ El código debe tener *8 dígitos* (ej: 12345678).' });
      return;
    }

    const email = (userEmailOptions.get(sender) || [])[0];
    const datos = await consultarMisDatos(senderNumber).catch(() => []);
    const cred = Array.isArray(datos)
      ? datos.find(d => String(d.PLATAFORMA || '').toLowerCase() === 'netflix')
      : null;

    if (!cred) {
      await sock.sendMessage(sender, { text: '⚠️ No se encontró la contraseña de Netflix.' });
      await sendMenuImageAndReset(sock, sender);
      return;
    }

    await sock.sendMessage(sender, { text: '⏳ Procesando tu código, espera un momento…' });

    try {
      const result = await autoLoginAndSendCode({
        email,
        password: cred.CONTRASEÑA,
        tvCode
      });

      await sock.sendMessage(sender, { text: result.msg });

      if (result.ok && result.screenshot) {
        await sock.sendMessage(sender, {
          image: result.screenshot,
          caption: '📸 Captura de pantalla del ingreso exitoso'
        });
      }
    } catch (err) {
      await sock.sendMessage(sender, {
        text: `❌ Error procesando tu código: ${err.message}`
      });
    }

    await sendMenuImageAndReset(sock, sender);
    return;
  }

  // G) Comando 'menu' con control de locks/cooldown
  if (text === 'menu') {
    if (anyLockActive(sender)) {
      return busyIfLocked(sock, sender, '⏳ Estoy procesando tu solicitud, dame unos segundos…');
    }
    clearState(sender);
    await sendMenuOnce(sock, sender, { notifyIfCooldown: true });
    return;
  }

  // H) Fallback: evita menú si hay proceso largo en curso
  if (anyLockActive(sender)) {
    return busyIfLocked(sock, sender, '⏳ Sigo procesando tu solicitud…');
  }

  await sock.sendMessage(sender, { text: '⚠️ Opción no válida. Usa los números del menú.' });
  await sleep(DELAY.INVALID_ACK);
  await sendMenuOnce(sock, sender);
}

module.exports = { handleMessage };
