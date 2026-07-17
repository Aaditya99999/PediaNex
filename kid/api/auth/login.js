import {
  buildSessionCookie,
  createSessionToken,
  getAccessPassword,
  isAuthConfigured
} from '../../lib/auth.js';

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  for (const [header, value] of Object.entries(extraHeaders)) {
    res.setHeader(header, value);
  }

  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const rawBody = Buffer.concat(chunks).toString('utf-8') || '{}';
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  let payload = {};

  try {
    payload = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid request body.' });
    return;
  }

  const submittedPassword = String(payload?.password || '').trim();
  const configuredPassword = getAccessPassword();

  if (!isAuthConfigured()) {
    sendJson(res, 503, { error: 'Clinic access is not configured. Please contact support.' });
    return;
  }

  if (!submittedPassword || submittedPassword !== configuredPassword) {
    sendJson(res, 401, { error: 'Incorrect password. Please try again.' });
    return;
  }

  const token = await createSessionToken();

  sendJson(res, 200, { ok: true }, {
    'Set-Cookie': buildSessionCookie(token)
  });
}
