// bot/helpers/flowGuard.js
// Guardas de flujo: anti-duplicados y candados con TTL por paso

const locks = new Map();   // sender -> Map<key, expiry>
const lastMsg = new Map(); // sender -> { text, at }
const DUP_WINDOW_MS = 2500; // 2.5s: ventana para suprimir duplicados exactos

const now = () => Date.now();

function shouldDropDuplicate(sender, text) {
  const prev = lastMsg.get(sender);
  if (!prev) return false;
  return prev.text === text && (now() - prev.at) < DUP_WINDOW_MS;
}

function markMessage(sender, text) {
  lastMsg.set(sender, { text, at: now() });
}

function _lockMap(sender) {
  if (!locks.has(sender)) locks.set(sender, new Map());
  return locks.get(sender);
}

function isLocked(sender, key) {
  const m = _lockMap(sender);
  const exp = m.get(key);
  if (!exp) return false;
  if (now() > exp) { m.delete(key); return false; }
  return true;
}

function lock(sender, key, ttlMs = 30000) {
  _lockMap(sender).set(key, now() + ttlMs);
}

function unlock(sender, key) {
  _lockMap(sender).delete(key);
}

async function withLock(sender, key, ttlMs, fn) {
  if (isLocked(sender, key)) return false;
  lock(sender, key, ttlMs);
  try { await fn(); return true; }
  finally { unlock(sender, key); }
}

async function busyIfLocked(sock, jid, msg = '⏳ Sigo procesando tu solicitud, por favor espera…') {
  try {
    await sock.sendMessage(jid, { text: msg });
  } catch {}
}

function resetSenderLocks(sender) {
  locks.delete(sender);
  lastMsg.delete(sender);
}

module.exports = {
  shouldDropDuplicate, markMessage,
  isLocked, lock, unlock, withLock, busyIfLocked,
  resetSenderLocks,
};
