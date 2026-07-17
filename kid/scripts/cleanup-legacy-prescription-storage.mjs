import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { collection, getDocs, getFirestore } from 'firebase/firestore';
import { deleteObject, getMetadata, getStorage, listAll, ref } from 'firebase/storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'migration-logs');
const STATE_PATH = path.join(OUTPUT_DIR, 'kid-legacy-storage-cleanup-state.json');
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

function isQuotaError(error) {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  return code.includes('quota')
    || code.includes('resource-exhausted')
    || code.includes('retry-limit-exceeded')
    || message.includes('quota')
    || message.includes('resource exhausted')
    || message.includes('rate limit')
    || message.includes('429')
    || message.includes('too many requests');
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { deletedPaths: [], skippedNoBackup: [], skippedUnmapped: [] };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function main() {
  const app = initializeApp(FIREBASE_CONFIG, `kid-legacy-storage-cleanup-${Date.now()}`);
  const db = getFirestore(app);
  const storage = getStorage(app);

  const [patientsSnapshot, historySnapshot, storageListing] = await Promise.all([
    getDocs(collection(db, PATIENTS_COLLECTION)),
    getDocs(collection(db, HISTORY_COLLECTION)),
    listAll(ref(storage, STORAGE_PRESCRIPTION_PREFIX))
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

  // Build legacyId -> currentId map straight from history entries (same identity logic as the relink script).
  const legacyToCurrent = new Map();
  historyEntries.forEach((entry) => {
    const legacyId = clean(entry.patientId).toUpperCase();
    if (!legacyId || isCurrentTbkId(legacyId) || legacyToCurrent.has(legacyId)) return;

    const name = normalizeName(entry.childName);
    const phone = normalizePhone(entry.phone || entry.mobileNumber);
    const dob = clean(entry.dob);

    let match = (name && phone) ? patientsByNamePhone.get(`${name}|${phone}`) : null;
    if (!match && name && dob) match = patientsByNameDob.get(`${name}|${dob}`);
    if (match) {
      legacyToCurrent.set(legacyId, clean(match.patientId || match.docId).toUpperCase());
    }
  });

  const legacyFolders = storageListing.prefixes
    .map((p) => p.name)
    .filter((name) => !isCurrentTbkId(name));

  const state = loadState();
  const alreadyDeleted = new Set(state.deletedPaths || []);

  let checked = 0;
  let deletedThisRun = 0;
  let skippedNoBackup = 0;
  let skippedUnmapped = 0;
  let skippedAlreadyDone = 0;
  let stoppedForQuota = false;

  outer:
  for (const legacyId of legacyFolders) {
    const currentId = legacyToCurrent.get(legacyId);
    if (!currentId) {
      skippedUnmapped += 1;
      if (!state.skippedUnmapped.includes(legacyId)) state.skippedUnmapped.push(legacyId);
      continue;
    }

    const legacyListing = await listAll(ref(storage, `${STORAGE_PRESCRIPTION_PREFIX}/${legacyId}`));
    for (const item of legacyListing.items) {
      checked += 1;
      const oldPath = item.fullPath;
      if (alreadyDeleted.has(oldPath)) {
        skippedAlreadyDone += 1;
        continue;
      }

      const newPath = oldPath.replace(`/${legacyId}/`, `/${currentId}/`);
      const newRef = ref(storage, newPath);

      let backupExists = false;
      try {
        await getMetadata(newRef);
        backupExists = true;
      } catch {
        backupExists = false;
      }

      if (!backupExists) {
        skippedNoBackup += 1;
        if (!state.skippedNoBackup.includes(oldPath)) state.skippedNoBackup.push(oldPath);
        continue;
      }

      if (!WRITE_MODE) {
        deletedThisRun += 1;
        continue;
      }

      try {
        await deleteObject(item);
        deletedThisRun += 1;
        alreadyDeleted.add(oldPath);
        state.deletedPaths.push(oldPath);

        if (deletedThisRun % 50 === 0) {
          console.log(`  ...deleted ${deletedThisRun} so far (checked ${checked})`);
          writeState(state);
        }
      } catch (error) {
        if (isQuotaError(error)) {
          console.log('');
          console.log(`Hit a quota/rate-limit error after deleting ${deletedThisRun} files this run: ${error.message}`);
          console.log('Stopping cleanly. Re-run this script (with --write) tomorrow to continue from where it left off.');
          stoppedForQuota = true;
          break outer;
        }
        console.error(`  ! Delete failed for ${oldPath}: ${error.message}`);
      }
    }
  }

  writeState(state);

  console.log(`Legacy cleanup ${WRITE_MODE ? 'WRITE' : 'DRY RUN'}`);
  console.log(`Legacy (non-TBK) folders in storage: ${legacyFolders.length}`);
  console.log(`  - unmapped to any current patient (left alone): ${skippedUnmapped}`);
  console.log(`Files checked: ${checked}`);
  console.log(`  - already deleted in a previous run: ${skippedAlreadyDone}`);
  console.log(`  - no confirmed copy under current TBK folder (left alone, NOT deleted): ${skippedNoBackup}`);
  console.log(`  - ${WRITE_MODE ? 'deleted' : 'would delete (has confirmed backup copy)'} this run: ${deletedThisRun}`);
  if (stoppedForQuota) {
    console.log('Run stopped early due to a quota/rate-limit error (see above). Safe to re-run --write again later.');
  } else if (WRITE_MODE) {
    console.log('All eligible legacy files processed. Cleanup complete.');
  } else {
    console.log('Dry run only. Rerun with --write to actually delete the legacy duplicates that have a confirmed backup.');
  }
  console.log(`State file: ${STATE_PATH}`);
}

await main();
