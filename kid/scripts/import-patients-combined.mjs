import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  serverTimestamp,
  setDoc
} from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_PATH = 'C:\\Users\\Minali\\Desktop\\patients_combined (1).csv';
const OUTPUT_DIR = path.join(__dirname, '..', 'migration-logs');
const CLINIC_NAMESPACE = 'clinics/kid';
const PATIENTS_COLLECTION = `${CLINIC_NAMESPACE}/patients`;
const ID_PREFIX = 'TBK';
const IMPORT_SOURCE = 'patients_combined_2026-07-02';
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAm-cUFMyTFSyw8KlFOCcBKQkTKApEr5oo',
  authDomain: 'clinci-dr-gunda.firebaseapp.com',
  projectId: 'clinci-dr-gunda',
  storageBucket: 'clinci-dr-gunda.firebasestorage.app',
  messagingSenderId: '1059959825609',
  appId: '1:1059959825609:web:8201599754706ac4661918',
  measurementId: 'G-4V5JMVW45E'
};

const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || DEFAULT_SOURCE_PATH);
const writeMode = Boolean(args.write);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const summaryPath = path.join(OUTPUT_DIR, `patients-combined-import-summary-${timestamp}.json`);

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') {
      parsed.write = true;
    } else if (arg.startsWith('--source=')) {
      parsed.source = arg.slice('--source='.length);
    } else if (arg === '--source') {
      parsed.source = argv[index + 1];
      index += 1;
    }
  }

  return parsed;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(value);
      value = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }

  const headers = rows.shift()?.map((header) => header.trim()) || [];
  return rows
    .filter((csvRow) => csvRow.some((cell) => clean(cell)))
    .map((csvRow) => Object.fromEntries(headers.map((header, index) => [header, clean(csvRow[index])])));
}

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

function normalizeDate(value) {
  const text = clean(value);
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return text;
  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function numberValue(value) {
  const text = clean(value);
  if (!text) return undefined;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : text;
}

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== ''));
}

function getDisplayName(row) {
  return compact(row.fullName || [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' '));
}

function getExistingDisplayName(patient) {
  return compact(patient.childName || patient.fullName || patient.name || patient.patientName || [
    patient.firstName,
    patient.middleName,
    patient.lastName
  ].filter(Boolean).join(' '));
}

function patientMatchKey(name, phone) {
  return `${normalizeName(name)}|${normalizePhone(phone)}`;
}

function makeImportId(row) {
  const seed = [
    IMPORT_SOURCE,
    row.patientID,
    row.officeID,
    row.mobileNumber,
    row.fullName,
    row.vitals_last_updated,
    row.growth_last_date
  ].map(clean).join('|');
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

function parseTbkId(id) {
  const match = clean(id).toUpperCase().match(/^TBK(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function formatTbkId(serial) {
  return `${ID_PREFIX}${serial <= 9999 ? String(serial).padStart(4, '0') : serial}`;
}

function buildMainPatientPatch(row, patientId) {
  const name = getDisplayName(row);
  const phone = normalizePhone(row.mobileNumber);
  const patch = {
    patientId,
    childName: name,
    fullName: name,
    firstName: compact(row.firstName),
    middleName: compact(row.middleName),
    lastName: compact(row.lastName),
    phone,
    mobileNumber: phone,
    mobileNumberSecondary: normalizePhone(row.mobileNumberSecondary),
    secondaryNumberType: compact(row.secondaryNumberType),
    dob: normalizeDate(row.dateOfBirth),
    dateOfBirth: normalizeDate(row.dateOfBirth),
    age: compact(row.age),
    gender: compact(row.sex),
    sex: compact(row.sex),
    email: compact(row.email),
    address: compact(row.address),
    street: compact(row.street),
    locality: compact(row.locality),
    city: compact(row.city),
    pincode: compact(row.pincode),
    bloodGroup: compact(row.bloodGroup),
    allergies: compact(row.allergies),
    significantHistory: compact(row.significantHistory),
    familyHistory: compact(row.familyHistory),
    fatherName: compact(row.fatherName),
    fatherProfession: compact(row.fatherProfession),
    fatherHeight: numberValue(row.fatherHeight),
    motherName: compact(row.motherName),
    motherProfession: compact(row.motherProfession),
    motherHeight: numberValue(row.motherHeight),
    preTermDays: numberValue(row.preTermDays),
    referredBy: compact(row.referredBy),
    school: compact(row.school),
    group: compact(row.group),
    flag: compact(row.flag),
    legacyPatientID: compact(row.patientID),
    legacyOfficeID: compact(row.officeID),
    importSource: IMPORT_SOURCE
  };
  return stripUndefined(patch);
}

function buildVitals(row, patientId, importId) {
  const metrics = stripUndefined({
    bmi: numberValue(row.vital_bmi),
    bsa: numberValue(row.vital_bsa),
    diastolic: numberValue(row.vital_diastolic),
    randomBloodSugar: numberValue(row['vital_general-rbs']),
    height: numberValue(row.vital_height),
    ofc: numberValue(row.vital_ofc),
    pulse: numberValue(row.vital_pulse),
    respiratoryRate: numberValue(row['vital_r rate']),
    spo2: numberValue(row.vital_spo2),
    systolic: numberValue(row.vital_systolic),
    temperature: numberValue(row.vital_temperature),
    weight: numberValue(row.vital_weight)
  });
  if (!Object.keys(metrics).length) return null;
  return {
    id: importId,
    patientId,
    type: 'vitals',
    source: IMPORT_SOURCE,
    recordedAt: normalizeDate(row.vitals_last_updated),
    metrics
  };
}

function buildGrowth(row, patientId, importId) {
  const metrics = stripUndefined({
    height: numberValue(row.growth_height),
    weight: numberValue(row.growth_weight),
    bmi: numberValue(row.growth_bmi)
  });
  if (!Object.keys(metrics).length) return null;
  return {
    id: importId,
    patientId,
    type: 'growth',
    source: IMPORT_SOURCE,
    recordedAt: normalizeDate(row.growth_last_date),
    metrics
  };
}

function buildReports(row, patientId, importId) {
  const labs = stripUndefined({
    hemoglobin: numberValue(row.lab_Hemoglobin),
    plateletCount: numberValue(row.lab_Platelet_Count)
  });
  if (!Object.keys(labs).length) return null;
  return {
    id: importId,
    patientId,
    type: 'lab-report',
    source: IMPORT_SOURCE,
    labs
  };
}

function mergeWithoutClobbering(existing, incoming) {
  const merged = { ...incoming };
  for (const [key, value] of Object.entries(incoming)) {
    const current = existing[key];
    if (current !== undefined && current !== null && current !== '') {
      merged[key] = current;
    } else {
      merged[key] = value;
    }
  }
  merged.patientId = existing.patientId || incoming.patientId;
  return stripUndefined(merged);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const rows = parseCsv(fs.readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, ''));
  const app = initializeApp(FIREBASE_CONFIG, `patients-combined-import-${Date.now()}`);
  const db = getFirestore(app);
  const existingSnapshot = await getDocs(collection(db, PATIENTS_COLLECTION));
  const existingPatients = existingSnapshot.docs.map((docSnap) => ({
    docId: docSnap.id,
    data: docSnap.data()
  }));

  const existingByKey = new Map();
  let maxSerial = 0;
  for (const patient of existingPatients) {
    maxSerial = Math.max(maxSerial, parseTbkId(patient.docId), parseTbkId(patient.data.patientId));
    const key = patientMatchKey(getExistingDisplayName(patient.data), patient.data.phone || patient.data.mobileNumber);
    if (key === '|') continue;
    const bucket = existingByKey.get(key) || [];
    bucket.push(patient);
    existingByKey.set(key, bucket);
  }

  const skipped = [];
  const ambiguous = [];
  const actions = [];
  let nextSerial = maxSerial + 1;

  rows.forEach((row, index) => {
    const name = getDisplayName(row);
    const phone = normalizePhone(row.mobileNumber);
    if (!name || !phone) {
      skipped.push({ rowNumber: index + 2, reason: 'Missing required name or phone', name, phone, row });
      return;
    }

    const key = patientMatchKey(name, phone);
    const matches = existingByKey.get(key) || [];
    if (matches.length > 1) {
      ambiguous.push({
        rowNumber: index + 2,
        name,
        phone,
        matchedDocumentIds: matches.map((match) => match.docId)
      });
      return;
    }

    const existing = matches[0] || null;
    const patientId = existing?.docId || formatTbkId(nextSerial++);
    const importId = makeImportId(row);
    const incomingMain = buildMainPatientPatch(row, patientId);
    const mainPatch = existing ? mergeWithoutClobbering(existing.data, incomingMain) : incomingMain;

    actions.push({
      rowNumber: index + 2,
      action: existing ? 'update' : 'create',
      patientId,
      oldDocumentId: existing?.docId || '',
      name,
      phone,
      importId,
      mainPatch,
      subcollections: {
        imports: {
          id: importId,
          path: `${PATIENTS_COLLECTION}/${patientId}/imports/${importId}`,
          data: {
            id: importId,
            patientId,
            source: IMPORT_SOURCE,
            sourceFile: sourcePath,
            rawRow: row
          }
        },
        vitals: buildVitals(row, patientId, importId),
        growth: buildGrowth(row, patientId, importId),
        reports: buildReports(row, patientId, importId)
      }
    });
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    sourcePath,
    destination: PATIENTS_COLLECTION,
    matchRule: 'normalized case-insensitive display name + normalized 10-digit phone number',
    mainRecordSchema: 'identity/contact/demographic fields only, merged without replacing existing non-empty fields',
    subcollectionSchemas: {
      imports: `${PATIENTS_COLLECTION}/{patientId}/imports/{importId}: raw source row and import metadata`,
      vitals: `${PATIENTS_COLLECTION}/{patientId}/vitals/{importId}: { id, patientId, type, source, recordedAt, metrics }`,
      growth: `${PATIENTS_COLLECTION}/{patientId}/growth/{importId}: { id, patientId, type, source, recordedAt, metrics }`,
      reports: `${PATIENTS_COLLECTION}/{patientId}/reports/{importId}: { id, patientId, type, source, labs }`
    },
    totals: {
      csvRows: rows.length,
      existingPatientsLoaded: existingPatients.length,
      updated: actions.filter((action) => action.action === 'update').length,
      created: actions.filter((action) => action.action === 'create').length,
      skippedIncomplete: skipped.length,
      ambiguous: ambiguous.length
    },
    skipped,
    ambiguous,
    actions: actions.map((action) => ({
      rowNumber: action.rowNumber,
      action: action.action,
      patientId: action.patientId,
      name: action.name,
      phone: action.phone,
      importId: action.importId,
      subcollections: Object.fromEntries(Object.entries(action.subcollections)
        .filter(([, value]) => value)
        .map(([key, value]) => [key, key === 'imports' ? value.path : `${PATIENTS_COLLECTION}/${action.patientId}/${key}/${action.importId}`]))
    }))
  };
  writeJson(summaryPath, summary);

  console.log(`CSV rows: ${rows.length}`);
  console.log(`Existing patients loaded from ${PATIENTS_COLLECTION}: ${existingPatients.length}`);
  console.log(`Planned updates: ${summary.totals.updated}`);
  console.log(`Planned creates: ${summary.totals.created}`);
  console.log(`Skipped incomplete: ${summary.totals.skippedIncomplete}`);
  console.log(`Ambiguous matches: ${summary.totals.ambiguous}`);
  console.log(`Summary log: ${summaryPath}`);

  if (!writeMode) {
    console.log('Dry run only. Re-run with --write to update Firestore.');
    return;
  }

  let updated = 0;
  let created = 0;
  for (const action of actions) {
    await setDoc(doc(db, PATIENTS_COLLECTION, action.patientId), {
      ...action.mainPatch,
      lastImportedAt: serverTimestamp()
    }, { merge: true });

    await setDoc(doc(db, `${PATIENTS_COLLECTION}/${action.patientId}/imports`, action.importId), {
      ...action.subcollections.imports.data,
      importedAt: serverTimestamp()
    }, { merge: true });

    for (const [name, data] of Object.entries(action.subcollections)) {
      if (!data || name === 'imports') continue;
      await setDoc(doc(db, `${PATIENTS_COLLECTION}/${action.patientId}/${name}`, action.importId), {
        ...data,
        importedAt: serverTimestamp()
      }, { merge: true });
    }

    if (action.action === 'update') updated += 1;
    if (action.action === 'create') created += 1;
  }

  console.log(`Write complete. Updated: ${updated}. Created: ${created}. Skipped incomplete: ${skipped.length}.`);
}

await main();
