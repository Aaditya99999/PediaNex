import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { collection, getDocs, getFirestore } from 'firebase/firestore';

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

function clean(value) {
  return String(value ?? '').trim();
}

function hasVitalsContent(entry) {
  return ['weight', 'height', 'head', 'spo2', 'pulse', 'systolic', 'diastolic', 'temp', 'rawVitals']
    .some((key) => Boolean(clean(entry?.[key])));
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

function hasPdf(entry) {
  return Boolean(getPrescriptionDownloadUrl(entry)) || Boolean(getPrescriptionStoragePath(entry));
}

function getEntryDateKey(entry) {
  const raw = clean(entry?.createdAtIso) || clean(entry?.measuredAt) || clean(entry?.visitDate) || clean(entry?.savedAt);
  if (!raw) return '';
  const match = raw.match(/^\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const app = initializeApp(FIREBASE_CONFIG, `kid-vitals-pdf-audit-${Date.now()}`);
  const db = getFirestore(app);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const [patientsSnapshot, historySnapshot] = await Promise.all([
    getDocs(collection(db, PATIENTS_COLLECTION)),
    getDocs(collection(db, HISTORY_COLLECTION))
  ]);

  const patients = patientsSnapshot.docs.map((d) => ({ docId: d.id, ...d.data() }));
  const historyEntries = historySnapshot.docs.map((d) => ({ docId: d.id, ...d.data() }));

  const patientNameById = new Map(
    patients.map((p) => [clean(p.patientId || p.docId).toUpperCase(), clean(p.childName)])
  );

  // Group history entries by patientId -> dateKey, tracking whether that
  // patient/date pair has any vitals-bearing entry and any PDF-bearing entry.
  const byPatientDate = new Map();

  historyEntries.forEach((entry) => {
    const patientId = clean(entry.patientId).toUpperCase();
    const dateKey = getEntryDateKey(entry);
    if (!patientId || !dateKey) return;

    const mapKey = `${patientId}|${dateKey}`;
    const bucket = byPatientDate.get(mapKey) || { patientId, dateKey, hasVitals: false, hasPdf: false };
    if (hasVitalsContent(entry)) bucket.hasVitals = true;
    if (hasPdf(entry)) bucket.hasPdf = true;
    byPatientDate.set(mapKey, bucket);
  });

  const missing = [];
  let vitalsDateCount = 0;

  byPatientDate.forEach((bucket) => {
    if (!bucket.hasVitals) return;
    vitalsDateCount += 1;
    if (bucket.hasPdf) return;
    missing.push({
      patientId: bucket.patientId,
      name: patientNameById.get(bucket.patientId) || '',
      date: bucket.dateKey
    });
  });

  missing.sort((a, b) => (a.patientId === b.patientId ? a.date.localeCompare(b.date) : a.patientId.localeCompare(b.patientId)));

  console.log('Kid EMR: vitals dates missing a same-day PDF');
  console.log(`Patients scanned: ${patients.length}`);
  console.log(`History docs scanned: ${historyEntries.length}`);
  console.log(`Distinct patient/date pairs with vitals: ${vitalsDateCount}`);
  console.log(`Patient/date pairs with vitals but NO pdf: ${missing.length}`);
  console.log('');
  missing.forEach((m) => {
    console.log(`  ${m.patientId}  ${m.date}  ${m.name}`);
  });

  const outputPath = path.join(OUTPUT_DIR, `kid-vitals-missing-pdf-${timestamp}.json`);
  writeJson(outputPath, {
    generatedAt: new Date().toISOString(),
    totals: {
      patientsScanned: patients.length,
      historyDocsScanned: historyEntries.length,
      vitalsDatePairs: vitalsDateCount,
      missingPdfPairs: missing.length
    },
    missing
  });
  console.log('');
  console.log(`Report written to ${outputPath}`);
}

main().catch((error) => {
  console.error('Audit failed:', error);
  process.exitCode = 1;
});
