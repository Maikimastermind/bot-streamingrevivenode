// bot/guards/rateLimit.js
const WINDOW = 15_000; // 15s
const MAX = 5;         // máx mensajes por ventana
const buckets = new Map();

function allow(jid) {
  const now = Date.now();
  const arr = (buckets.get(jid) || []).filter((t) => now - t < WINDOW);
  arr.push(now);
  buckets.set(jid, arr);
  return arr.length <= MAX;
}

module.exports = { allow };

