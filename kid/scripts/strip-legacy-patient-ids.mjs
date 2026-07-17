import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import {
  collection,
  deleteField,
  doc,
  getDocs,
  getFirestore,
  setDoc
} from 'firebase/firestore';

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
const PATIENTS_COLLECTION = 'clinics/kid/patients';
const LEGACY_FIELD_PATTERN = /^legacy/i;

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function listLegacyFields(data) {
  return Object.keys(data || {}).filter((key) => LEGACY_FIELD_PATTERN.test(key));
}

async function main() {
  const app = initializeApp(FIREBASE_CONFIG, `kid-strip-legacy-${Date.now()}`);
  const db = getFirestore(app);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const summaryPath = path.join(OUTPUT_DIR, `kid-strip-legacy-summary-${timestamp}.json`);
  const backupPath = path.join(OUTPUT_DIR, `kid-strip-legacy-backup-${timestamp}.json`);

  const snapshot = await getDocs(collection(db, PATIENTS_COLLECTION));
  const records = snapshot.docs.map((docSnap) => ({
    docId: docSnap.id,
    data: docSnap.data(),
    legacyFields: listLegacyFields(docSnap.data())
  }));
  const targets = records.filter((record) => record.legacyFields.length > 0);

  writeJson(backupPath, {
    generatedAt: new Date().toISOString(),
    collection: PATIENTS_COLLECTION,
    count: records.length,
    records: targets
  });

  writeJson(summaryPath, {
    generatedAt: new Date().toISOString(),
    mode: WRITE_MODE ? 'write' : 'dry-run',
    collection: PATIENTS_COLLECTION,
    totals: {
      scanned: records.length,
      documentsWithLegacyFields: targets.length,
      legacyFieldsToRemove: targets.reduce((total, record) => total + record.legacyFields.length, 0)
    },
    records: targets.map((record) => ({
      docId: record.docId,
      legacyFields: record.legacyFields
    }))
  });

  console.log(`Patients scanned: ${records.length}`);
  console.log(`Documents with legacy fields: ${targets.length}`);
  console.log(`Legacy fields to remove: ${targets.reduce((total, record) => total + record.legacyFields.length, 0)}`);
  console.log(`Backup log: ${backupPath}`);
  console.log(`Summary log: ${summaryPath}`);

  if (!WRITE_MODE) {
    console.log('Dry run only. Re-run with --write to remove legacy fields.');
    return;
  }

  for (const record of targets) {
    const patch = {};
    for (const field of record.legacyFields) {
      patch[field] = deleteField();
    }
    await setDoc(doc(db, PATIENTS_COLLECTION, record.docId), patch, { merge: true });
  }

  console.log('Legacy field removal complete.');
}

await main();
