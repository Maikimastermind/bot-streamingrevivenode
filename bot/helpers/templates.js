// bot/helpers/templates.js
const header = () => '╔═ ✨ *StreamingPlus* ✨ ═╗';
const footer = () => '╚═══════════════════╝';
const menu = () => [
  header(),
  '   🤖 *MENÚ PRINCIPAL*',
  '─────────────────────',
  '0️⃣  ➝ *Datos de acceso*',
  '1️⃣  ➝ *Código Netflix*',
  '2️⃣  ➝ *Código TV Netflix (8 dígitos)*',
  '3️⃣  ➝ *Código Prime Video*',
  '',
  '✍️ Responde con el *número* de la opción.',
  footer(),
].join('\n');

module.exports = { menu, header, footer };

