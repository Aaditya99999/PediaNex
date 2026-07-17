import crypto from 'node:crypto';
import { initializeApp } from 'firebase/app';
import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore';

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

function clean(value) { return String(value ?? '').trim(); }
function compactSpaces(value) { return clean(value).replace(/\s+/g, ' '); }
function isValidKidPatientId(value) { return /^TBK\d{4}$/.test(clean(value).toUpperCase()); }
function getIso(value) {
  const raw = clean(value);
  if (!raw) return '';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
function hasVitalsContent(entry) {
  return ['weight','height','head','spo2','pulse','systolic','diastolic','temp','rawVitals'].some((key) => {
    const value = entry[key];
    return Array.isArray(value) ? value.some((item) => clean(item)) : Boolean(clean(value));
  });
}
function hasPrescriptionMinimumValues(entry) {
  const hasPatientIdentity = isValidKidPatientId(entry.patientId) && Boolean(compactSpaces(entry.childName || entry.name));
  const hasVisitDate = Boolean(getIso(entry.createdAtIso || entry.measuredAt || entry.visitDate || entry.savedAt));
  const hasBody = hasVitalsContent(entry);
  return hasPatientIdentity && hasVisitDate && hasBody;
}

async function main() {
  const db = getFirestore(initializeApp(FIREBASE_CONFIG, `recount-${Date.now()}`));
  const historyRef = collection(db, `${CLINIC_NAMESPACE}/history`);
  const historyQuery = query(historyRef, where('source', '==', 'csv-import'));
  const snapshot = await getDocs(historyQuery);
  console.log('CSV history records found:', snapshot.size);

  const entries = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  const candidates = entries.filter(hasPrescriptionMinimumValues);
  console.log('Eligible (recount):', candidates.length);

  const tbk0040 = candidates.filter((e) => clean(e.patientId).toUpperCase() === 'TBK0040');
  console.log('TBK0040 among candidates:', tbk0040.length, tbk0040.map((e) => e.id));

  const existingQuery = query(historyRef, where('generatedFrom', '==', 'csv-import-vitals-history'));
  const existingSnapshot = await getDocs(existingQuery);
  console.log('Already generated (generatedFrom marker present):', existingSnapshot.size);

  function hashId(value) {
    return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 28);
  }
  const existingIds = new Set(existingSnapshot.docs.map((d) => d.id));
  const pending = candidates.filter((entry) => {
    const seed = entry.importKey || entry.id || `${entry.patientId}|${entry.createdAtIso || entry.visitDate || ''}`;
    const hash = hashId(seed);
    const docId = `csvVitalPrescription_${hash}`;
    return !existingIds.has(docId);
  });
  console.log('Pending (recount):', pending.length);
  console.log('Sample pending:', pending.slice(0, 5).map((e) => `${e.patientId} ${e.id}`));
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
