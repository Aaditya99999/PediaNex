import { initializeApp } from 'firebase/app';
import { doc, getFirestore, setDoc, serverTimestamp } from 'firebase/firestore';
import { getStorage, ref, listAll, getMetadata } from 'firebase/storage';

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
const STORAGE_STATS_DOC_PATH = [CLINIC_NAMESPACE, 'clinicSettings', 'storageStats'];
const CONCURRENCY = 16;

const args = new Set(process.argv.slice(2));
const WRITE_MODE = args.has('--write');

async function collectPdfStorageRefs(storage, prefix) {
  const pdfRefs = [];

  async function walk(folderRef) {
    const listing = await listAll(folderRef);
    pdfRefs.push(...listing.items.filter((itemRef) => itemRef.name.toLowerCase().endsWith('.pdf')));
    await Promise.all(listing.prefixes.map((childRef) => walk(childRef)));
  }

  await walk(ref(storage, prefix));
  return pdfRefs;
}

async function sumSizes(pdfRefs) {
  let totalBytes = 0;
  let resolved = 0;
  let index = 0;

  async function worker() {
    while (index < pdfRefs.length) {
      const current = index;
      index += 1;
      try {
        const metadata = await getMetadata(pdfRefs[current]);
        totalBytes += Number(metadata.size || 0);
        resolved += 1;
      } catch (error) {
        console.warn(`  ! Unable to read metadata for ${pdfRefs[current].fullPath}: ${error.message}`);
      }
      if (resolved % 200 === 0) {
        console.log(`  ...resolved ${resolved} / ${pdfRefs.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pdfRefs.length) }, worker));
  return { totalBytes, resolved };
}

async function main() {
  const app = initializeApp(FIREBASE_CONFIG, `kid-compute-storage-stats-${Date.now()}`);
  const db = getFirestore(app);
  const storage = getStorage(app);

  console.log(`Kid storage stats backfill ${WRITE_MODE ? 'WRITE' : 'DRY RUN'}`);
  console.log('Listing prescriptions/ ...');
  const prescriptionRefs = await collectPdfStorageRefs(storage, `${CLINIC_NAMESPACE}/prescriptions`);
  console.log(`Found ${prescriptionRefs.length} prescription PDFs.`);
  console.log('Listing chart-pdfs/ ...');
  const chartRefs = await collectPdfStorageRefs(storage, `${CLINIC_NAMESPACE}/chart-pdfs`);
  console.log(`Found ${chartRefs.length} chart PDFs.`);

  const allRefs = [...prescriptionRefs, ...chartRefs];
  console.log(`Reading metadata for ${allRefs.length} files (concurrency ${CONCURRENCY})...`);
  const { totalBytes, resolved } = await sumSizes(allRefs);

  console.log('');
  console.log(`Total PDF count: ${allRefs.length}`);
  console.log(`Resolved metadata for: ${resolved} / ${allRefs.length}`);
  console.log(`Total bytes: ${totalBytes} (${(totalBytes / (1024 * 1024)).toFixed(2)} MB)`);

  if (!WRITE_MODE) {
    console.log('');
    console.log('Dry run only. Rerun with --write to save these totals to Firestore.');
    return;
  }

  await setDoc(doc(db, ...STORAGE_STATS_DOC_PATH), {
    pdfCount: allRefs.length,
    totalBytes,
    updatedAt: serverTimestamp(),
    computedBy: 'compute-storage-stats-backfill'
  }, { merge: true });

  console.log('Storage stats saved.');
}

main().catch((error) => {
  console.error('Storage stats backfill failed:', error);
  process.exitCode = 1;
});
