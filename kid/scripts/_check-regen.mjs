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

async function main() {
  const db = getFirestore(initializeApp(FIREBASE_CONFIG, `check-regen-${Date.now()}`));
  const snap = await getDoc(doc(db, `${CLINIC_NAMESPACE}/history`, 'csvVitalPrescription_ef55acaa36c50257a69b70df27e4'));
  const data = snap.data();
  console.log(JSON.stringify({
    exists: snap.exists(),
    patientId: data?.patientId,
    createdAtIso: data?.createdAtIso,
    storagePath: data?.storagePath,
    downloadURL: data?.downloadURL
  }, null, 2));
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
