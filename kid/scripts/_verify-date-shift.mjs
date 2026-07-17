import fs from 'node:fs';
import { initializeApp } from 'firebase/app';
import { collection, getDocs, getFirestore } from 'firebase/firestore';

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
function isPublicPdfUrl(value) { return /^https?:\/\//i.test(clean(value)); }
function hasPdf(entry) {
  const url = [entry?.downloadURL, entry?.downloadUrl, entry?.pdfURL, entry?.pdfUrl].find((v) => v && isPublicPdfUrl(v));
  const path = [entry?.storagePath, entry?.fullPath, entry?.filePath, entry?.pdfPath, entry?.path].find((v) => clean(v));
  return Boolean(url) || Boolean(path);
}
function dateKeyOf(entry) {
  const raw = clean(entry?.createdAtIso) || clean(entry?.measuredAt) || clean(entry?.visitDate) || clean(entry?.savedAt);
  const m = raw.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : '';
}
function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const report = JSON.parse(fs.readFileSync('migration-logs/kid-vitals-missing-pdf-2026-07-08T06-56-15-833Z.json', 'utf8'));
  const realMissing = report.missing.filter((m) => !['TBK0119', 'TBK1235', 'TBK0347'].includes(m.patientId));
  console.log('Real (non-test) still-flagged pairs:', realMissing.length);

  const db = getFirestore(initializeApp(FIREBASE_CONFIG, `verify-shift-${Date.now()}`));
  const historySnap = await getDocs(collection(db, `${CLINIC_NAMESPACE}/history`));
  const entries = historySnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const byPatientDate = new Map();
  entries.forEach((e) => {
    const pid = clean(e.patientId).toUpperCase();
    const dk = dateKeyOf(e);
    if (!pid || !dk) return;
    const key = `${pid}|${dk}`;
    if (!byPatientDate.has(key)) byPatientDate.set(key, []);
    byPatientDate.get(key).push(e);
  });

  let resolvedByShift = 0;
  let stillGenuinelyMissing = [];

  for (const m of realMissing) {
    const prevDay = addDays(m.date, -1);
    const nextDay = addDays(m.date, 1);
    const prevEntries = byPatientDate.get(`${m.patientId}|${prevDay}`) || [];
    const nextEntries = byPatientDate.get(`${m.patientId}|${nextDay}`) || [];
    const foundAdjacent = [...prevEntries, ...nextEntries].some(hasPdf);
    if (foundAdjacent) {
      resolvedByShift += 1;
    } else {
      stillGenuinelyMissing.push(m);
    }
  }

  console.log('Resolved by adjacent-day PDF (timezone shift):', resolvedByShift);
  console.log('Still genuinely missing (no PDF even +/-1 day):', stillGenuinelyMissing.length);
  stillGenuinelyMissing.forEach((m) => console.log(`  ${m.patientId} ${m.date} ${m.name}`));
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
