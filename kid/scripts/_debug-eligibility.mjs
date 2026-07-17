import { initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore } from 'firebase/firestore';

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

async function main() {
  const db = getFirestore(initializeApp(FIREBASE_CONFIG, `debug-elig-${Date.now()}`));
  const snap = await getDoc(doc(db, `${CLINIC_NAMESPACE}/history`, 'csvImport_ef55acaa36c50257a69b70df27e4'));
  const entry = { id: snap.id, ...snap.data() };
  console.log('raw entry:', JSON.stringify(entry, null, 2));

  const hasPatientIdentity = isValidKidPatientId(entry.patientId) && Boolean(compactSpaces(entry.childName || entry.name));
  const hasVisitDate = Boolean(getIso(entry.createdAtIso || entry.measuredAt || entry.visitDate || entry.savedAt));
  const hasBody = hasVitalsContent(entry);
  console.log({ hasPatientIdentity, hasVisitDate, hasBody, source: entry.source, patientId: entry.patientId });
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
