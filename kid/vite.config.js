import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { cpSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  buildClearedSessionCookie,
  buildLoginRedirect,
  buildSessionCookie,
  createSessionToken,
  getAccessPassword,
  getDefaultProtectedPath,
  isAuthConfigured,
  isAuthenticatedCookieHeader,
  isProtectedPath,
  normalizeAppPath,
  shouldUseAppBase
} from './lib/auth.js';

const repoRoot = resolve(__dirname, '..', '..');
const pythonChartRendererScript = resolve(__dirname, 'scripts', 'render_growth_charts.py');
const nodeModulesRoot = existsSync(resolve(__dirname, 'node_modules')) ? __dirname : resolve(__dirname, '..');
const pythonCommands = [
  ['python', [pythonChartRendererScript]],
  ['py', ['-3', pythonChartRendererScript]]
];

function runPythonChartRenderer(requestBody) {
  for (const [command, args] of pythonCommands) {
    const result = spawnSync(command, args, {
      cwd: repoRoot,
      input: requestBody,
      encoding: 'utf-8',
      shell: false
    });

    if (result.status === 0) {
      return { ok: true, body: result.stdout };
    }

    if (result.error?.code === 'ENOENT') {
      continue;
    }

    return {
      ok: false,
      statusCode: 500,
      body: JSON.stringify({
        error: result.stdout?.trim() || result.stderr?.trim() || 'Python chart renderer failed.'
      })
    };
  }

  return {
    ok: false,
    statusCode: 500,
    body: JSON.stringify({
      error: 'Python is not available for local chart rendering.'
    })
  };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  for (const [header, value] of Object.entries(extraHeaders)) {
    res.setHeader(header, value);
  }

  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolveBody, reject) => {
    const bodyChunks = [];

    req.on('data', (chunk) => {
      bodyChunks.push(chunk);
    });

    req.on('end', () => {
      resolveBody(Buffer.concat(bodyChunks).toString('utf-8') || '{}');
    });

    req.on('error', reject);
  });
}

export default defineConfig({
  root: __dirname,
  envDir: __dirname,
  publicDir: resolve(__dirname, 'public'),
  base: '/emr/kid/',
  resolve: {
    alias: {
      jspdf: resolve(nodeModulesRoot, 'node_modules/jspdf/dist/jspdf.es.min.js')
    }
  },
  plugins: [
    {
      name: 'copy-growth-chart-assets',
      closeBundle() {
        const distRoot = resolve(__dirname, 'dist');
        const distAssets = resolve(distRoot, 'assets');
        const chartAssetDirs = ['iap-official-png', 'who-official-png'];

        chartAssetDirs.forEach((dirName) => {
          const sourceDir = resolve(__dirname, 'assets', dirName);

          if (existsSync(sourceDir)) {
            cpSync(sourceDir, resolve(distAssets, dirName), { recursive: true });
          }
        });

        const sharedChartConfig = resolve(__dirname, 'growth_chart_config.json');

        if (existsSync(sharedChartConfig)) {
          cpSync(sharedChartConfig, resolve(distRoot, 'growth_chart_config.json'));
        }
      }
    },
    {
      name: 'clinic-auth-dev-server',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          void (async () => {
            const requestUrl = new URL(req.url || '/', 'http://localhost');
            const normalizedPath = normalizeAppPath(requestUrl.pathname);
            const authenticated = await isAuthenticatedCookieHeader(req.headers.cookie || '');

            if (normalizedPath === '/api/kid/auth/login') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'Method not allowed.' });
                return;
              }

              let payload = {};

              try {
                payload = JSON.parse(await readRequestBody(req));
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
              return;
            }

            if (normalizedPath === '/api/kid/auth/logout') {
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'Method not allowed.' });
                return;
              }

              sendJson(res, 200, { ok: true }, {
                'Set-Cookie': buildClearedSessionCookie()
              });
              return;
            }

            if (normalizedPath === '/password') {
              if (authenticated) {
                res.statusCode = 302;
                res.setHeader('Location', getDefaultProtectedPath(shouldUseAppBase(requestUrl.pathname)));
                res.end();
                return;
              }

              next();
              return;
            }

            if (isProtectedPath(requestUrl.pathname) && !authenticated) {
              res.statusCode = 302;
              res.setHeader('Location', buildLoginRedirect(requestUrl.pathname, requestUrl.search));
              res.end();
              return;
            }

            next();
          })().catch((error) => {
            sendJson(res, 500, { error: error.message || 'Authentication middleware failed.' });
          });
        });
      }
    },
    {
      name: 'python-growth-chart-api',
      configureServer(server) {
        server.middlewares.use('/api/growth_charts', (req, res) => {
          void (async () => {
            const authenticated = await isAuthenticatedCookieHeader(req.headers.cookie || '');

            if (!authenticated) {
              sendJson(res, 401, { error: 'Authentication required.' });
              return;
            }

            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.end();
              return;
            }

            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed.' });
              return;
            }

            const requestBody = await readRequestBody(req);
            const result = runPythonChartRenderer(requestBody);
            res.statusCode = result.ok ? 200 : result.statusCode;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(result.body);
          })().catch((error) => {
            sendJson(res, 500, { error: error.message || 'Authentication failed.' });
          });
        });
      }
    }
  ],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        password: resolve(__dirname, 'password.html'),
        download: resolve(__dirname, 'download.html'),
        entryDashboard: resolve(__dirname, 'index.html'),
        newPatient: resolve(__dirname, 'new-patient.html'),
        growthChart: resolve(__dirname, 'growth-chart-dashboard.html'),
        growthChartPreview: resolve(__dirname, 'growth-chart-preview.html'),
        prescription: resolve(__dirname, 'prescription.html'),
        preview: resolve(__dirname, 'preview.html'),
        pdfViewer: resolve(__dirname, 'pdf-viewer.html'),
        pendingApprovals: resolve(__dirname, 'pending-approvals.html'),
        parentDetails: resolve(__dirname, 'parent-details.html'),
        patientDetails: resolve(__dirname, 'patient-details.html'),
        receptionQr: resolve(__dirname, 'reception-qr.html'),
        intake: resolve(__dirname, 'intake.html'),
        rx: resolve(__dirname, 'rx.html'),
        portal: resolve(__dirname, 'portal.html'),
        settings: resolve(__dirname, 'settings.html'),
        test: resolve(__dirname, 'test.html'),
        prescriptionGrowthChart: resolve(__dirname, 'prescription-growth-chart-dashboard.html'),
        vaccination: resolve(__dirname, 'vaccination.html'),
        vacination: resolve(__dirname, 'vacination.html'),
        search: resolve(__dirname, 'search.html')
      }
    }
  }
});
