import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { initializeApp } from 'firebase/app';
import { collection, doc, getFirestore, setDoc } from 'firebase/firestore';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAm-cUFMyTFSyw8KlFOCcBKQkTKApEr5oo',
  authDomain: 'clinci-dr-gunda.firebaseapp.com',
  projectId: 'clinci-dr-gunda',
  storageBucket: 'clinci-dr-gunda.firebasestorage.app',
  messagingSenderId: '1059959825609',
  appId: '1:1059959825609:web:8201599754706ac4661918',
  measurementId: 'G-4V5JMVW45E'
};

const TARGET_NAMES = new Set(['Kiribati', 'Syed Ayaz']);
const INPUT_PATH = new URL('../../../missing-csv-patients.json', import.meta.url);
const CLINIC_COLLECTION = 'clinics/kid/patients';

function normalize(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function titleCase(value) {
  return normalize(value).toLowerCase().replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePhone(value) {
  const digits = compact(value).replace(/\D/g, '');
  if (!digits) {
    return '';
  }

  return digits.length > 10 ? digits.slice(-10) : digits;
}

function subtractDateParts(dateValue, years = 0, months = 0, days = 0) {
  const date = new Date(`${dateValue}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const targetYear = date.getUTCFullYear() - years;
  const targetMonthIndex = date.getUTCMonth() - months;
  const targetDay = date.getUTCDate();
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  date.setUTCFullYear(targetYear, targetMonthIndex, Math.min(targetDay, lastDayOfTargetMonth));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function estimateDobFromAgeText(ageText, referenceDate) {
  const raw = compact(ageText).toLowerCase();
  if (!raw || !referenceDate) {
    return '';
  }

  const yearsMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:y|yr|yrs|year|years)\b/);
  const monthsMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:m|mo|mos|month|months)\b/);
  const daysMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:d|day|days)\b/);

  if (yearsMatch || monthsMatch || daysMatch) {
    return subtractDateParts(
      referenceDate,
      yearsMatch ? Math.trunc(Number(yearsMatch[1])) : 0,
      monthsMatch ? Math.trunc(Number(monthsMatch[1])) : 0,
      daysMatch ? Math.trunc(Number(daysMatch[1])) : 0
    );
  }

  const numericYears = raw.match(/^(\d+(?:\.\d+)?)$/);
  if (numericYears) {
    const years = Number(numericYears[1]);
    if (Number.isFinite(years)) {
      const wholeYears = Math.trunc(years);
      const months = Math.round((years - wholeYears) * 12);
      return subtractDateParts(referenceDate, wholeYears, months, 0);
    }
  }

  return '';
}

function makePatientId(row) {
  const seed = `${titleCase(row.patientName)}|${normalizePhone(row.mobile)}`;
  return `csv-${Buffer.from(seed).toString('base64url').slice(0, 20)}`;
}

const rows = JSON.parse(await fs.readFile(INPUT_PATH, 'utf8'));
const selectedRows = rows.filter((row) => TARGET_NAMES.has(row.patientName));

const app = initializeApp(FIREBASE_CONFIG, `kid-csv-name-fix-${Date.now()}`);
const db = getFirestore(app);
const nowIso = new Date().toISOString();
const referenceDate = '2025-10-31';

for (const row of selectedRows) {
  const patientId = makePatientId(row);
  const payload = {
    id: patientId,
    patientId,
    clinicId: 'kid',
    clinicNamespace: 'clinics/kid',
    source: 'csv-import',
    importBatchId: 'csv-manual-name-fix-2026-06-13',
    childName: titleCase(row.patientName),
    firstName: titleCase(row.patientName).split(/\s+/)[0] || titleCase(row.patientName),
    middleName: '',
    lastName: titleCase(row.patientName).split(/\s+/).slice(1).join(' '),
    gender: titleCase(row.gender),
    ageText: normalize(row.age),
    dob: estimateDobFromAgeText(row.age, referenceDate),
    phone: normalizePhone(row.mobile),
    mobileNumber: normalizePhone(row.mobile),
    parentName: '',
    email: '',
    bloodGroup: normalize(row.bloodGroup).replace(/^-$/, ''),
    abhaId: normalize(row.abhaId).replace(/^-$/, ''),
    tags: normalize(row.tag).replace(/^-$/, ''),
    measurementHistory: [],
    lastMeasurementRecord: null,
    activeConsultVitalsDraft: null,
    createdAtIso: nowIso,
    updatedAtIso: nowIso
  };

  await setDoc(doc(collection(db, CLINIC_COLLECTION), patientId), payload, { merge: true });
  console.log(`Wrote ${patientId} for ${payload.childName}`);
}
