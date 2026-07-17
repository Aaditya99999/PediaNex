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

const WRITE_MODE = process.argv.includes('--write');
const CLINIC_NAMESPACE = 'clinics/kid';
const PATIENTS_COLLECTION = `${CLINIC_NAMESPACE}/patients`;
const HISTORY_COLLECTION = `${CLINIC_NAMESPACE}/history`;
const STORAGE_PRESCRIPTION_PREFIX = `${CLINIC_NAMESPACE}/prescriptions`;
const PATIENT_SUBCOLLECTIONS = ['imports', 'vitals', 'growth', 'reports'];
const ID_FIELDS = new Set(['id', 'patientId']);
const META_SKIP_FIELDS = new Set(['createdAt', 'updatedAt', 'importedAt', 'lastImportedAt', 'mergedAt']);

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

function hasDob(patient) {
  return Boolean(clean(patient.dob || patient.dateOfBirth || patient.birthDate));
}

function isEmpty(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object' && !('seconds' in value && 'nanoseconds' in value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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

function parseTbkId(id) {
  const match = clean(id).toUpperCase().match(/^TBK(\d+)$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function chooseDobCanonical(records) {
  const dobRecords = records.filter((record) => hasDob(record.data));
  if (dobRecords.length !== 1) return null;
  return dobRecords[0];
}

function mergeTopLevel(canonical, duplicates) {
  const merged = { ...canonical.data };
  const movedFields = [];
  const appendedFields = [];
  const keptConflicts = [];

  for (const duplicate of duplicates) {
    for (const [key, value] of Object.entries(duplicate.data)) {
      if (ID_FIELDS.has(key) || META_SKIP_FIELDS.has(key) || isEmpty(value)) continue;

      const existing = merged[key];
      if (isEmpty(existing)) {
        merged[key] = value;
        movedFields.push({ field: key, from: duplicate.docId });
      } else if (Array.isArray(existing) || Array.isArray(value)) {
        const next = uniqueByJson([...(Array.isArray(existing) ? existing : [existing]), ...(Array.isArray(value) ? value : [value])]);
        if (next.length !== (Array.isArray(existing) ? existing.length : 1)) {
          merged[key] = next;
          appendedFields.push({ field: key, from: duplicate.docId });
        }
      } else if (stableJson(existing) !== stableJson(value)) {
        keptConflicts.push({ field: key, keptFrom: canonical.docId, ignoredFrom: duplicate.docId });
      }
    }
  }

  merged.id = canonical.docId;
  merged.patientId = canonical.docId;
  merged.childName = getDisplayName(merged);
  merged.phone = getPhone(merged);
  merged.mobileNumber = merged.mobileNumber || merged.phone;
  merged.mergedFromPatientIds = uniqueByJson([
    ...(Array.isArray(canonical.data.mergedFromPatientIds) ? canonical.data.mergedFromPatientIds : []),
    ...duplicates.map((record) => record.docId)
  ]);

  return { merged, movedFields, appendedFields, keptConflicts };
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
  return getDownloadURL(newRef);
}

async function main() {
  const app = initializeApp(FIREBASE_CONFIG, `kid-dob-duplicate-merge-${Date.now()}`);
  const db = getFirestore(app);
  const storage = getStorage(app);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const summaryPath = path.join(OUTPUT_DIR, `kid-dob-duplicate-merge-summary-${timestamp}.json`);
  const backupPath = path.join(OUTPUT_DIR, `kid-dob-duplicate-merge-backup-${timestamp}.json`);

  const patientSnapshot = await getDocs(collection(db, PATIENTS_COLLECTION));
  const basicRecords = patientSnapshot.docs.map((docSnap) => ({ docId: docSnap.id, data: docSnap.data() }));
  const groups = new Map();
  for (const record of basicRecords) {
    const key = patientKey(record.data);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) || []), record]);
  }

  const candidates = [...groups.values()]
    .filter((records) => records.length > 1)
    .map((records) => [...records].sort((left, right) => parseTbkId(left.docId) - parseTbkId(right.docId)))
    .filter((records) => records.some((record) => hasDob(record.data)) && records.some((record) => !hasDob(record.data)));

  const summaries = [];
  const backup = [];
  const skipped = [];

  for (const records of candidates) {
    const canonical = chooseDobCanonical(records);
    if (!canonical) {
      skipped.push({
        reason: 'Expected exactly one DOB-bearing record in group',
        ids: records.map((record) => record.docId),
        name: getDisplayName(records[0].data),
        phone: getPhone(records[0].data)
      });
      continue;
    }

    const duplicateBasics = records.filter((record) => record.docId !== canonical.docId && !hasDob(record.data));
    const hydratedDuplicates = [];
    for (const duplicate of duplicateBasics) {
      const [subcollections, history, storageFiles] = await Promise.all([
        loadSubcollections(db, duplicate.docId),
        loadHistory(db, duplicate.docId),
        listStorageFiles(storage, duplicate.docId)
      ]);
      hydratedDuplicates.push({ ...duplicate, subcollections, history, storageFiles });
    }

    const { merged, movedFields, appendedFields, keptConflicts } = mergeTopLevel(canonical, hydratedDuplicates);
    const storageMoves = hydratedDuplicates.flatMap((duplicate) => duplicate.storageFiles
      .filter((entry) => typeof entry === 'string')
      .map((oldPath) => ({ from: oldPath, to: oldPath.replace(`/${duplicate.docId}/`, `/${canonical.docId}/`) })));

    backup.push({
      canonicalId: canonical.docId,
      duplicateIds: hydratedDuplicates.map((record) => record.docId),
      canonical: canonical.data,
      duplicates: hydratedDuplicates.map((record) => ({
        docId: record.docId,
        data: record.data,
        subcollections: record.subcollections,
        history: record.history,
        storageFiles: record.storageFiles
      }))
    });

    summaries.push({
      canonicalId: canonical.docId,
      canonicalDob: canonical.data.dob || canonical.data.dateOfBirth || canonical.data.birthDate || '',
      duplicateIds: hydratedDuplicates.map((record) => record.docId),
      name: getDisplayName(canonical.data),
      phone: getPhone(canonical.data),
      moved: {
        topLevelFieldsFilled: movedFields,
        topLevelArraysAppended: appendedFields,
        patientSubcollectionDocs: hydratedDuplicates.flatMap((record) => record.subcollections.map((entry) => ({
          fromPatientId: record.docId,
          subcollection: entry.subcollection,
          docId: entry.docId
        }))),
        historyDocs: hydratedDuplicates.flatMap((record) => record.history.map((entry) => ({
          fromPatientId: record.docId,
          docId: entry.docId
        }))),
        pdfStorageFiles: storageMoves
      },
      keptExistingNonEmptyFields: keptConflicts,
      mergedPreview: merged
    });
  }

  writeJson(backupPath, { generatedAt: new Date().toISOString(), mode: WRITE_MODE ? 'write' : 'dry-run', collection: PATIENTS_COLLECTION, groups: backup });
  writeJson(summaryPath, {
    generatedAt: new Date().toISOString(),
    mode: WRITE_MODE ? 'write' : 'dry-run',
    rule: 'same normalized name and 10-digit phone; exactly one record in the group has DOB; merge non-DOB records into DOB record',
    totals: {
      patientsScanned: basicRecords.length,
      candidateGroups: candidates.length,
      affectedGroups: summaries.length,
      duplicateRecordsToDelete: summaries.reduce((total, group) => total + group.duplicateIds.length, 0),
      skippedGroups: skipped.length
    },
    skipped,
    groups: summaries
  });

  console.log(`Patients scanned: ${basicRecords.length}`);
  console.log(`Candidate DOB/non-DOB duplicate groups: ${candidates.length}`);
  console.log(`Affected groups: ${summaries.length}`);
  console.log(`Duplicate records to delete: ${summaries.reduce((total, group) => total + group.duplicateIds.length, 0)}`);
  console.log(`Skipped groups: ${skipped.length}`);
  console.log(`Backup log: ${backupPath}`);
  console.log(`Summary log: ${summaryPath}`);

  if (!WRITE_MODE) {
    console.log('Dry run only. Rerun with --write to merge and delete duplicates.');
    return;
  }

  for (const group of summaries) {
    const sourceBackup = backup.find((entry) => entry.canonicalId === group.canonicalId);
    const storageMoveMap = new Map(group.moved.pdfStorageFiles.map((move) => [move.from, move.to]));
    const downloadUrlMap = new Map();

    for (const move of group.moved.pdfStorageFiles) {
      const downloadURL = await copyStorageObject(storage, move.from, move.to);
      downloadUrlMap.set(move.to, downloadURL);
    }

    await setDoc(doc(db, PATIENTS_COLLECTION, group.canonicalId), {
      ...group.mergedPreview,
      mergedAt: serverTimestamp()
    }, { merge: true });

    for (const duplicateId of group.duplicateIds) {
      const source = sourceBackup.duplicates.find((record) => record.docId === duplicateId);
      for (const entry of source.subcollections) {
        await setDoc(doc(db, `${PATIENTS_COLLECTION}/${group.canonicalId}/${entry.subcollection}`, entry.docId), {
          ...rewritePatientReferences(entry.data, duplicateId, group.canonicalId, storageMoveMap),
          patientId: group.canonicalId,
          mergedFromPatientId: duplicateId,
          mergedAt: serverTimestamp()
        }, { merge: true });
        await deleteDoc(doc(db, `${PATIENTS_COLLECTION}/${duplicateId}/${entry.subcollection}`, entry.docId));
      }

      for (const entry of source.history) {
        const rewritten = rewritePatientReferences(entry.data, duplicateId, group.canonicalId, storageMoveMap);
        for (const [newPath, downloadURL] of downloadUrlMap.entries()) {
          if (rewritten.storagePath === newPath || rewritten.prescriptionSaveId === newPath) {
            rewritten.downloadURL = downloadURL;
          }
        }
        await setDoc(doc(db, HISTORY_COLLECTION, entry.docId), {
          ...rewritten,
          patientId: group.canonicalId,
          mergedFromPatientId: duplicateId,
          mergedAt: serverTimestamp()
        }, { merge: true });
      }

      await deleteDoc(doc(db, PATIENTS_COLLECTION, duplicateId));

      for (const move of group.moved.pdfStorageFiles.filter((entry) => entry.from.includes(`/${duplicateId}/`))) {
        await deleteObject(ref(storage, move.from));
      }
    }

    console.log(`Merged ${group.duplicateIds.join(', ')} into ${group.canonicalId}`);
  }

  console.log('DOB duplicate merge complete.');
}

await main();
