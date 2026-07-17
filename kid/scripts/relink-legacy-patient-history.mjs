import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  serverTimestamp,
  setDoc
} from 'firebase/firestore';
import {
  getBytes,
  getDownloadURL,
  getStorage,
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

const CLINIC_NAMESPACE = 'clinics/kid';
const PATIENTS_COLLECTION = `${CLINIC_NAMESPACE}/patients`;
const HISTORY_COLLECTION = `${CLINIC_NAMESPACE}/history`;
const STORAGE_PRESCRIPTION_PREFIX = `${CLINIC_NAMESPACE}/prescriptions`;

const args = new Set(process.argv.slice(2));
const WRITE_MODE = args.has('--write');

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
function isCurrentTbkId(value) {
  return /^TBK\d{4}$/.test(clean(value).toUpperCase());
}
function isPublicPdfUrl(value) {
  return /^https?:\/\//i.test(clean(value));
}
function getPrescriptionDownloadUrl(entry) {
  const candidates = [entry?.downloadURL, entry?.downloadUrl, entry?.pdfURL, entry?.pdfUrl, entry?.fileURL, entry?.fileUrl, entry?.url];
  return String(candidates.find((value) => value && isPublicPdfUrl(value)) || '').trim();
}
function getPrescriptionStoragePath(entry) {
  const candidates = [entry?.storagePath, entry?.fullPath, entry?.filePath, entry?.pdfPath, entry?.path, entry?.prescriptionSaveId];
  return clean(candidates.find((value) => clean(value)) || '');
}
function isPrescriptionHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  return entry.type === 'prescription'
    || entry.source === 'prescription-pdf'
    || Boolean(getPrescriptionDownloadUrl(entry))
    || Boolean(entry.previewImageURL || entry.previewImagePath)
    || Boolean(getPrescriptionStoragePath(entry));
}
function hasClinicalContent(entry) {
  return ['symptoms', 'diagnosis', 'drugs', 'rawSymptom', 'rawDiagnosis', 'rawDrug', 'rawVitals',
    'weight', 'height', 'head', 'spo2', 'pulse', 'temp', 'systolic', 'diastolic']
    .some((key) => {
      const value = entry?.[key];
      return Array.isArray(value) ? value.length > 0 : Boolean(clean(value));
    });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function buildPatientPrescriptionLink(historyRecord, docId) {
  return {
    id: docId,
    prescriptionSaveId: historyRecord.prescriptionSaveId || historyRecord.storagePath || docId,
    patientId: historyRecord.patientId,
    fileName: historyRecord.fileName || '',
    storagePath: historyRecord.storagePath || '',
    downloadURL: historyRecord.downloadURL || '',
    source: historyRecord.source || 'prescription-pdf',
    type: historyRecord.type || 'prescription',
    createdAtIso: historyRecord.createdAtIso || '',
    createdAtDisplay: historyRecord.createdAtDisplay || ''
  };
}

async function copyStorageFile(storage, oldPath, newPath) {
  const oldRef = ref(storage, oldPath);
  const bytes = await getBytes(oldRef);
  const newRef = ref(storage, newPath);
  await uploadBytes(newRef, bytes, { contentType: 'application/pdf', contentDisposition: 'inline' });
  return getDownloadURL(newRef);
}

async function main() {
  const app = initializeApp(FIREBASE_CONFIG, `kid-legacy-relink-${Date.now()}`);
  const db = getFirestore(app);
  const storage = getStorage(app);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const [patientsSnapshot, historySnapshot] = await Promise.all([
    getDocs(collection(db, PATIENTS_COLLECTION)),
    getDocs(collection(db, HISTORY_COLLECTION))
  ]);

  const patients = patientsSnapshot.docs.map((d) => ({ docId: d.id, ...d.data() }));
  const historyEntries = historySnapshot.docs.map((d) => ({ docId: d.id, ...d.data() }));

  const patientsByNamePhone = new Map();
  const patientsByNameDob = new Map();
  patients.forEach((p) => {
    const name = normalizeName(p.childName);
    const phone = normalizePhone(p.phone || p.mobileNumber);
    const dob = clean(p.dob);
    if (name && phone) patientsByNamePhone.set(`${name}|${phone}`, p);
    if (name && dob) patientsByNameDob.set(`${name}|${dob}`, p);
  });

  const plan = [];
  const unmatched = [];

  for (const entry of historyEntries) {
    const legacyId = clean(entry.patientId).toUpperCase();
    if (!legacyId || isCurrentTbkId(legacyId)) continue;
    if (!hasClinicalContent(entry) && !isPrescriptionHistoryEntry(entry)) continue;

    const name = normalizeName(entry.childName);
    const phone = normalizePhone(entry.phone || entry.mobileNumber);
    const dob = clean(entry.dob);

    let matchType = 'name+phone';
    let match = (name && phone) ? patientsByNamePhone.get(`${name}|${phone}`) : null;
    if (!match && name && dob) {
      match = patientsByNameDob.get(`${name}|${dob}`);
      matchType = 'name+dob';
    }

    if (!match) {
      unmatched.push({ docId: entry.docId, legacyId, childName: entry.childName });
      continue;
    }

    const currentId = clean(match.patientId || match.docId).toUpperCase();
    if (currentId === legacyId) continue;

    const isPrescription = isPrescriptionHistoryEntry(entry);
    const oldStoragePath = getPrescriptionStoragePath(entry);
    const newStoragePath = oldStoragePath ? oldStoragePath.replace(`/${legacyId}/`, `/${currentId}/`) : '';

    plan.push({
      historyDocId: entry.docId,
      legacyId,
      currentId,
      matchType,
      childName: entry.childName || match.childName || '',
      isPrescription,
      oldStoragePath,
      newStoragePath: newStoragePath !== oldStoragePath ? newStoragePath : ''
    });
  }

  const needsStorageCopy = plan.filter((p) => p.isPrescription && p.oldStoragePath && p.newStoragePath);
  const relinkOnly = plan.filter((p) => !(p.isPrescription && p.oldStoragePath && p.newStoragePath));

  console.log(`Relink legacy patient history ${WRITE_MODE ? 'WRITE' : 'DRY RUN'}`);
  console.log(`History docs scanned: ${historyEntries.length}`);
  console.log(`History docs needing patientId correction: ${plan.length}`);
  console.log(`  - with a storage PDF to copy to the current patient's folder: ${needsStorageCopy.length}`);
  console.log(`  - relink only (no storage file to move, e.g. vitals-only entries): ${relinkOnly.length}`);
  console.log(`Legacy entries with no matching current patient (left untouched): ${unmatched.length}`);

  writeJson(path.join(OUTPUT_DIR, `kid-legacy-relink-plan-${timestamp}.json`), {
    generatedAt: new Date().toISOString(),
    writeMode: WRITE_MODE,
    totals: {
      historyDocsScanned: historyEntries.length,
      needingCorrection: plan.length,
      needsStorageCopy: needsStorageCopy.length,
      relinkOnly: relinkOnly.length,
      unmatched: unmatched.length
    },
    plan,
    unmatched
  });

  if (!WRITE_MODE) {
    console.log('');
    console.log('Dry run only. Review the plan log, then rerun with --write to apply.');
    console.log(`Plan log: migration-logs/kid-legacy-relink-plan-${timestamp}.json`);
    return;
  }

  let storageCopied = 0;
  let storageMissing = 0;
  let historyUpdated = 0;
  let patientLinksAdded = 0;
  const patientLinkUpdates = new Map();

  for (const item of plan) {
    const entry = historyEntries.find((e) => e.docId === item.historyDocId);
    const updates = {
      patientId: item.currentId,
      relinkedFromPatientId: item.legacyId,
      relinkedAt: serverTimestamp()
    };
    let sourceFileMissing = false;

    if (item.isPrescription && item.oldStoragePath && item.newStoragePath) {
      try {
        const downloadURL = await copyStorageFile(storage, item.oldStoragePath, item.newStoragePath);
        storageCopied += 1;
        updates.storagePath = item.newStoragePath;
        if (entry.downloadURL) updates.downloadURL = downloadURL;
        if (entry.prescriptionSaveId && clean(entry.prescriptionSaveId) === item.oldStoragePath) {
          updates.prescriptionSaveId = item.newStoragePath;
        }
      } catch (error) {
        console.error(`  ! Storage copy failed for ${item.oldStoragePath}: ${error.message}`);
        storageMissing += 1;
        sourceFileMissing = true;
        // The legacy PDF file no longer exists in Storage. Still relink the
        // patientId (metadata correction) but drop the now-dead file
        // references so downstream tooling can detect this needs regeneration.
        updates.storagePath = '';
        updates.downloadURL = '';
        updates.prescriptionSaveId = '';
        updates.pdfSourceFileMissing = true;
      }
    }

    await setDoc(doc(db, HISTORY_COLLECTION, item.historyDocId), updates, { merge: true });
    historyUpdated += 1;

    if (item.isPrescription && !sourceFileMissing) {
      const mergedRecord = { ...entry, ...updates };
      const link = buildPatientPrescriptionLink(mergedRecord, item.historyDocId);
      const list = patientLinkUpdates.get(item.currentId) || [];
      list.push(link);
      patientLinkUpdates.set(item.currentId, list);
    }

    if (historyUpdated % 25 === 0) {
      console.log(`  ...updated ${historyUpdated} / ${plan.length}`);
    }
  }

  for (const [currentId, links] of patientLinkUpdates.entries()) {
    const patient = patients.find((p) => clean(p.patientId || p.docId).toUpperCase() === currentId);
    const existingLinks = Array.isArray(patient?.prescriptionHistory) ? patient.prescriptionHistory : [];
    const existingIds = new Set(existingLinks.map((l) => l.id || l.prescriptionSaveId));
    const newLinks = links.filter((l) => !existingIds.has(l.id));
    if (!newLinks.length) continue;

    await setDoc(doc(db, PATIENTS_COLLECTION, currentId), {
      prescriptionHistory: [...existingLinks, ...newLinks],
      updatedAt: serverTimestamp()
    }, { merge: true });
    patientLinksAdded += newLinks.length;
  }

  console.log('');
  console.log(`Storage files copied: ${storageCopied}`);
  console.log(`Storage files missing (patientId still relinked, needs PDF regeneration): ${storageMissing}`);
  console.log(`History docs relinked: ${historyUpdated}`);
  console.log(`Patient prescriptionHistory links added: ${patientLinksAdded}`);
  console.log('Relink complete.');
}

await main();
