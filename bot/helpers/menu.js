// bot/helpers/menu.js
const { menu } = require('./templates');

async function enviarMenu(sock, sender) {
  await sock.sendMessage(sender, { text: menu() });
}

module.exports = { enviarMenu };

