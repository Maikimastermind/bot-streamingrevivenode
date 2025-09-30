// bot/helpers/timing.js

// Delays por paso del flujo (ms) — según tu plano
const DELAY = {
  // A — Bienvenida
  GREETING: 2000,            // A1
  PRE_VIDEO_TEXT: 2000,      // A2
  SEND_VIDEO: 1000,          // A3
  AFTER_VIDEO_MENU: 3000,    // A4

  // B — Opción 0 (Datos de acceso)
  QUERY_ACK: 5000,           // B2: "Consultando tus datos…"
  QUERY_MIN: 5000,           // B3: mínimo mostrando typing
  POST_REPLY_MENU_B: 3000,   // B5: menú después de datos

  // C — Elegir servicio (1/2/3)
  EMAIL_LOOKUP_ACK: 5000,    // C2: "Revisando correos vinculados…"
  EMAIL_LOOKUP_MIN: 7000,    // C3: mínimo typing lookup

  // D — 1 correo encontrado (auto)
  SINGLE_EMAIL_ACK: 8000,    // D1: "Usaré el correo…"
  SEARCH_CODE_ACK: 18000,    // D2: "Buscando código…"
  SEARCH_CODE_MIN: 3000,     // D3: mínimo typing búsqueda
  POST_REPLY_MENU_D: 3000,   // D5

  // E — Varios correos
  MULTI_EMAIL_ANNOUNCE: 5000, // E1: "Encontré N correos…"
  CONFIRM_ACK: 15000,          // E4: "Consultando {servicio} para: {email}"
  CONFIRM_MIN: 10000,         // E5: mínimo typing consulta final
  POST_REPLY_MENU_E: 3000,    // E7

  // F — Correo manual
  VALIDATE_ACK: 5000,         // F3: "Validando el correo…"
  VALIDATE_MIN: 15000,        // F4: mínimo typing en validación
  POST_REPLY_MENU_F: 5000,    // F5

  // G — Opción inválida
  INVALID_ACK: 3000,          // G2: reenvío de menú tras inválida
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function typingStart(sock, jid) {
  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate('composing', jid);
  } catch {}
}
async function typingStop(sock, jid) {
  try {
    await sock.sendPresenceUpdate('paused', jid);
  } catch {}
}

/**
 * Manda el texto de ACK inmediatamente y LUEGO mantiene "escribiendo…" `ms`.
 * Ideal para: "🔄 Consultando…", "🔎 Revisando…", "🔄 Buscando…"
 */
async function sendAckAndHold(sock, jid, text, ms) {
  const t0 = Date.now();
  console.log(`[timing] ACK -> "${text}" (ms=${ms})`);
  await sock.sendMessage(jid, { text });
  await typingStart(sock, jid);
  await sleep(ms);
  await typingStop(sock, jid);
  console.log(`[timing] ACK hold done in ${Date.now() - t0}ms`);
}

/**
 * (Compat anterior) Muestra "escribiendo…" `ms` y luego envía el texto.
 * Suele usarse para saludos / bienvenida cuando quieres pausar antes de hablar.
 */
async function sendTypingText(sock, jid, text, ms) {
  const t0 = Date.now();
  console.log(`[timing] pre-typing -> "${text}" (ms=${ms})`);
  await typingStart(sock, jid);
  await sleep(ms);
  await typingStop(sock, jid);
  await sock.sendMessage(jid, { text });
  console.log(`[timing] pre-typing done in ${Date.now() - t0}ms`);
}

/**
 * Ejecuta `fn()` mostrando "escribiendo…" y garantiza un mínimo total `ms`.
 * Si la consulta es más rápida, rellena; si es más lenta, no la corta.
 */
async function withTyping(sock, jid, fn, ms) {
  const t0 = Date.now();
  console.log(`[timing] withTyping start (min=${ms}ms)`);
  await typingStart(sock, jid);
  let res, err;
  try { res = await fn(); } catch (e) { err = e; }
  const elapsed = Date.now() - t0;
  if (elapsed < ms) {
    const pad = ms - elapsed;
    console.log(`[timing] withTyping pad ${pad}ms`);
    await sleep(pad);
  }
  await typingStop(sock, jid);
  console.log(`[timing] withTyping done in ${Date.now() - t0}ms`);
  if (err) throw err;
  return res;
}

module.exports = { sleep, sendTypingText, sendAckAndHold, withTyping, DELAY };
