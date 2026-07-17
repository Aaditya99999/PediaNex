export const SESSION_COOKIE_NAME = 'clinic_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

const APP_BASE_SEGMENT = '/emr/kid';

const PROTECTED_PATHS = new Set([
  '/',
  '/index',
  '/growth-chart-dashboard',
  '/KID/growth-chart-dashboard',
  '/prescription',
  '/KID/prescription',
  '/preview',
  '/KID/preview',
  '/pending-approvals',
  '/patient-details',
  '/reception-qr',
  '/search',
  '/settings',
  '/test',
  '/vaccination',
  '/vacination',
  '/prescription-growth-chart-dashboard',
  '/KID/prescription-growth-chart-dashboard',
  '/api/growth_charts'
]);

const PUBLIC_PATHS = new Set([
  '/password',
  '/new-patient',
  '/intake',
  '/rx',
  '/KID/rx',
  '/portal',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/patients/create',
  '/api/patients/next-id'
]);

function getCryptoApi() {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto is not available in this runtime.');
  }
  return globalThis.crypto;
}

function getAuthSecret() {
  return String(process.env.CLINIC_SESSION_SECRET || '').trim();
}

export function getAccessPassword() {
  return String(process.env.CLINIC_ACCESS_PASSWORD || '').trim();
}

export function isAuthConfigured() {
  return Boolean(getAccessPassword() && getAuthSecret());
}

function normalizeSlashes(pathname) {
  return pathname.replace(/\/{2,}/g, '/');
}

export function normalizeAppPath(pathname) {
  let normalized = pathname || '/';

  if (normalized.startsWith(APP_BASE_SEGMENT + '/')) {
    normalized = normalized.slice(APP_BASE_SEGMENT.length);
  } else if (normalized === APP_BASE_SEGMENT) {
    normalized = '/';
  }

  normalized = normalizeSlashes(normalized);

  if (normalized.startsWith('/KID/')) {
    normalized = normalized.slice('/KID'.length);
  } else if (normalized === '/KID') {
    normalized = '/';
  }

  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  if (normalized.endsWith('.html')) {
    normalized = normalized.slice(0, -5) || '/';
  }

  return normalized || '/';
}

export function shouldUseAppBase(pathname) {
  return pathname === APP_BASE_SEGMENT || pathname.startsWith(APP_BASE_SEGMENT + '/');
}

export function withBasePath(pathname, useAppBase) {
  const normalized = pathname === '/' ? '' : pathname;
  return useAppBase ? `${APP_BASE_SEGMENT}${normalized}` : (pathname || '/');
}

export function getLoginPath(useAppBase) {
  return withBasePath('/password', useAppBase);
}

export function getDefaultProtectedPath(useAppBase) {
  return withBasePath('/index', useAppBase);
}

export function isProtectedPath(pathname) {
  return PROTECTED_PATHS.has(normalizeAppPath(pathname));
}

export function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(normalizeAppPath(pathname));
}

function parseCookies(cookieHeader = '') {
  const cookies = {};

  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    cookies[key] = value;
  }

  return cookies;
}

function bytesToBase64Url(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }

  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function importSigningKey() {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error('CLINIC_SESSION_SECRET is missing.');
  }

  return getCryptoApi().subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function signValue(value) {
  const key = await importSigningKey();
  const signature = await getCryptoApi().subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(signature));
}

export async function createSessionToken() {
  const payload = {
    exp: Date.now() + (SESSION_TTL_SECONDS * 1000)
  };

  const encodedPayload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await signValue(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export async function verifySessionToken(token) {
  if (!token || typeof token !== 'string') {
    return false;
  }

  const [encodedPayload, providedSignature] = token.split('.');
  if (!encodedPayload || !providedSignature) {
    return false;
  }

  const expectedSignature = await signValue(encodedPayload);
  if (providedSignature !== expectedSignature) {
    return false;
  }

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload)));
    return Number(payload?.exp) > Date.now();
  } catch {
    return false;
  }
}

export async function isAuthenticatedCookieHeader(cookieHeader = '') {
  const cookies = parseCookies(cookieHeader);
  if (!getAuthSecret()) {
    return false;
  }

  return verifySessionToken(cookies[SESSION_COOKIE_NAME]);
}

export function buildSessionCookie(token) {
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];

  if (process.env.NODE_ENV === 'production') {
    cookieParts.push('Secure');
  }

  return cookieParts.join('; ');
}

export function buildClearedSessionCookie() {
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0'
  ];

  if (process.env.NODE_ENV === 'production') {
    cookieParts.push('Secure');
  }

  return cookieParts.join('; ');
}

export function buildLoginRedirect(pathname, search = '') {
  const useAppBase = shouldUseAppBase(pathname);
  const loginPath = getLoginPath(useAppBase);
  const nextValue = `${pathname}${search || ''}`;
  return `${loginPath}?next=${encodeURIComponent(nextValue)}`;
}

export function sanitizeNextPath(nextPath, fallbackPath = '/index') {
  if (!nextPath || typeof nextPath !== 'string') {
    return fallbackPath;
  }

  if (!nextPath.startsWith('/') || nextPath.startsWith('//')) {
    return fallbackPath;
  }

  return nextPath;
}
