import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV_DIR = path.join(os.homedir(), 'Downloads');
const CLINIC_NAMESPACE = 'clinics/kid';
const IMPORT_SOURCE = 'csv-import';
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAm-cUFMyTFSyw8KlFOCcBKQkTKApEr5oo',
  authDomain: 'clinci-dr-gunda.firebaseapp.com',
  projectId: 'clinci-dr-gunda',
  storageBucket: 'clinci-dr-gunda.firebasestorage.app',
  messagingSenderId: '1059959825609',
  appId: '1:1059959825609:web:8201599754706ac4661918',
  measurementId: 'G-4V5JMVW45E'
};

const CSV_FILES = {
  patients: "Gunda Srinivas's Patients 31 Oct 2025 1 44 PM - Gunda Srinivas's Patients 31 Oct 2025 1 44 PM.csv",
  appointments: 'Name, phone date etc.csv',
  vitals: 'Vitals.csv',
  symptoms: 'Symptoms.csv',
  diagnosis: 'Diagnosis.csv',
  drugs: 'Drugs.csv'
};

const CSV_FILE_CANDIDATES = {
  patients: [CSV_FILES.patients],
  appointments: [CSV_FILES.appointments],
  vitals: [CSV_FILES.vitals],
  symptoms: [CSV_FILES.symptoms],
  diagnosis: ['Diagnosis (2).csv', 'Diagnosis (1).csv', CSV_FILES.diagnosis],
  drugs: [CSV_FILES.drugs]
};

const args = parseArgs(process.argv.slice(2));
const csvDir = path.resolve(args.csvDir || DEFAULT_CSV_DIR);
const writeMode = Boolean(args.write);
const importBatchId = args.batchId || `kid-csv-${new Date().toISOString().slice(0, 10)}`;
const PATIENT_MASTER_REFERENCE_DATE = '2025-10-31';

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--write') {
      parsed.write = true;
      continue;
    }

    if (arg.startsWith('--csv-dir=')) {
      parsed.csvDir = arg.slice('--csv-dir='.length);
      continue;
    }

    if (arg === '--csv-dir') {
      parsed.csvDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--batch-id=')) {
      parsed.batchId = arg.slice('--batch-id='.length);
      continue;
    }

    if (arg === '--batch-id') {
      parsed.batchId = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--service-account=')) {
      parsed.serviceAccount = arg.slice('--service-account='.length);
      continue;
    }

    if (arg === '--service-account') {
      parsed.serviceAccount = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`
Kid EMR CSV importer

Usage:
  npm run import:csv
  npm run import:csv -- --write --service-account C:\\path\\service-account.json

Options:
  --csv-dir <path>          Directory containing the six CSV exports. Defaults to Downloads.
  --write                   Write merged records to Firestore. Omitted means dry-run only.
  --service-account <path>  Firebase service account JSON for write mode.
  --batch-id <id>           Import batch marker. Defaults to today's date.
`);
}

if (args.help) {
  printHelp();
  process.exit(0);
}

function readCsvRows(fileName) {
  const filePath = path.join(csvDir, fileName);
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return parseCsv(text);
}

function readCsvRowsFromCandidates(fileNames) {
  const rows = [];
  const usedFiles = [];

  for (const fileName of fileNames) {
    const filePath = path.join(csvDir, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    rows.push(...readCsvRows(fileName));
    usedFiles.push(fileName);
  }

  return { rows, usedFiles };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(value);
      value = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(value);
      if (row.some((cell) => cell.trim() !== '')) {
        rows.push(row);
      }
      row = [];
      value = '';
      continue;
    }

    value += char;
  }

  if (value || row.length) {
    row.push(value);
    if (row.some((cell) => cell.trim() !== '')) {
      rows.push(row);
    }
  }

  const headers = rows.shift()?.map((header) => header.trim()) || [];
  return rows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
}

function clean(value) {
  return String(value ?? '').replace(/\u00A0/g, ' ').trim();
}

function compactSpaces(value) {
  return clean(value).replace(/\s+/g, ' ');
}

function canonicalId(value) {
  const raw = compactSpaces(value);
  if (!raw || raw === '-') {
    return '';
  }
  return raw.replaceAll('/', '_').toUpperCase();
}

function getUhid(row) {
  return clean(row['UHID (DF)']) || clean(row.UHID) || clean(row['Patient UHID']);
}

function getPatientId(row) {
  return canonicalId(getUhid(row));
}

function getPersonName(row) {
  return compactSpaces(row['Patient Name']);
}

function getPersonPhone(row) {
  return normalizePhone(row.Mobile || row['Patient Mobile']);
}

function getLookupPhone(row) {
  return getCanonicalPhone(getPersonPhone(row));
}

function personLookupKey(row) {
  const name = getPersonName(row).toLowerCase();
  const phone = getLookupPhone(row);
  return name && phone ? `${name}|${phone}` : '';
}

function buildPatientIdLookup(patientRows) {
  const matches = new Map();

  for (const row of patientRows) {
    const patientId = getPatientId(row);
    const key = personLookupKey(row);
    if (!patientId || !key) {
      continue;
    }

    const existing = matches.get(key) || new Set();
    existing.add(patientId);
    matches.set(key, existing);
  }

  return matches;
}

function resolvePatientId(row, patientIdLookup) {
  const patientId = getPatientId(row);
  if (patientId) {
    return { patientId, matchedFromMaster: false };
  }

  const key = personLookupKey(row);
  const matches = key ? patientIdLookup.get(key) : null;
  if (matches?.size === 1) {
    return { patientId: [...matches][0], matchedFromMaster: true };
  }

  return { patientId: '', matchedFromMaster: false };
}

function generateFallbackPatientId(row) {
  const seed = [
    titleCase(row['Patient Name']),
    getCanonicalPhone(row.Mobile || row['Patient Mobile'])
  ].join('|');

  return `CSV-${hashId(seed)}`;
}

function normalizeGender(value) {
  const normalized = clean(value).toLowerCase();
  if (normalized === 'm' || normalized === 'male') {
    return 'Male';
  }
  if (normalized === 'f' || normalized === 'female') {
    return 'Female';
  }
  return clean(value);
}

function normalizePhone(value) {
  return getCanonicalPhone(value);
}

function getCanonicalPhone(value) {
  const digits = clean(value).replace(/\D/g, '');
  if (!digits) {
    return '';
  }

  return digits.length > 10 ? digits.slice(-10) : digits;
}

function titleCase(value) {
  return compactSpaces(value).toLowerCase().replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function toIsoDate(value) {
  const raw = clean(value);
  if (!raw) {
    return '';
  }

  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnly) {
    return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return raw;
}

function subtractDateParts(dateValue, years = 0, months = 0, days = 0) {
  const date = new Date(`${toIsoDate(dateValue)}T12:00:00.000Z`);
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
  const raw = compactSpaces(ageText).toLowerCase();
  const date = toIsoDate(referenceDate);
  if (!raw || !date) {
    return '';
  }

  const yearsMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:y|yr|yrs|year|years)\b/);
  const monthsMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:m|mo|mos|month|months)\b/);
  const daysMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:d|day|days)\b/);

  if (yearsMatch || monthsMatch || daysMatch) {
    return subtractDateParts(
      date,
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
      return subtractDateParts(date, wholeYears, months, 0);
    }
  }

  return '';
}

function combineDateAndTime(dateValue, timeValue) {
  const date = toIsoDate(dateValue);
  const time = clean(timeValue);
  if (!date) {
    return '';
  }

  if (!time) {
    return `${date}T00:00:00.000+05:30`;
  }

  const parsed = new Date(`${date} ${time}`);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  const fullTimestamp = new Date(time);
  if (!Number.isNaN(fullTimestamp.getTime())) {
    return fullTimestamp.toISOString();
  }

  return `${date} ${time}`;
}

function hashId(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 28);
}

function historyKey(patientId, dateValue, timeValue) {
  const date = toIsoDate(dateValue);
  const slot = compactSpaces(timeValue).toUpperCase();
  return `${patientId}|${date}|${slot || 'NO_SLOT'}`;
}

function ensurePatient(patientMap, patientId, details = {}) {
  if (!patientId) {
    return null;
  }

  const current = patientMap.get(patientId) || {
    patientId,
    legacyUhid: details.legacyUhid || patientId,
    source: IMPORT_SOURCE,
    importBatchId
  };

  const next = { ...current };
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined && value !== null && clean(value) !== '') {
      next[key] = value;
    }
  }

  next.patientId = patientId;
  next.source = IMPORT_SOURCE;
  next.importBatchId = importBatchId;
  patientMap.set(patientId, next);
  return next;
}

function splitCsvList(value) {
  return clean(value)
    .split(',')
    .map((item) => compactSpaces(item))
    .filter(Boolean);
}

function uniquePush(list, value) {
  const cleaned = compactSpaces(value);
  if (!cleaned) {
    return;
  }

  const key = cleaned.toLowerCase();
  if (!list.some((item) => item.toLowerCase() === key)) {
    list.push(cleaned);
  }
}

function mergeHistory(historyMap, key, patch) {
  const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const current = historyMap.get(key) || {
    source: IMPORT_SOURCE,
    importBatchId,
    type: 'csv-import',
    importedFrom: [],
    symptoms: [],
    diagnosis: [],
    drugs: [],
    rawVitals: [],
    rawAppointments: []
  };

  const next = { ...current, ...cleanPatch };
  next.importedFrom = [...new Set([...(current.importedFrom || []), ...(cleanPatch.importedFrom || [])])];
  next.symptoms = [...(current.symptoms || [])];
  next.diagnosis = [...(current.diagnosis || [])];
  next.drugs = [...(current.drugs || [])];
  next.rawVitals = [...(current.rawVitals || [])];
  next.rawAppointments = [...(current.rawAppointments || [])];

  for (const value of cleanPatch.symptoms || []) {
    uniquePush(next.symptoms, value);
  }
  for (const value of cleanPatch.diagnosis || []) {
    uniquePush(next.diagnosis, value);
  }
  for (const value of cleanPatch.drugs || []) {
    uniquePush(next.drugs, value);
  }
  for (const value of cleanPatch.rawVitals || []) {
    uniquePush(next.rawVitals, value);
  }
  for (const value of cleanPatch.rawAppointments || []) {
    next.rawAppointments.push(value);
  }

  historyMap.set(key, next);
}

function parseVitals(value) {
  const raw = clean(value);
  const parsed = {};
  const items = splitCsvList(raw);
  const setIfValid = (key, numberValue, min, max) => {
    const parsedNumber = Number.parseFloat(numberValue);
    if (Number.isFinite(parsedNumber) && parsedNumber >= min && parsedNumber <= max) {
      parsed[key] = String(parsedNumber);
    }
  };

  for (const item of items) {
    const [labelPart, ...valueParts] = item.split(' - ');
    const label = clean(labelPart).toLowerCase();
    const itemValue = clean(valueParts.join(' - '));
    const numberMatch = itemValue.match(/-?\d+(?:\.\d+)?/);
    const numberValue = numberMatch ? numberMatch[0] : '';

    if (!numberValue) {
      continue;
    }

    if (label === 'body weight') {
      setIfValid('weight', numberValue, 0.5, 250);
    } else if (label === 'body height') {
      setIfValid('height', numberValue, 20, 250);
    } else if (label.includes('occipital frontal circumference') || label === 'ofc' || label === 'head circumference') {
      setIfValid('head', numberValue, 20, 80);
    } else if (label.includes('oxygen') || label.includes('spo2') || label.includes('saturation')) {
      setIfValid('spo2', numberValue, 50, 100);
    } else if (label.includes('pulse') || label.includes('heart rate')) {
      setIfValid('pulse', numberValue, 30, 250);
    } else if (label.includes('temperature') || label === 'temp') {
      setIfValid('temp', numberValue, 30, 45);
    }
  }

  return parsed;
}

function addCatalogItems(catalog, sectionName, values) {
  for (const value of values) {
    const normalized = normalizeCatalogItem(sectionName, value);
    if (!isJunkCatalogItem(normalized)) {
      uniquePush(catalog[sectionName], normalized);
    }
  }
}

function normalizeCatalogItem(sectionName, value) {
  let cleaned = compactSpaces(value).replace(/\?/g, '');

  if (sectionName === 'Diagnosis') {
    cleaned = cleaned
      .split(',')
      .map((part) => compactSpaces(part))
      .filter((part) => part && part.toLowerCase() !== 'well child')
      .join(', ');
  }

  return compactSpaces(cleaned);
}

function isJunkCatalogItem(value) {
  return new Set(['.', 'a', 'aa', '11', 'test', 'testing', 'abc', 'asdf', 'qwerty', 'demo', 'sample'])
    .has(compactSpaces(value).toLowerCase());
}

function buildImportData() {
  const rows = {};
  const sourceFiles = {};
  for (const [key, fileNames] of Object.entries(CSV_FILE_CANDIDATES)) {
    const result = readCsvRowsFromCandidates(fileNames);
    rows[key] = result.rows;
    sourceFiles[key] = result.usedFiles;
  }
  const patientIdLookup = buildPatientIdLookup([
    ...rows.patients,
    ...rows.appointments,
    ...rows.vitals,
    ...rows.symptoms,
    ...rows.diagnosis,
    ...rows.drugs
  ]);
  const patients = new Map();
  const history = new Map();
  let historyInputRows = 0;
  const catalog = {
    Symptoms: [],
    Diagnosis: [],
    Medication: []
  };
  const skipped = [];

  for (const row of rows.patients) {
    const { patientId, matchedFromMaster } = resolvePatientId(row, patientIdLookup);
    const resolvedPatientId = patientId || generateFallbackPatientId(row);

    ensurePatient(patients, resolvedPatientId, {
      legacyUhid: getUhid(row) || resolvedPatientId,
      legacyUhidResolvedFromMaster: matchedFromMaster || undefined,
      childName: titleCase(row['Patient Name']),
      gender: normalizeGender(row.Gender),
      phone: normalizePhone(row.Mobile),
      mobileNumber: normalizePhone(row.Mobile),
      ageText: clean(row.Age),
      dob: estimateDobFromAgeText(row.Age, PATIENT_MASTER_REFERENCE_DATE),
      bloodGroup: clean(row['Blood Group (DF)']).replace(/^-$/, ''),
      abhaId: clean(row['ABHA Id (DF)']).replace(/^-$/, ''),
      tags: clean(row['Tag (DF)']).replace(/^-$/, '')
    });
  }

  for (const row of rows.appointments) {
    const { patientId, matchedFromMaster } = resolvePatientId(row, patientIdLookup);
    if (!patientId) {
      skipped.push({ file: CSV_FILES.appointments, reason: 'missing UHID and no unique master match', row });
      continue;
    }

    const visitTime = clean(row['Visit Start Time']) || clean(row['Visit Scheduled Time']) || clean(row.date);
    const key = historyKey(patientId, row.date, visitTime);
    historyInputRows += 1;
    ensurePatient(patients, patientId, {
      legacyUhid: getUhid(row) || patientId,
      legacyUhidResolvedFromMaster: matchedFromMaster || undefined,
      childName: titleCase(row['Patient Name']),
      gender: normalizeGender(row['Patient Gender']),
      phone: normalizePhone(row['Patient Mobile']),
      mobileNumber: normalizePhone(row['Patient Mobile']),
      address: clean(row['Patient Address']),
      abhaId: clean(row['Abha Health ID']).replace(/^-$/, ''),
      visitCount: clean(row['Visit Count']),
      tags: clean(row.Tags),
      lastAppointmentDate: toIsoDate(row.date)
    });

    mergeHistory(history, key, {
      patientId,
      legacyUhid: getUhid(row) || patientId,
      legacyUhidResolvedFromMaster: matchedFromMaster || undefined,
      childName: titleCase(row['Patient Name']),
      gender: normalizeGender(row['Patient Gender']),
      phone: normalizePhone(row['Patient Mobile']),
      age: clean(row.Age),
      visitDate: toIsoDate(row.date),
      measuredAt: combineDateAndTime(row.date, visitTime),
      importedFrom: [CSV_FILES.appointments],
      appointmentId: clean(row['Appointment ID']),
      appointmentStatus: clean(row.Status),
      appointmentType: clean(row['Appointment Type']),
      visitType: clean(row['Visit Type']),
      channel: clean(row.Channel),
      followUpDate: toIsoDate(row['Follow Up Date']),
      rawAppointments: [Object.fromEntries(Object.entries(row).map(([name, value]) => [name, clean(value)]))]
    });
  }

  for (const row of rows.symptoms) {
    const { patientId, matchedFromMaster } = resolvePatientId(row, patientIdLookup);
    if (!patientId) {
      skipped.push({ file: CSV_FILES.symptoms, reason: 'missing Patient UHID and no unique master match', row });
      continue;
    }

    const symptomItems = splitCsvList(row.Symptom);
    addCatalogItems(catalog, 'Symptoms', symptomItems);
    ensurePatient(patients, patientId, {
      legacyUhid: getUhid(row) || patientId,
      legacyUhidResolvedFromMaster: matchedFromMaster || undefined,
      childName: titleCase(row['Patient Name']),
      gender: normalizeGender(row['Patient Gender']),
      phone: normalizePhone(row['Patient Mobile']),
      mobileNumber: normalizePhone(row['Patient Mobile'])
    });

    mergeHistory(history, historyKey(patientId, row.Date, row.Slot), {
      patientId,
      legacyUhid: getUhid(row) || patientId,
      legacyUhidResolvedFromMaster: matchedFromMaster || undefined,
      childName: titleCase(row['Patient Name']),
      gender: normalizeGender(row['Patient Gender']),
      phone: normalizePhone(row['Patient Mobile']),
      age: clean(row['Patient Age']),
      visitDate: toIsoDate(row.Date),
      measuredAt: combineDateAndTime(row.Date, row.Slot),
      importedFrom: [CSV_FILES.symptoms],
      symptoms: symptomItems,
      rawSymptom: clean(row.Symptom)
    });
  }

  for (const row of rows.diagnosis) {
    const { patientId, matchedFromMaster } = resolvePatientId(row, patientIdLookup);
    if (!patientId) {
      skipped.push({ file: CSV_FILES.diagnosis, reason: 'missing Patient UHID and no unique master match', row });
      continue;
    }

    const diagnosis = compactSpaces(row.Diagnosis);
    addCatalogItems(catalog, 'Diagnosis', [diagnosis]);
    ensurePatient(patients, patientId, {
      legacyUhid: getUhid(row) || patientId,
      legacyUhidResolvedFromMaster: matchedFromMaster || undefined,
      childName: titleCase(row['Patient Name']),
      gender: normalizeGender(row['Patient Gender']),
      phone: normalizePhone(row['Patient Mobile']),
      mobileNumber: normalizePhone(row['Patient Mobile'])
    });

    mergeHistory(history, historyKey(patientId, row.Date, row.Slot), {
      patientId,
      legacyUhid: getUhid(row) || patientId,
      legacyUhidResolvedFromMaster: matchedFromMaster || undefined,
      childName: titleCase(row['Patient Name']),
      gender: normalizeGender(row['Patient Gender']),
      phone: normalizePhone(row['Patient Mobile']),
      age: clean(row['Patient Age']),
      visitDate: toIsoDate(row.Date),
      measuredAt: combineDateAndTime(row.Date, row.Slot),
      importedFrom: [CSV_FILES.diagnosis],
      diagnosis: [diagnosis],
      rawDiagnosis: diagnosis
    });
  }

  for (const row of rows.drugs) {
    const { patientId, matchedFromMaster } = resolvePatientId(row, patientIdLookup);
    if (!patientId) {
      skipped.push({ file: CSV_FILES.drugs, reason: 'missing Patient UHID and no unique master match', row });
      continue;
    }

    const drugs = splitCsvList(row.Drug);
    addCatalogItems(catalog, 'Medication', drugs);
    ensurePatient(patients, patientId, {
      legacyUhid: getUhid(row) || patientId,
      legacyUhidResolvedFromMaster: matchedFromMaster || undefined,
      childName: titleCase(row['Patient Name']),
      gender: normalizeGender(row['Patient Gender']),
      phone: normalizePhone(row['Patient Mobile']),
      mobileNumber: normalizePhone(row['Patient Mobile'])
    });

    mergeHistory(history, historyKey(patientId, row.Date, row.Slot), {
      patientId,
      legacyUhid: getUhid(row) || patientId,
      legacyUhidResolvedFromMaster: matchedFromMaster || undefined,
      childName: titleCase(row['Patient Name']),
      gender: normalizeGender(row['Patient Gender']),
      phone: normalizePhone(row['Patient Mobile']),
      age: clean(row['Patient Age']),
      visitDate: toIsoDate(row.Date),
      measuredAt: combineDateAndTime(row.Date, row.Slot),
      importedFrom: [CSV_FILES.drugs],
      drugs,
      rawDrug: clean(row.Drug)
    });
  }

  for (const row of rows.vitals) {
    const { patientId, matchedFromMaster } = resolvePatientId(row, patientIdLookup);
    if (!patientId) {
      skipped.push({ file: CSV_FILES.vitals, reason: 'missing Patient UHID and no unique master match', row });
      continue;
    }

    const parsedVitals = parseVitals(row['Vital Name And Value']);
    historyInputRows += 1;
    ensurePatient(patients, patientId, {
      legacyUhid: getUhid(row) || patientId,
      legacyUhidResolvedFromMaster: matchedFromMaster || undefined,
      childName: titleCase(row['Patient Name']),
      gender: normalizeGender(row['Patient Gender']),
      phone: normalizePhone(row['Patient Mobile']),
      mobileNumber: normalizePhone(row['Patient Mobile'])
    });

    mergeHistory(history, historyKey(patientId, row.date, 'vitals'), {
      patientId,
      legacyUhid: getUhid(row) || patientId,
      legacyUhidResolvedFromMaster: matchedFromMaster || undefined,
      childName: titleCase(row['Patient Name']),
      gender: normalizeGender(row['Patient Gender']),
      phone: normalizePhone(row['Patient Mobile']),
      age: clean(row['Patient Age']),
      visitDate: toIsoDate(row.date),
      measuredAt: combineDateAndTime(row.date, ''),
      importedFrom: [CSV_FILES.vitals],
      ...parsedVitals,
      rawVitals: [clean(row['Vital Name And Value'])]
    });
  }

  const historyDocs = [...history.entries()].map(([key, record]) => {
    const measuredAt = record.measuredAt || combineDateAndTime(record.visitDate, '');
    const docId = `csvImport_${hashId(key)}`;
    return [
      docId,
      {
        ...record,
        importKey: key,
        patientId: record.patientId,
        measuredAt,
        createdAtIso: measuredAt,
        createdAtDisplay: measuredAt ? new Date(measuredAt).toLocaleString('en-IN') : '',
        source: IMPORT_SOURCE,
        importBatchId
      }
    ];
  });

  historyInputRows += rows.symptoms.length + rows.diagnosis.length + rows.drugs.length
    - skipped.filter((entry) => [CSV_FILES.symptoms, CSV_FILES.diagnosis, CSV_FILES.drugs].includes(entry.file)).length;

  return { rows, sourceFiles, patients: [...patients.values()], historyDocs, catalog, skipped, historyInputRows };
}

function summarize({ rows, sourceFiles, patients, historyDocs, catalog, skipped, historyInputRows }) {
  const fileCounts = Object.entries(rows).map(([key, value]) => [CSV_FILES[key], value.length]);
  const fileSources = Object.entries(sourceFiles)
    .map(([key, value]) => [CSV_FILES[key], value.join(', ') || CSV_FILES[key]]);
  const duplicateGroups = Math.max(0, historyInputRows - historyDocs.length);

  console.log(`Kid EMR CSV import ${writeMode ? 'WRITE' : 'DRY RUN'}`);
  console.log(`CSV directory: ${csvDir}`);
  console.log(`Import batch: ${importBatchId}`);
  console.log('');
  console.log('CSV row counts:');
  for (const [fileName, count] of fileCounts) {
    const sourceLabel = fileSources.find(([name]) => name === fileName)?.[1] || fileName;
    console.log(`  ${fileName} (${sourceLabel}): ${count}`);
  }
  console.log('');
  console.log(`Patients to merge: ${patients.length}`);
  console.log(`History records to merge: ${historyDocs.length}`);
  console.log(`Visit rows grouped together: ${duplicateGroups}`);
  console.log(`Catalog additions prepared: Symptoms ${catalog.Symptoms.length}, Diagnosis ${catalog.Diagnosis.length}, Medication ${catalog.Medication.length}`);
  console.log(`Skipped rows: ${skipped.length}`);

  if (skipped.length) {
    console.log('');
    console.log('Skipped row summary:');
    const byFileAndReason = new Map();
    for (const entry of skipped) {
      const key = `${entry.file} - ${entry.reason}`;
      byFileAndReason.set(key, (byFileAndReason.get(key) || 0) + 1);
    }
    for (const [key, count] of byFileAndReason.entries()) {
      console.log(`  ${key}: ${count}`);
    }
  }

  console.log('');
  console.log(writeMode ? 'Writing to Firestore...' : 'No writes performed. Add --write to import into Firestore.');
}

async function initializeFirestore() {
  if (!args.serviceAccount && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const { initializeApp } = await import('firebase/app');
    const firestore = await import('firebase/firestore');
    const app = initializeApp(DEFAULT_FIREBASE_CONFIG, `kid-csv-import-${Date.now()}`);

    return {
      type: 'client',
      db: firestore.getFirestore(app),
      doc: firestore.doc,
      writeBatch: firestore.writeBatch,
      serverTimestamp: firestore.serverTimestamp,
      arrayUnion: firestore.arrayUnion
    };
  }

  const adminModule = await import('firebase-admin');
  const admin = adminModule.default || adminModule;
  const serviceAccountPath = args.serviceAccount ? path.resolve(args.serviceAccount) : '';
  const credential = serviceAccountPath
    ? admin.credential.cert(JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')))
    : admin.credential.applicationDefault();

  if (!admin.apps.length) {
    admin.initializeApp({ credential });
  }

  return {
    type: 'admin',
    db: admin.firestore(),
    FieldValue: admin.firestore.FieldValue
  };
}

async function commitInChunks(db, operations, size = 400) {
  for (let index = 0; index < operations.length; index += size) {
    const batch = db.batch();
    for (const operation of operations.slice(index, index + size)) {
      operation(batch);
    }
    await batch.commit();
    console.log(`  committed ${Math.min(index + size, operations.length)} / ${operations.length}`);
  }
}

async function commitClientInChunks(client, operations, size = 400) {
  for (let index = 0; index < operations.length; index += size) {
    const batch = client.writeBatch(client.db);
    for (const operation of operations.slice(index, index + size)) {
      operation(batch);
    }
    await batch.commit();
    console.log(`  committed ${Math.min(index + size, operations.length)} / ${operations.length}`);
  }
}

async function writeToFirestore(data) {
  const firestore = await initializeFirestore();
  const operations = [];

  if (firestore.type === 'client') {
    const now = firestore.serverTimestamp();

    for (const patient of data.patients) {
      const ref = firestore.doc(firestore.db, `${CLINIC_NAMESPACE}/patients/${patient.patientId}`);
      operations.push((batch) => batch.set(ref, {
        ...patient,
        updatedAt: now,
        importedAt: now
      }, { merge: true }));
    }

    for (const [docId, record] of data.historyDocs) {
      const ref = firestore.doc(firestore.db, `${CLINIC_NAMESPACE}/history/${docId}`);
      operations.push((batch) => batch.set(ref, {
        ...record,
        updatedAt: now,
        importedAt: now
      }, { merge: true }));
    }

    for (const [sectionName, items] of Object.entries(data.catalog)) {
      if (!items.length) {
        continue;
      }

      const ref = firestore.doc(firestore.db, `${CLINIC_NAMESPACE}/prescription/${sectionName}`);
      operations.push((batch) => batch.set(ref, {
        name: sectionName,
        items: firestore.arrayUnion(...items),
        updatedAt: now,
        importedAt: now
      }, { merge: true }));
    }

    await commitClientInChunks(firestore, operations);
    console.log('Firestore import complete.');
    return;
  }

  const { db, FieldValue } = firestore;
  const now = FieldValue.serverTimestamp();

  for (const patient of data.patients) {
    const ref = db.doc(`${CLINIC_NAMESPACE}/patients/${patient.patientId}`);
    operations.push((batch) => batch.set(ref, {
      ...patient,
      updatedAt: now,
      importedAt: now
    }, { merge: true }));
  }

  for (const [docId, record] of data.historyDocs) {
    const ref = db.doc(`${CLINIC_NAMESPACE}/history/${docId}`);
    operations.push((batch) => batch.set(ref, {
      ...record,
      updatedAt: now,
      importedAt: now
    }, { merge: true }));
  }

  for (const [sectionName, items] of Object.entries(data.catalog)) {
    if (!items.length) {
      continue;
    }

    const ref = db.doc(`${CLINIC_NAMESPACE}/prescription/${sectionName}`);
    operations.push((batch) => batch.set(ref, {
      name: sectionName,
      items: FieldValue.arrayUnion(...items),
      updatedAt: now,
      importedAt: now
    }, { merge: true }));
  }

  await commitInChunks(db, operations);
  console.log('Firestore import complete.');
}

try {
  const data = buildImportData();
  summarize(data);

  if (writeMode) {
    await writeToFirestore(data);
  }
} catch (error) {
  console.error(`Import failed: ${error.message}`);
  if (process.env.DEBUG_IMPORT_CSV) {
    console.error(error);
  }
  process.exitCode = 1;
}
