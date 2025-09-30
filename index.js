// index.js
require('dotenv').config();
require('./lib/env');

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const logger = require('./lib/logger');

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

const { handleMessage } = require('./bot/handlers/messageHandler');

async function iniciarBot() {
  const sessionFolder = path.resolve(__dirname, './session/auth_info');
  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📲 Escanea este QR con WhatsApp -> Dispositivos vinculados:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('✅ ¡Bot conectado a WhatsApp!');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      logger.warn({ statusCode, err: lastDisconnect?.error }, '⚠️ Conexión cerrada');

      // No usamos scheduler, así que no hay stopAutoReminders() aquí

      if (statusCode !== DisconnectReason.loggedOut) {
        logger.info({ retryIn: 10000 }, '↻ Reintentando conexión…');
        setTimeout(iniciarBot, 10_000);
      } else {
        logger.info('🔒 Sesión invalidada. Elimina ./session/auth_info para escanear de nuevo.');
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages?.[0];
    if (!msg) return;
    try {
      await handleMessage(sock, msg);
    } catch (err) {
      logger.error({ err }, '⛔ Error procesando mensaje');
    }
  });
}

iniciarBot();
