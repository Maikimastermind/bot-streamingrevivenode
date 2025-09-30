// lib/media.js
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const cache = new Map();

function bytesToMB(b) { return Math.round((b / 1024 / 1024) * 10) / 10; }

function getFileInfo(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return { exists: false, abs };
  const stat = fs.statSync(abs);
  return { exists: true, abs, size: stat.size, mtime: stat.mtime, sizeMB: bytesToMB(stat.size) };
}

function loadBuffer(filePath, useCache = true) {
  const abs = path.resolve(filePath);
  if (useCache && cache.has(abs)) return cache.get(abs);
  const buf = fs.readFileSync(abs);
  if (useCache) cache.set(abs, buf);
  return buf;
}

/** Video con reintentos */
async function sendVideoWithRetry(
  sock, jid, filePath, caption,
  { attempts = 3, delayMs = 1200, mimetype = 'video/mp4', useCache = true } = {}
) {
  const info = getFileInfo(filePath);
  if (!info.exists) {
    logger.error({ filePath }, '[media] ❌ No existe el archivo de video');
    try { await sock.sendMessage(jid, { text: '⚠️ No pude adjuntar el video ahora mismo.' }); } catch {}
    return false;
  }

  logger.info({ file: info.abs, sizeMB: info.sizeMB }, '[media] Enviando video…');
  if (info.sizeMB > 16) logger.warn({ sizeMB: info.sizeMB }, '[media] Tamaño alto; podría fallar en WhatsApp Web');

  for (let i = 1; i <= attempts; i++) {
    try {
      const media = loadBuffer(filePath, useCache);
      await sock.sendMessage(jid, { video: media, caption, mimetype });
      logger.info({ attempt: i }, '[media] ✅ Video enviado');
      return true;
    } catch (err) {
      logger.error({ attempt: i, err }, '[media] Error enviando video');
      if (i < attempts) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return false;
}

/** Imagen con reintentos */
async function sendImageWithRetry(
  sock, jid, filePath, caption,
  { attempts = 3, delayMs = 800, mimetype = 'image/png', useCache = true } = {}
) {
  const info = getFileInfo(filePath);
  if (!info.exists) {
    logger.error({ filePath }, '[media] ❌ No existe la imagen');
    try { await sock.sendMessage(jid, { text: '⚠️ No pude adjuntar la imagen ahora mismo.' }); } catch {}
    return false;
  }

  logger.info({ file: info.abs, sizeMB: info.sizeMB }, '[media] Enviando imagen…');

  for (let i = 1; i <= attempts; i++) {
    try {
      const media = loadBuffer(filePath, useCache);
      await sock.sendMessage(jid, { image: media, caption, mimetype });
      logger.info({ attempt: i }, '[media] ✅ Imagen enviada');
      return true;
    } catch (err) {
      logger.error({ attempt: i, err }, '[media] Error enviando imagen');
      if (i < attempts) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return false;
}

// 👇 Asegúrate que esta línea incluya sendImageWithRetry
module.exports = { getFileInfo, sendVideoWithRetry, sendImageWithRetry };
