import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAPPING_PATH = path.join(
  __dirname,
  '..',
  'migration-logs',
  'kid-patient-id-mapping-2026-07-02T14-40-31-656Z.json'
);
const DEFAULT_STORAGE_BUCKET = 'clinci-dr-gunda.firebasestorage.app';
const SOURCE_PREFIX_ROOT = 'clinics/kid/prescriptions';
const OUTPUT_DIR = path.join(__dirname, '..', 'migration-logs');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const conversionLogPath = path.join(OUTPUT_DIR, `kid-prescription-storage-gs-to-tbk-${timestamp}.json`);
const writeMode = process.argv.includes('--write');
const deleteOld = process.argv.includes('--delete-old');
const localPlanOnly = process.argv.includes('--local-plan');
const includeAllOldIds = process.argv.includes('--all-old-ids');
const mappingArgIndex = process.argv.findIndex((arg) => arg === '--mapping');
const mappingPath = mappingArgIndex >= 0
  ? path.resolve(process.argv[mappingArgIndex + 1] || '')
  : DEFAULT_MAPPING_PATH;

function parseServiceAccount() {
  const rawValue = String(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();

  if (!rawValue) {
    return null;
  }

  const decoded = rawValue.startsWith('{')
    ? rawValue
    : Buffer.from(rawValue, 'base64').toString('utf8');
  const parsed = JSON.parse(decoded);

  if (parsed.private_key) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }

  return parsed;
}

function getAdminApp() {
  if (admin.apps.length) {
    return admin.app();
  }

  const serviceAccount = parseServiceAccount();
  const options = {
    storageBucket: String(process.env.FIREBASE_STORAGE_BUCKET || DEFAULT_STORAGE_BUCKET).trim()
  };

  options.credential = serviceAccount
    ? admin.credential.cert(serviceAccount)
    : admin.credential.applicationDefault();

  return admin.initializeApp(options);
}

function isCredentialError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('could not load the default credentials')
    || message.includes('application default credentials')
    || message.includes('credential')
    || message.includes('unauthorized')
    || message.includes('permission');
}

function clean(value) {
  return String(value ?? '').trim().toUpperCase();
}

function readMapping(filePath) {
  if (!filePath) {
    throw new Error('Mapping path is required.');
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const rows = Array.isArray(parsed.mapping) ? parsed.mapping : [];
  const pairs = rows
    .map((entry) => ({
      oldId: clean(entry.oldPatientId || entry.oldDocumentId),
      newId: clean(entry.newPatientId || entry.newDocumentId)
    }))
    .filter((entry) => {
      if (!entry.oldId || !/^TBK\d{4,}$/.test(entry.newId) || entry.oldId === entry.newId) {
        return false;
      }

      return includeAllOldIds ? !/^TBK\d{4,}$/.test(entry.oldId) : entry.oldId.startsWith('GS');
    });

  const seenOldIds = new Set();
  const deduped = [];

  for (const pair of pairs) {
    if (!seenOldIds.has(pair.oldId)) {
      seenOldIds.add(pair.oldId);
      deduped.push(pair);
    }
  }

  return deduped;
}

async function migratePair(bucket, pair, stats) {
  const patientLog = {
    oldPatientId: pair.oldId,
    newPatientId: pair.newId,
    sourcePrefix: `${SOURCE_PREFIX_ROOT}/${pair.oldId}/`,
    targetPrefix: `${SOURCE_PREFIX_ROOT}/${pair.newId}/`,
    filesFound: 0,
    filesToCopy: 0,
    filesCopied: 0,
    filesSkippedExisting: 0,
    filesDeleted: 0,
    files: [],
    errors: []
  };
  const sourcePrefix = `${SOURCE_PREFIX_ROOT}/${pair.oldId}/`;
  const targetPrefix = `${SOURCE_PREFIX_ROOT}/${pair.newId}/`;
  let files = [];

  try {
    [files] = await bucket.getFiles({ prefix: sourcePrefix });
  } catch (error) {
    const message = error.message || String(error);
    patientLog.errors.push(message);
    stats.errors += 1;
    console.warn(`${pair.oldId} -> ${pair.newId}: unable to list files: ${message}`);
    return patientLog;
  }

  const pdfFiles = files.filter((file) => file.name.toLowerCase().endsWith('.pdf'));

  stats.sourceFoldersScanned += 1;
  stats.filesFound += pdfFiles.length;
  patientLog.filesFound = pdfFiles.length;

  if (!pdfFiles.length) {
    return patientLog;
  }

  console.log(`${pair.oldId} -> ${pair.newId}: ${pdfFiles.length} PDF(s)`);

  for (const file of pdfFiles) {
    const targetName = file.name.replace(sourcePrefix, targetPrefix);
    const targetFile = bucket.file(targetName);
    const fileLog = {
      sourcePath: file.name,
      targetPath: targetName,
      status: 'pending'
    };
    patientLog.files.push(fileLog);
    let targetExists = false;

    try {
      [targetExists] = await targetFile.exists();
    } catch (error) {
      const message = error.message || String(error);
      fileLog.status = 'error';
      fileLog.error = message;
      patientLog.errors.push(message);
      stats.errors += 1;
      console.warn(`  error checking ${targetName}: ${message}`);
      continue;
    }

    if (targetExists) {
      stats.filesSkippedExisting += 1;
      patientLog.filesSkippedExisting += 1;
      fileLog.status = 'skipped-existing';
      console.log(`  skip existing ${targetName}`);
      continue;
    }

    stats.filesToCopy += 1;
    patientLog.filesToCopy += 1;
    fileLog.status = writeMode ? 'copying' : 'would-copy';
    console.log(`  copy ${file.name} -> ${targetName}`);

    if (writeMode) {
      try {
        await file.copy(targetFile);
        stats.filesCopied += 1;
        patientLog.filesCopied += 1;
        fileLog.status = 'copied';

        if (deleteOld) {
          await file.delete({ ignoreNotFound: true });
          stats.filesDeleted += 1;
          patientLog.filesDeleted += 1;
          fileLog.deletedSource = true;
        }
      } catch (error) {
        const message = error.message || String(error);
        fileLog.status = 'error';
        fileLog.error = message;
        patientLog.errors.push(message);
        stats.errors += 1;
        console.warn(`  error copying ${file.name}: ${message}`);
      }
    }
  }

  return patientLog;
}

async function verifyStorageAccess(bucket) {
  try {
    await bucket.getMetadata();
  } catch (error) {
    if (isCredentialError(error)) {
      throw new Error([
        'Firebase admin credentials are not loaded.',
        'Set FIREBASE_SERVICE_ACCOUNT_KEY / FIREBASE_SERVICE_ACCOUNT, or set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON file, then run again.'
      ].join(' '));
    }

    throw error;
  }
}

function writeConversionLog(payload) {
  fs.mkdirSync(path.dirname(conversionLogPath), { recursive: true });
  fs.writeFileSync(conversionLogPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  const pairs = readMapping(mappingPath);
  console.log(`Mapping file: ${mappingPath}`);
  console.log(`${includeAllOldIds ? 'old ID' : 'GS'} -> TBK pairs: ${pairs.length}`);
  console.log(`Mode: ${writeMode ? 'WRITE' : 'DRY RUN'}${deleteOld ? ' + delete old files' : ''}`);
  console.log(`Scope: ${includeAllOldIds ? 'all old patient IDs from mapping' : 'GS IDs only'}`);

  if (!pairs.length) {
    throw new Error('No GS -> TBK mapping pairs found.');
  }

  if (localPlanOnly) {
    console.log('Local plan only. First 10 pairs:');
    pairs.slice(0, 10).forEach((pair) => console.log(`  ${pair.oldId} -> ${pair.newId}`));
    return;
  }

  const bucket = getAdminApp().storage().bucket();
  await verifyStorageAccess(bucket);

  const stats = {
    sourceFoldersScanned: 0,
    filesFound: 0,
    filesToCopy: 0,
    filesCopied: 0,
    filesSkippedExisting: 0,
    filesDeleted: 0,
    errors: 0
  };
  const patientConversions = [];

  for (const pair of pairs) {
    const patientLog = await migratePair(bucket, pair, stats);
    patientConversions.push(patientLog);
  }

  const logPayload = {
    generatedAt: new Date().toISOString(),
    mappingPath,
    sourcePrefixRoot: SOURCE_PREFIX_ROOT,
    writeMode,
    deleteOld,
    stats,
    patientConversions
  };

  writeConversionLog(logPayload);
  console.log(JSON.stringify(stats, null, 2));
  console.log(`Conversion log written: ${conversionLogPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
