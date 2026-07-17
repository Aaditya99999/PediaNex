import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  where
} from 'firebase/firestore';
import {
  deleteObject,
  getBytes,
  getDownloadURL,
  getStorage,
  listAll,
  ref,
  uploadBytes
} from 'firebase/storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'migration-logs');
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAm-cUFMyTFSyw8KlFOCcBKQkTKApEr5oo',
  authDomain: 'clinci-dr-gunda.firebaseapp.com',
  projectId: 'clinci-dr-gunda',
  storageBucket: 'clinci-dr-gunda.firebasestorage.app',
  messagingSenderId: '1059959825609',
  appId: '1:1059959825609:web:8201599754706ac4661918',
  measurementId: 'G-4V5JMVW45E'
};

const args = new Set(process.argv.slice(2));
const WRITE_MODE = args.has('--write');
const ALLOW_CONFLICTS = args.has('--allow-conflicts');
const ARCHIVE_MODE = args.has('--archive');
const CLINIC_NAMESPACE = 'clinics/kid';
const PATIENTS_COLLECTION = `${CLINIC_NAMESPACE}/patients`;
const HISTORY_COLLECTION = `${CLINIC_NAMESPACE}/history`;
const STORAGE_PRESCRIPTION_PREFIX = `${CLINIC_NAMESPACE}/prescriptions`;
const PATIENT_SUBCOLLECTIONS = ['imports', 'vitals', 'growth', 'reports'];
const IDENTITY_FIELDS = new Set(['id', 'patientId']);
const CONFLICT_IGNORED_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'lastImportedAt',
  'importedAt',
  'mergedAt',
  'mergedFromPatientIds',
  'archivedAt',
  'archivedReason'
]);

function clean(value) {
  return String(value ?? '').trim();
}

function compact(value) {
  return clean(value).replace(/\s+/g, ' ');
}

function normalizeName(value) {
  return compact(value).toLowerCase();
}

function normalizePhone(value) {
  const digits = clean(value).replace(/\D/g, '');
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function getDisplayName(patient) {
  return compact(patient.childName || patient.fullName || patient.name || patient.patientName || [
    patient.firstName,
    patient.middleName,
    patient.lastName
  ].filter(Boolean).join(' '));
}

function getPhone(patient) {
  return normalizePhone(patient.phone || patient.mobileNumber || patient.mobile || '');
}

function patientKey(patient) {
  const name = normalizeName(getDisplayName(patient));
  const phone = getPhone(patient);
  return name && phone ? `${name}|${phone}` : '';
}

function parseTbkId(id) {
  const match = clean(id).toUpperCase().match(/^TBK(\d+)$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object' && !('seconds' in value && 'nanoseconds' in value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function valuesEqual(left, right) {
  if (clean(left) && clean(right) && clean(left).toLowerCase() === clean(right).toLowerCase()) return true;
  return stableJson(left) === stableJson(right);
}

function fieldValuesEqual(field, left, right) {
  if (field === 'phone' || field === 'mobileNumber' || field === 'mobile') {
    return normalizePhone(left) === normalizePhone(right);
  }
  return valuesEqual(left, right);
}

function uniqueByJson(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = stableJson(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function scorePatient(record) {
  const data = record.data;
  const scalarCount = Object.values(data).filter((value) => typeof value !== 'object' && !isEmpty(value)).length;
  const arrayCount = Object.values(data).reduce((total, value) => total + (Array.isArray(value) ? value.length : 0), 0);
  return arrayCount * 20
    + scalarCount
    + (parseTbkId(record.docId) === Number.MAX_SAFE_INTEGER ? 0 : 5)
    + (record.subcollectionCount || 0) * 30
    + (record.historyCount || 0) * 30
    + (record.storageCount || 0) * 30;
}

function chooseCanonical(records) {
  return [...records].sort((left, right) => {
    return scorePatient(right) - scorePatient(left)
      || parseTbkId(left.docId) - parseTbkId(right.docId)
      || left.docId.localeCompare(right.docId, 'en', { numeric: true, sensitivity: 'base' });
  })[0];
}

function mergePatientData(records, canonicalDocId) {
  const ordered = [...records].sort((left, right) => {
    if (left.docId === canonicalDocId) return -1;
    if (right.docId === canonicalDocId) return 1;
    return scorePatient(right) - scorePatient(left);
  });
  const merged = { ...ordered[0].data };
  const conflicts = [];

  for (const record of ordered.slice(1)) {
    for (const [key, value] of Object.entries(record.data)) {
      if (isEmpty(value) || CONFLICT_IGNORED_FIELDS.has(key)) continue;
      if (IDENTITY_FIELDS.has(key)) continue;

      const existing = merged[key];
      if (isEmpty(existing)) {
        merged[key] = value;
      } else if (Array.isArray(existing) || Array.isArray(value)) {
        merged[key] = uniqueByJson([...(Array.isArray(existing) ? existing : [existing]), ...(Array.isArray(value) ? value : [value])]);
      } else if (typeof existing === 'object' || typeof value === 'object') {
        if (!fieldValuesEqual(key, existing, value)) {
          conflicts.push({ field: key, keptFrom: ordered[0].docId, differingFrom: record.docId, keptValue: existing, differingValue: value });
        }
      } else if (!fieldValuesEqual(key, existing, value)) {
        conflicts.push({ field: key, keptFrom: ordered[0].docId, differingFrom: record.docId, keptValue: existing, differingValue: value });
      }
    }
  }

  merged.id = canonicalDocId;
  merged.patientId = canonicalDocId;
  merged.childName = getDisplayName(merged);
  merged.phone = getPhone(merged);
  merged.mobileNumber = merged.mobileNumber || merged.phone;
  merged.mergedFromPatientIds = uniqueByJson(records.map((record) => record.docId).filter((id) => id !== canonicalDocId));

  return { merged, conflicts };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function loadSubcollections(db, patientId) {
  const entries = [];
  for (const subcollection of PATIENT_SUBCOLLECTIONS) {
    const snapshot = await getDocs(collection(db, `${PATIENTS_COLLECTION}/${patientId}/${subcollection}`));
    for (const docSnap of snapshot.docs) {
      entries.push({ subcollection, docId: docSnap.id, data: docSnap.data() });
    }
  }
  return entries;
}

async function loadHistory(db, patientId) {
  const snapshot = await getDocs(query(collection(db, HISTORY_COLLECTION), where('patientId', '==', patientId)));
  return snapshot.docs.map((docSnap) => ({ docId: docSnap.id, data: docSnap.data() }));
}

async function listStorageFiles(storage, patientId) {
  try {
    const result = await listAll(ref(storage, `${STORAGE_PRESCRIPTION_PREFIX}/${patientId}`));
    return result.items.map((item) => item.fullPath);
  } catch (error) {
    return [{ error: error.message, path: `${STORAGE_PRESCRIPTION_PREFIX}/${patientId}` }];
  }
}

function rewritePatientReferences(value, fromId, toId, storageMoves = new Map()) {
  if (Array.isArray(value)) return value.map((entry) => rewritePatientReferences(entry, fromId, toId, storageMoves));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewritePatientReferences(entry, fromId, toId, storageMoves)]));
  }
  if (typeof value !== 'string') return value;
  if (value === fromId) return toId;
  let rewritten = value.replaceAll(`/${fromId}/`, `/${toId}/`);
  for (const [oldPath, newPath] of storageMoves.entries()) {
    rewritten = rewritten.replaceAll(oldPath, newPath);
  }
  return rewritten;
}

async function copyStorageObject(storage, oldPath, newPath) {
  const oldRef = ref(storage, oldPath);
  const bytes = await getBytes(oldRef);
  const newRef = ref(storage, newPath);
  await uploadBytes(newRef, bytes, { contentType: 'application/pdf' });
  const downloadURL = await getDownloadURL(newRef);
  return downloadURL;
}

async function main() {
  const app = initializeApp(FIREBASE_CONFIG, `kid-patient-dedupe-${Date.now()}`);
  const db = getFirestore(app);
  const storage = getStorage(app);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const summaryPath = path.join(OUTPUT_DIR, `kid-patient-dedupe-summary-${timestamp}.json`);
  const backupPath = path.join(OUTPUT_DIR, `kid-patient-dedupe-backup-${timestamp}.json`);

  const patientSnapshot = await getDocs(collection(db, PATIENTS_COLLECTION));
  const basicRecords = patientSnapshot.docs.map((docSnap) => ({ docId: docSnap.id, data: docSnap.data() }));
  const groups = new Map();
  for (const record of basicRecords) {
    const key = patientKey(record.data);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) || []), record]);
  }

  const duplicateGroups = [...groups.values()].filter((records) => records.length > 1);
  const summaries = [];
  const backup = [];

  for (const records of duplicateGroups) {
    const hydrated = [];
    for (const record of records) {
      const [subcollections, history, storageFiles] = await Promise.all([
        loadSubcollections(db, record.docId),
        loadHistory(db, record.docId),
        listStorageFiles(storage, record.docId)
      ]);
      hydrated.push({
        ...record,
        subcollections,
        history,
        storageFiles,
        subcollectionCount: subcollections.length,
        historyCount: history.length,
        storageCount: storageFiles.filter((entry) => typeof entry === 'string').length
      });
    }

    const canonical = chooseCanonical(hydrated);
    const { merged, conflicts } = mergePatientData(hydrated, canonical.docId);
    const duplicateIds = hydrated.map((record) => record.docId).filter((id) => id !== canonical.docId);
    const storageMoves = duplicateIds.flatMap((fromId) => {
      const source = hydrated.find((record) => record.docId === fromId);
      return source.storageFiles.filter((entry) => typeof entry === 'string').map((oldPath) => ({
        from: oldPath,
        to: oldPath.replace(`/${fromId}/`, `/${canonical.docId}/`)
      }));
    });

    backup.push({
      canonicalId: canonical.docId,
      sourceIds: hydrated.map((record) => record.docId),
      records: hydrated.map((record) => ({
        docId: record.docId,
        data: record.data,
        subcollections: record.subcollections,
        history: record.history,
        storageFiles: record.storageFiles
      }))
    });

    summaries.push({
      canonicalId: canonical.docId,
      mergedIds: duplicateIds,
      name: getDisplayName(canonical.data),
      phone: getPhone(canonical.data),
      counts: {
        sourceRecords: hydrated.length,
        subcollectionDocsToMove: hydrated.filter((record) => record.docId !== canonical.docId).reduce((total, record) => total + record.subcollections.length, 0),
        historyDocsToMove: hydrated.filter((record) => record.docId !== canonical.docId).reduce((total, record) => total + record.history.length, 0),
        storageFilesToCopy: storageMoves.length
      },
      conflicts,
      storageMoves,
      mergedPreview: merged
    });
  }

  const conflictCount = summaries.reduce((total, group) => total + group.conflicts.length, 0);
  writeJson(backupPath, { generatedAt: new Date().toISOString(), collection: PATIENTS_COLLECTION, groups: backup });
  writeJson(summaryPath, {
    generatedAt: new Date().toISOString(),
    mode: WRITE_MODE ? 'write' : 'dry-run',
    duplicateRule: 'same normalized patient display name and same normalized 10-digit phone number',
    canonicalRule: 'highest data/history/storage score, then lowest TBK id',
    totals: {
      patientsScanned: basicRecords.length,
      duplicateGroups: summaries.length,
      duplicateRecordsToRemoveOrArchive: summaries.reduce((total, group) => total + group.mergedIds.length, 0),
      conflictCount
    },
    groups: summaries
  });

  console.log(`Patients scanned: ${basicRecords.length}`);
  console.log(`Duplicate groups found: ${summaries.length}`);
  console.log(`Duplicate records to ${ARCHIVE_MODE ? 'archive' : 'delete'}: ${summaries.reduce((total, group) => total + group.mergedIds.length, 0)}`);
  console.log(`Conflicts flagged: ${conflictCount}`);
  console.log(`Backup log: ${backupPath}`);
  console.log(`Summary log: ${summaryPath}`);

  if (!WRITE_MODE) {
    console.log('Dry run only. Review the summary, then rerun with --write if conflicts are zero.');
    return;
  }

  if (conflictCount && !ALLOW_CONFLICTS) {
    throw new Error('Conflicts were found. Review the summary log, then rerun with --write --allow-conflicts only after manual approval.');
  }

  for (const group of summaries) {
    const sourceBackup = backup.find((entry) => entry.canonicalId === group.canonicalId);
    const storageMoveMap = new Map(group.storageMoves.map((move) => [move.from, move.to]));
    const downloadUrlMap = new Map();

    for (const move of group.storageMoves) {
      const downloadURL = await copyStorageObject(storage, move.from, move.to);
      downloadUrlMap.set(move.to, downloadURL);
    }

    await setDoc(doc(db, PATIENTS_COLLECTION, group.canonicalId), {
      ...group.mergedPreview,
      mergedAt: serverTimestamp()
    }, { merge: true });

    for (const sourceId of group.mergedIds) {
      const source = sourceBackup.records.find((record) => record.docId === sourceId);
      for (const entry of source.subcollections) {
        await setDoc(doc(db, `${PATIENTS_COLLECTION}/${group.canonicalId}/${entry.subcollection}`, entry.docId), {
          ...rewritePatientReferences(entry.data, sourceId, group.canonicalId, storageMoveMap),
          patientId: group.canonicalId,
          mergedFromPatientId: sourceId,
          mergedAt: serverTimestamp()
        }, { merge: true });
      }

      for (const entry of source.history) {
        const rewritten = rewritePatientReferences(entry.data, sourceId, group.canonicalId, storageMoveMap);
        for (const [newPath, downloadURL] of downloadUrlMap.entries()) {
          if (rewritten.storagePath === newPath || rewritten.prescriptionSaveId === newPath) {
            rewritten.downloadURL = downloadURL;
          }
        }
        await setDoc(doc(db, HISTORY_COLLECTION, entry.docId), {
          ...rewritten,
          patientId: group.canonicalId,
          mergedFromPatientId: sourceId,
          mergedAt: serverTimestamp()
        }, { merge: true });
      }

      if (ARCHIVE_MODE) {
        await setDoc(doc(db, PATIENTS_COLLECTION, sourceId), {
          archived: true,
          archivedAt: serverTimestamp(),
          archivedReason: 'duplicate patient merged',
          mergedIntoPatientId: group.canonicalId
        }, { merge: true });
      } else {
        await deleteDoc(doc(db, PATIENTS_COLLECTION, sourceId));
      }

      for (const move of group.storageMoves.filter((entry) => entry.from.includes(`/${sourceId}/`))) {
        await deleteObject(ref(storage, move.from));
      }
    }

    console.log(`Merged ${group.mergedIds.join(', ')} into ${group.canonicalId}`);
  }

  console.log('Duplicate merge complete.');
}

await main();
