import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'migration-logs');
const CLINIC_NAMESPACE = 'clinics/kid';
const PATIENTS_COLLECTION = `${CLINIC_NAMESPACE}/patients`;
const RELATED_COLLECTIONS = [
  `${CLINIC_NAMESPACE}/history`,
  `${CLINIC_NAMESPACE}/pendingPatients`
];
const STORAGE_PREFIXES = [
  `${CLINIC_NAMESPACE}/prescriptions`,
  `${CLINIC_NAMESPACE}/prescription-previews`
];
const writeMode = process.argv.includes('--write');
const deleteOldStorage = process.argv.includes('--delete-old-storage');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(OUTPUT_DIR, `kid-patient-id-backup-${timestamp}.json`);
const mappingPath = path.join(OUTPUT_DIR, `kid-patient-id-mapping-${timestamp}.json`);
const summaryPath = path.join(OUTPUT_DIR, `kid-patient-id-migration-summary-${timestamp}.json`);
const DEFAULT_STORAGE_BUCKET = 'clinci-dr-gunda.firebasestorage.app';

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

function getAdminDb() {
  return getAdminApp().firestore();
}

function getAdminBucket() {
  return getAdminApp().storage().bucket();
}

function clean(value) {
  return String(value ?? '').trim();
}

function isValidTbkId(value) {
  return /^TBK\d{4}$/.test(clean(value).toUpperCase());
}

function getTbkSerial(value) {
  const match = clean(value).toUpperCase().match(/^TBK(\d{4,})$/);
  return match ? Number.parseInt(match[1], 10) : Infinity;
}

function formatPatientId(index) {
  return `TBK${String(index + 1).padStart(4, '0')}`;
}

function toMillis(value) {
  if (!value) {
    return 0;
  }

  if (typeof value.toMillis === 'function') {
    return value.toMillis();
  }

  if (typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function identityKey(record) {
  const data = record.data || {};
  return [
    clean(data.childName || data.patientName).toLowerCase(),
    clean(data.parentName).toLowerCase(),
    clean(data.dob),
    clean(data.mobileNumber || data.phone).replace(/\D/g, '').slice(-10)
  ].join('|');
}

function sortKey(record) {
  const currentId = clean(record.data.patientId || record.docId).toUpperCase();
  const serial = getTbkSerial(currentId);
  const created = toMillis(record.data.createdAt || record.data.submittedAt || record.data.reviewedAt);
  return {
    hasTbk: isValidTbkId(currentId) ? 0 : 1,
    serial,
    created: created || Number.MAX_SAFE_INTEGER,
    identity: identityKey(record),
    docId: record.docId
  };
}

function compareRecords(left, right) {
  const leftKey = sortKey(left);
  const rightKey = sortKey(right);
  return leftKey.hasTbk - rightKey.hasTbk
    || leftKey.serial - rightKey.serial
    || leftKey.created - rightKey.created
    || leftKey.identity.localeCompare(rightKey.identity, 'en', { numeric: true, sensitivity: 'base' })
    || leftKey.docId.localeCompare(rightKey.docId, 'en', { numeric: true, sensitivity: 'base' });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertNoDuplicates(values, label) {
  const seen = new Set();
  const duplicates = new Set();

  values.forEach((value) => {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  });

  if (duplicates.size) {
    throw new Error(`${label} contains duplicates: ${[...duplicates].join(', ')}`);
  }
}

function buildOldIdAliases(record) {
  return [...new Set([
    clean(record.docId),
    clean(record.data.patientId),
    clean(record.data.approvedPatientId),
    clean(record.data.legacyPatientId)
  ].filter(Boolean).map((value) => value.toUpperCase()))];
}

function buildMapping(records) {
  const sorted = [...records].sort(compareRecords);
  const mapping = sorted.map((record, index) => {
    const newPatientId = formatPatientId(index);
    return {
      order: index + 1,
      oldDocumentId: record.docId,
      oldPatientId: clean(record.data.patientId || record.docId).toUpperCase(),
      aliases: buildOldIdAliases(record),
      newDocumentId: newPatientId,
      newPatientId
    };
  });

  assertNoDuplicates(mapping.map((entry) => entry.newPatientId), 'New patient IDs');
  return mapping;
}

function buildAliasMap(mapping) {
  const aliasMap = new Map();

  mapping.forEach((entry) => {
    entry.aliases.forEach((alias) => {
      if (alias && !aliasMap.has(alias)) {
        aliasMap.set(alias, entry.newPatientId);
      }
    });
  });

  return aliasMap;
}

function replaceKnownIds(value, aliasMap) {
  if (typeof value !== 'string') {
    return value;
  }

  const direct = aliasMap.get(value.trim().toUpperCase());
  if (direct) {
    return direct;
  }

  let nextValue = value;
  aliasMap.forEach((newId, oldId) => {
    nextValue = nextValue
      .split(`/${oldId}/`).join(`/${newId}/`)
      .split(`%2F${oldId}%2F`).join(`%2F${newId}%2F`)
      .split(`%2f${oldId}%2f`).join(`%2f${newId}%2f`);
  });
  return nextValue;
}

function rewriteValue(value, aliasMap) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteValue(item, aliasMap));
  }

  if (value && typeof value === 'object') {
    if (typeof value.toDate === 'function' || value instanceof admin.firestore.Timestamp) {
      return value;
    }

    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => {
      const shouldRewriteString = /patientid|approvedpatientid|prescriptionsaveid|storagepath|previewimagepath|downloadurl|pdfurl|path|url/i.test(key);
      if (typeof nestedValue === 'string' && shouldRewriteString) {
        return [key, replaceKnownIds(nestedValue, aliasMap)];
      }
      return [key, rewriteValue(nestedValue, aliasMap)];
    }));
  }

  return replaceKnownIds(value, aliasMap);
}

async function getCollectionDocs(db, collectionPath) {
  const snapshot = await db.collection(collectionPath).get();
  return snapshot.docs.map((docSnapshot) => ({
    docId: docSnapshot.id,
    ref: docSnapshot.ref,
    path: docSnapshot.ref.path,
    data: docSnapshot.data()
  }));
}

async function copySubcollections(sourceRef, targetRef, batchWriter, stats) {
  const subcollections = await sourceRef.listCollections();

  for (const subcollection of subcollections) {
    const docs = await subcollection.get();
    stats.patientSubcollectionDocs += docs.size;

    docs.docs.forEach((docSnapshot) => {
      const targetDocRef = targetRef.collection(subcollection.id).doc(docSnapshot.id);
      batchWriter.set(targetDocRef, docSnapshot.data(), { merge: false });
    });
  }
}

async function copyStorageObjects(bucket, oldId, newId, stats) {
  if (oldId === newId) {
    return;
  }

  for (const prefix of STORAGE_PREFIXES) {
    const [files] = await bucket.getFiles({ prefix: `${prefix}/${oldId}/` });
    stats.storageFilesScanned += files.length;

    for (const file of files) {
      const targetName = file.name.replace(`${prefix}/${oldId}/`, `${prefix}/${newId}/`);
      await file.copy(bucket.file(targetName));
      stats.storageFilesCopied += 1;

      if (deleteOldStorage) {
        await file.delete({ ignoreNotFound: true });
        stats.storageFilesDeleted += 1;
      }
    }
  }
}

async function migratePatients(db, bucket, records, mapping, aliasMap, stats) {
  const writer = db.bulkWriter();
  const targetIds = new Set(mapping.map((entry) => entry.newDocumentId));
  const total = mapping.length;
  const startTime = Date.now();

  writer.onWriteError((error) => {
    console.error(`  ! Write error on ${error.documentRef.path} (attempt ${error.failedAttempts}): ${error.message}`);
    return error.failedAttempts < 5;
  });

  for (const [index, entry] of mapping.entries()) {
    const record = records.find((item) => item.docId === entry.oldDocumentId);
    const targetRef = db.collection(PATIENTS_COLLECTION).doc(entry.newDocumentId);
    const nextData = {
      ...rewriteValue(record.data, aliasMap),
      patientId: entry.newPatientId,
      previousPatientIds: [...new Set([entry.oldPatientId, ...entry.aliases].filter((id) => id && id !== entry.newPatientId))],
      idSystem: 'TBK',
      idMigratedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    writer.set(targetRef, nextData, { merge: false });
    stats.patientDocsWritten += 1;
    await copySubcollections(record.ref, targetRef, writer, stats);
    await copyStorageObjects(bucket, entry.oldPatientId, entry.newPatientId, stats);

    const done = index + 1;
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const avgSec = ((Date.now() - startTime) / 1000 / done).toFixed(2);
    const etaSec = (avgSec * (total - done)).toFixed(0);
    console.log(`[${done}/${total}] ${entry.oldPatientId} -> ${entry.newPatientId}  (elapsed ${elapsedSec}s, avg ${avgSec}s/patient, ETA ${etaSec}s)`);
  }

  console.log('All patient records queued. Flushing writes...');

  for (const record of records) {
    if (!targetIds.has(record.docId)) {
      writer.delete(record.ref);
      stats.patientDocsDeleted += 1;
    }
  }

  await writer.close();
  console.log('Patient write flush complete.');
}

async function migrateRelatedCollections(db, aliasMap, stats) {
  for (const collectionPath of RELATED_COLLECTIONS) {
    console.log(`Scanning related collection: ${collectionPath} ...`);
    const docs = await getCollectionDocs(db, collectionPath);
    console.log(`  Found ${docs.length} docs in ${collectionPath}.`);
    stats.relatedCollections[collectionPath] = {
      scanned: docs.length,
      updated: 0
    };

    const writer = db.bulkWriter();

    docs.forEach((record) => {
      const nextData = rewriteValue(record.data, aliasMap);
      const before = JSON.stringify(record.data);
      const after = JSON.stringify(nextData);

      if (before !== after) {
        writer.set(record.ref, {
          ...nextData,
          idMigratedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        stats.relatedCollections[collectionPath].updated += 1;
      }
    });

    await writer.close();
    console.log(`  Updated ${stats.relatedCollections[collectionPath].updated} docs in ${collectionPath}.`);
  }
}

async function updateCounter(db, patientCount) {
  await db.doc(`${CLINIC_NAMESPACE}/counters/patientIds`).set({
    prefix: 'TBK',
    nextSerial: patientCount + 1,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function verify(db, expectedCount) {
  const snapshot = await db.collection(PATIENTS_COLLECTION).get();
  const finalIds = snapshot.docs.map((docSnapshot) => docSnapshot.id).sort((left, right) => (
    left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' })
  ));
  const expectedIds = Array.from({ length: expectedCount }, (_, index) => formatPatientId(index));

  if (finalIds.length !== expectedIds.length) {
    throw new Error(`Expected ${expectedIds.length} patient docs, found ${finalIds.length}.`);
  }

  expectedIds.forEach((expectedId, index) => {
    if (finalIds[index] !== expectedId) {
      throw new Error(`Final ID mismatch at ${index + 1}: expected ${expectedId}, got ${finalIds[index] || 'missing'}.`);
    }
  });

  return {
    count: finalIds.length,
    firstPatientId: finalIds[0] || '',
    lastPatientId: finalIds.at(-1) || ''
  };
}

async function main() {
  const db = getAdminDb();
  const bucket = getAdminBucket();
  const records = await getCollectionDocs(db, PATIENTS_COLLECTION);
  const mapping = buildMapping(records);
  const aliasMap = buildAliasMap(mapping);
  const stats = {
    patientDocsScanned: records.length,
    patientDocsWritten: 0,
    patientDocsDeleted: 0,
    patientSubcollectionDocs: 0,
    storageFilesScanned: 0,
    storageFilesCopied: 0,
    storageFilesDeleted: 0,
    relatedCollections: {}
  };

  writeJson(backupPath, {
    generatedAt: new Date().toISOString(),
    collection: PATIENTS_COLLECTION,
    count: records.length,
    records: records.map(({ docId, path: docPath, data }) => ({ docId, path: docPath, data }))
  });
  writeJson(mappingPath, {
    generatedAt: new Date().toISOString(),
    collection: PATIENTS_COLLECTION,
    count: mapping.length,
    mapping
  });

  console.log(`Patient docs scanned: ${records.length}`);
  console.log(`Target sequence: ${mapping[0]?.newPatientId || 'none'} through ${mapping.at(-1)?.newPatientId || 'none'}`);
  console.log(`Backup: ${backupPath}`);
  console.log(`Mapping: ${mappingPath}`);

  if (!writeMode) {
    console.log('Dry run only. Re-run with --write to migrate Firestore and copy Storage files.');
    return;
  }

  console.log('Starting patient migration (this is the slow part; progress logs below)...');
  await migratePatients(db, bucket, records, mapping, aliasMap, stats);
  console.log('Starting related-collections migration...');
  await migrateRelatedCollections(db, aliasMap, stats);
  console.log('Updating patient ID counter...');
  await updateCounter(db, records.length);
  console.log('Verifying final patient ID sequence...');
  const verification = await verify(db, records.length);

  writeJson(summaryPath, {
    generatedAt: new Date().toISOString(),
    writeMode,
    deleteOldStorage,
    stats,
    verification
  });

  console.log(`Verified ${verification.count} patient IDs: ${verification.firstPatientId} through ${verification.lastPatientId}`);
  console.log(`Summary: ${summaryPath}`);
}

await main();
