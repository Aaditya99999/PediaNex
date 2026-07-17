import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { collection, doc, getDocs, getFirestore, writeBatch } from 'firebase/firestore';

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
const BATCH_SIZE = 400;

const args = new Set(process.argv.slice(2));
const WRITE_MODE = args.has('--write');
const FORCE_MODE = args.has('--force');

function clean(value) {
  return String(value ?? '').trim();
}

function hasVitalsContent(entry) {
  return ['weight', 'height', 'head', 'spo2', 'pulse', 'systolic', 'diastolic', 'temp', 'rawVitals']
    .some((key) => Boolean(clean(entry?.[key])));
}

function getEntryIso(entry) {
  const raw = clean(entry?.createdAtIso) || clean(entry?.measuredAt) || clean(entry?.visitDate) || clean(entry?.savedAt);
  if (!raw) return '';
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function getEntryTimestamp(entry) {
  const iso = getEntryIso(entry);
  return iso ? Date.parse(iso) : 0;
}

function buildMeasurementRecord(entry) {
  const createdAtIso = getEntryIso(entry) || new Date().toISOString();
  return {
    createdAtIso,
    createdAtDisplay: new Date(createdAtIso).toLocaleString('en-IN'),
    charts: Array.isArray(entry.charts) ? entry.charts : [],
    weight: clean(entry.weight),
    height: clean(entry.height),
    head: clean(entry.head),
    temp: clean(entry.temp),
    pulse: clean(entry.pulse),
    spo2: clean(entry.spo2),
    systolic: clean(entry.systolic),
    diastolic: clean(entry.diastolic),
    age: clean(entry.age),
    source: 'backfill-last-measurement'
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const app = initializeApp(FIREBASE_CONFIG, `kid-backfill-last-measurement-${Date.now()}`);
  const db = getFirestore(app);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const [patientsSnapshot, historySnapshot] = await Promise.all([
    getDocs(collection(db, PATIENTS_COLLECTION)),
    getDocs(collection(db, HISTORY_COLLECTION))
  ]);

  const patients = patientsSnapshot.docs.map((d) => ({ docId: d.id, ...d.data() }));
  const historyEntries = historySnapshot.docs.map((d) => ({ docId: d.id, ...d.data() }));

  const latestVitalsByPatientId = new Map();
  historyEntries.forEach((entry) => {
    if (!hasVitalsContent(entry)) return;
    const patientId = clean(entry.patientId).toUpperCase();
    if (!patientId) return;
    const timestampMs = getEntryTimestamp(entry);
    const current = latestVitalsByPatientId.get(patientId);
    if (!current || timestampMs > current.timestampMs) {
      latestVitalsByPatientId.set(patientId, { entry, timestampMs });
    }
  });

  const plan = [];
  let alreadyCurrent = 0;
  let noVitalsFound = 0;

  patients.forEach((patient) => {
    const patientId = clean(patient.patientId || patient.docId).toUpperCase();
    const latest = latestVitalsByPatientId.get(patientId);
    if (!latest) {
      noVitalsFound += 1;
      return;
    }

    const existingIso = clean(patient.lastMeasurementRecord?.createdAtIso);
    const existingTimestampMs = existingIso ? Date.parse(existingIso) : -Infinity;

    if (!FORCE_MODE && existingTimestampMs >= latest.timestampMs) {
      alreadyCurrent += 1;
      return;
    }

    plan.push({
      patientId,
      docId: patient.docId,
      measurementRecord: buildMeasurementRecord(latest.entry)
    });
  });

  console.log(`Kid last-measurement backfill ${WRITE_MODE ? 'WRITE' : 'DRY RUN'}`);
  console.log(`Patients scanned: ${patients.length}`);
  console.log(`History docs scanned: ${historyEntries.length}`);
  console.log(`Patients with a vitals-bearing history entry: ${latestVitalsByPatientId.size}`);
  console.log(`Patients with no vitals history found (skipped): ${noVitalsFound}`);
  console.log(`Patients already up to date (skipped): ${alreadyCurrent}`);
  console.log(`Patients needing a lastMeasurementRecord write: ${plan.length}`);

  writeJson(path.join(OUTPUT_DIR, `kid-backfill-last-measurement-plan-${timestamp}.json`), {
    generatedAt: new Date().toISOString(),
    writeMode: WRITE_MODE,
    forceMode: FORCE_MODE,
    totals: {
      patientsScanned: patients.length,
      historyDocsScanned: historyEntries.length,
      patientsWithVitals: latestVitalsByPatientId.size,
      noVitalsFound,
      alreadyCurrent,
      needsWrite: plan.length
    },
    plan
  });

  if (!WRITE_MODE) {
    console.log('');
    console.log('Dry run only. Review the plan log, then rerun with --write to apply.');
    return;
  }

  let written = 0;
  for (let index = 0; index < plan.length; index += BATCH_SIZE) {
    const chunk = plan.slice(index, index + BATCH_SIZE);
    const batch = writeBatch(db);
    chunk.forEach((item) => {
      batch.set(doc(db, PATIENTS_COLLECTION, item.docId), {
        lastMeasurementRecord: item.measurementRecord
      }, { merge: true });
    });
    await batch.commit();
    written += chunk.length;
    console.log(`  ...committed ${written} / ${plan.length}`);
  }

  console.log('Backfill complete.');
}

main().catch((error) => {
  console.error('Backfill failed:', error);
  process.exitCode = 1;
});
