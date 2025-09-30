const puppeteer = require('puppeteer');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'streaming',
};

async function autoLoginAndSendCode({ email, password, tvCode }) {
  let browser, connection;

  try {
    console.log('[🚀] Lanzando navegador...');
    browser = await puppeteer.launch({
      headless: "new",
      slowMo: 100,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    console.log('[🌐] Abriendo Netflix login...');

    await page.goto('https://www.netflix.com/mx/login', { waitUntil: 'networkidle2' });

    console.log('[🖱️] Click en usar código...');
    await page.waitForSelector('[data-uia="use-code-button"]', { timeout: 10000 });
    await page.click('[data-uia="use-code-button"]');

    console.log('[✉️] Escribiendo correo...');
    await page.waitForSelector('[data-uia="field-userLoginId"]', { timeout: 10000 });
    await page.type('[data-uia="field-userLoginId"]', email, { delay: 80 });

    console.log('[📩] Enviando código...');
    await page.waitForSelector('[data-uia="send-code-button"]', { timeout: 10000 });
    await page.click('[data-uia="send-code-button"]');

    console.log('[⏳] Esperando 50 segundos para que llegue el código...');
    await new Promise(res => setTimeout(res, 50000));

    await page.waitForSelector('[data-uia="verify-pin-entry"]', { timeout: 10000 });

    console.log('[🗄️] Conectando a la base de datos...');
    connection = await mysql.createConnection(DB_CONFIG);

    console.log('[🔍] Buscando código en DB...');
    const [rows] = await connection.execute(
      `SELECT url 
       FROM codes 
       WHERE mail = ? 
         AND service = 'Netflix' 
         AND used = 0 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [email]
    );

    if (!rows || rows.length === 0) {
      return { ok: false, msg: '⚠️ No hay código disponible para este correo en la base de datos.' };
    }

    const dbCode = String(rows[0].url).trim();
    console.log('[✅] Código obtenido de DB:', dbCode);

    await page.type('[data-uia="verify-pin-entry"]', dbCode, { delay: 80 });

    console.log('[🔐] Iniciando sesión...');
    await page.waitForSelector('[data-uia="sign-in-button"]', { timeout: 10000 });
    await page.click('[data-uia="sign-in-button"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });

    console.log('[📺] Entrando a TV8...');
    await page.goto('https://www.netflix.com/tv8', { waitUntil: 'networkidle2' });

    await page.waitForSelector('input.pin-number-input', { timeout: 10000 });
    const inputs = await page.$$('input.pin-number-input');

    if (inputs.length !== tvCode.length) {
      return { ok: false, msg: `❌ El código TV debe tener ${inputs.length} dígitos.` };
    }

    console.log('[🔢] Ingresando código TV...');
    for (let i = 0; i < tvCode.length; i++) {
      await inputs[i].type(tvCode[i], { delay: 120 });
    }

    console.log('[👉] Click en continuar...');
    await page.click('button.tvsignup-continue-button');

    console.log('[⏳] Esperando 3 segundos...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    const currentUrl = page.url();
    console.log('[🌐] URL actual:', currentUrl);

    if (currentUrl.includes('/tv/out/success')) {
      console.log('[✅] Acceso exitoso. Tomando screenshot...');
      const screenshotsDir = path.join(__dirname, '../../media/screenshots');
      if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
      const screenshotPath = path.join(screenshotsDir, `tvcode-success-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      console.log('[🗄️] Actualizando DB (marcar código usado)...');
      try {
        const [result] = await connection.execute(
          'UPDATE codes SET used = 1 WHERE mail = ? AND url = ?',
          [email, dbCode]
        );
        console.log(`[📦] Código marcado como usado (filas afectadas: ${result.affectedRows})`);

        // 🕒 Espera breve para asegurar que el write se complete bien
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (updateErr) {
        console.error('[❌] Error al actualizar DB:', updateErr.message);
      }

      try {
        await connection.end();
        console.log('[🔒] Conexión MySQL cerrada.');
      } catch (errClose) {
        console.error('[❌] Error cerrando conexión:', errClose.message);
      }

      try {
        await browser.close();
        console.log('[🧹] Navegador cerrado.');
      } catch (errBrowser) {
        console.error('[❌] Error cerrando navegador:', errBrowser.message);
      }

      return {
        ok: true,
        msg: '✅ Tu TV quedó lista para ver Netflix 🎉',
        screenshot: fs.readFileSync(screenshotPath),
      };
    } else {
      console.log('[❌] No se detectó confirmación de éxito en TV.');
      return { ok: false, msg: '❌ No se detectó confirmación de acceso en TV.' };
    }

  } catch (err) {
    console.error('[❌] Error en autoLoginAndSendCode:', err.message);
    return { ok: false, msg: `❌ Error en el proceso: ${err.message}` };

  } finally {
    // Cierre de seguridad si no se cerraron antes
    if (connection) {
      try { await connection.end(); } catch (_) {}
    }
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
}

module.exports = {
  autoLoginAndSendCode,
};
