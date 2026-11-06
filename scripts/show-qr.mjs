import { createRequire } from 'node:module';
import dotenv from 'dotenv';

dotenv.config({ override: false });

const require = createRequire(import.meta.url);
const QRCode = require('qrcode');

const port = process.env.PORT || '3000';
const apiKey = process.env.API_KEY;

if (!apiKey) {
  console.error('API_KEY is required. Set it in the environment or in .env.');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${apiKey}` };
const baseUrl = `http://127.0.0.1:${port}`;

for (let attempt = 1; attempt <= 30; attempt += 1) {
  const response = await fetch(`${baseUrl}/api/session/qr`, { headers });

  if (response.status === 200) {
    const body = await response.json();
    if (typeof body.qr !== 'string' || body.qr.length === 0) {
      console.error('The QR response did not include a payload.');
      process.exit(1);
    }
    const rendered = await QRCode.toString(body.qr, { type: 'terminal', small: true });
    console.log('Scan this code in WhatsApp: Settings -> Linked devices -> Link a device.');
    console.log(rendered);
    console.log('The raw QR payload was printed only as a terminal QR and was not written to a file.');
    process.exit(0);
  }

  if (response.status === 409) {
    const statusResponse = await fetch(`${baseUrl}/api/session/status`, { headers });
    const statusBody = await statusResponse.json();
    console.log(`Pairing QR is not available. Current status: ${statusBody.status ?? 'unknown'}`);
    process.exit(statusBody.status === 'CONNECTED' ? 0 : 1);
  }

  if (response.status === 401) {
    console.error('The gateway rejected API_KEY.');
    process.exit(1);
  }

  await new Promise((resolve) => {
    setTimeout(resolve, 2000);
  });
}

console.error('No pairing QR became available. Check GET /api/session/status.');
process.exit(1);
