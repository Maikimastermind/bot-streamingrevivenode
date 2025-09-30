// jobs/recordatorios.js
const logger = require('../lib/logger');
require('../lib/env'); // carga .env
const { sleep } = require('../bot/helpers/timing');

// Usamos funciones que ya tienes en db/analytics.
// Si aún no aceptan "plataforma", el argumento extra se ignora sin problema.
const {
  cuentasPorRenovar,
  cuentasVencidas,
} = require('../db/analytics');

/** Convierte 10 dígitos locales a JID de WhatsApp */
function jidFromLocal(num) {
  const d = String(num || '').replace(/\D/g, '').replace(/^52/, '').slice(-10);
  return `521${d}@s.whatsapp.net`;
}

function plural(n, s, p) { return `${n} ${n === 1 ? s : (p || s + 's')}`; }

function msgRenovar(row) {
  const nombre     = row.NOMBRE || '';
  const plataforma = row.PLATAFORMA || row.plataforma || 'tu servicio';
  const dias       = Number(row.DIAS_RESTANTES ?? row.dias_restantes ?? 0);
  const fecha      = row.DIA_DE_FINALIZACION || row.dia_de_finalizacion || '';
  return [
    `⏳ Hola ${nombre || '👋'}`,
    `Tu *${plataforma}* vence el *${fecha}*`,
    `Te quedan *${plural(dias, 'día')}*.`,
    `Si quieres renovar, responde por aquí y te ayudamos. 🙌`
  ].join('\n');
}

function msgVencido(row) {
  const nombre     = row.NOMBRE || '';
  const plataforma = row.PLATAFORMA || row.plataforma || 'tu servicio';
  const fecha      = row.DIA_DE_FINALIZACION || row.dia_de_finalizacion || '';
  return [
    `❌ Hola ${nombre || '👋'}`,
    `Tu *${plataforma}* finalizó el *${fecha}*.`,
    `¿Deseas reactivarlo? Escríbenos por aquí y lo vemos. 🔁`
  ].join('\n');
}

/**
 * Enviar recordatorios a cuentas por renovar (DIAS_RESTANTES <= dias)
 * Opcional: filtrar por plataforma.
 */
async function avisarClientes(sock, dias = 3, limit = 50, plataforma = null, dryRun = false) {
  const list = await cuentasPorRenovar(dias, limit, plataforma);
  logger.info({ dias, limit, plataforma, count: list.length }, '[avisos] por renovar');
  if (dryRun) return { count: list.length };

  let sent = 0;
  for (const r of list) {
    try {
      const to  = jidFromLocal(r.NUMERO || r.numero);
      const msg = msgRenovar(r);
      await sock.sendMessage(to, { text: msg });
      sent++;
      await sleep(400); // pausa corta para no saturar
    } catch (err) {
      logger.error({ err, row: r }, '[avisos] error enviando por renovar');
    }
  }
  logger.info({ sent, total: list.length }, '[avisos] por renovar enviados');
  return { count: list.length, sent };
}

/**
 * Enviar recordatorios a cuentas vencidas (DIA_DE_FINALIZACION < hoy)
 * Opcional: filtrar por plataforma.
 */
async function avisarVencidos(sock, limit = 50, plataforma = null, dryRun = false) {
  const list = await cuentasVencidas(limit, plataforma);
  logger.info({ limit, plataforma, count: list.length }, '[avisos] vencidos');
  if (dryRun) return { count: list.length };

  let sent = 0;
  for (const r of list) {
    try {
      const to  = jidFromLocal(r.NUMERO || r.numero);
      const msg = msgVencido(r);
      await sock.sendMessage(to, { text: msg });
      sent++;
      await sleep(400);
    } catch (err) {
      logger.error({ err, row: r }, '[avisos] error enviando vencido');
    }
  }
  logger.info({ sent, total: list.length }, '[avisos] vencidos enviados');
  return { count: list.length, sent };
}

/** Atajo por plataforma (por renovar) */
async function avisarClientesPlataforma(sock, plataforma, dias = 3, limit = 50, dryRun = false) {
  return avisarClientes(sock, dias, limit, plataforma, dryRun);
}

/** Mensaje directo a un número */
async function avisarClienteUnico(sock, numero, texto = null) {
  const to  = jidFromLocal(numero);
  const msg = texto || '🔔 Hola, te escribe *StreamingPlus*. ¿Te ayudamos con tu cuenta?';
  await sock.sendMessage(to, { text: msg });
  logger.info({ numero }, '[avisos] enviado a número único');
  return { to };
}

module.exports = {
  avisarClientes,
  avisarClientesPlataforma,
  avisarVencidos,
  avisarClienteUnico,
};
