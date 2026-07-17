import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import {
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  where
} from 'firebase/firestore';
import {
  getDownloadURL,
  getStorage,
  ref,
  uploadBytes
} from 'firebase/storage';
import { jsPDF } from 'jspdf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KID_ROOT = path.resolve(__dirname, '..');
const CLINIC_NAMESPACE = 'clinics/kid';
const CLINIC_STORAGE_PREFIX = 'clinics/kid';
const CHART_CONFIG_PATH = path.join(KID_ROOT, 'growth_chart_config.json');
const chartConfig = JSON.parse(fs.readFileSync(CHART_CONFIG_PATH, 'utf8'));
const sharedGrowthCharts = Array.isArray(chartConfig.charts) ? chartConfig.charts : [];
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAm-cUFMyTFSyw8KlFOCcBKQkTKApEr5oo',
  authDomain: 'clinci-dr-gunda.firebaseapp.com',
  projectId: 'clinci-dr-gunda',
  storageBucket: 'clinci-dr-gunda.firebasestorage.app',
  messagingSenderId: '1059959825609',
  appId: '1:1059959825609:web:8201599754706ac4661918',
  measurementId: 'G-4V5JMVW45E'
};
const DEFAULT_BRANDING = {
  clinicTitle: 'The Better Kid Clinic',
  clinicAddress: 'The Better Health Clinic - Paediatrician #118, 5th Cross, Omkar\nNagar Akere, Bannerghatta road 560076 Bengaluru Karnataka',
  doctorName: 'Dr. Gunda Srinivas',
  doctorDetails: 'MBBS, DCH, DNB - Paediatrics, PGDDN, FPEM\n71826',
  footerText: 'The Better Health Clinic - Paediatrician #118, 5th Cross, Omkar Nagar\nAkere,\nBannerghatta road 560076 Bengaluru Karnataka',
  prescriptionFooterAlignment: 'left',
  signatureDataUrl: ''
};

const args = parseArgs(process.argv.slice(2));
const writeMode = Boolean(args.write);
const limit = Number.parseInt(args.limit || '', 10) || 0;
const forceMode = Boolean(args.force);
const vitalsOnlyMode = Boolean(args.vitalsOnly);
const concurrency = Math.max(1, Math.min(Number.parseInt(args.concurrency || '', 10) || 8, 20));
const importBatchId = args.batchId || `kid-csv-prescription-pdf-${new Date().toISOString().slice(0, 10)}`;
const referencePdfPath = args.referencePdf ? path.resolve(args.referencePdf) : '';
const referencePdfName = referencePdfPath ? path.basename(referencePdfPath) : '';
const outputDir = args.outputDir ? path.resolve(args.outputDir) : '';

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--write') {
      parsed.write = true;
    } else if (arg.startsWith('--limit=')) {
      parsed.limit = arg.slice('--limit='.length);
    } else if (arg === '--limit') {
      parsed.limit = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--batch-id=')) {
      parsed.batchId = arg.slice('--batch-id='.length);
    } else if (arg === '--batch-id') {
      parsed.batchId = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--concurrency=')) {
      parsed.concurrency = arg.slice('--concurrency='.length);
    } else if (arg === '--concurrency') {
      parsed.concurrency = argv[index + 1];
      index += 1;
    } else if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--vitals-only') {
      parsed.vitalsOnly = true;
    } else if (arg.startsWith('--reference-pdf=')) {
      parsed.referencePdf = arg.slice('--reference-pdf='.length);
    } else if (arg === '--reference-pdf') {
      parsed.referencePdf = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--output-dir=')) {
      parsed.outputDir = arg.slice('--output-dir='.length);
    } else if (arg === '--output-dir') {
      parsed.outputDir = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`
Kid EMR CSV prescription PDF backfill

Usage:
  npm run backfill:csv-prescription-pdfs
  npm run backfill:csv-prescription-pdfs -- --write

Options:
  --write          Upload PDFs and write prescription-pdf history records.
  --limit <count>  Process only the first N eligible records.
  --concurrency N  Parallel uploads/writes. Defaults to 8.
  --force          Regenerate records even when a generated doc already exists.
  --batch-id <id>  Batch marker for the generated records.
  --vitals-only    Generate only CSV history records with imported vitals.
  --reference-pdf  Optional local PDF used as the visual/reference source marker.
  --output-dir     Optional local folder to write generated PDFs while running.
`);
}

if (args.help) {
  printHelp();
  process.exit(0);
}

function clean(value) {
  return String(value ?? '').trim();
}

function compactSpaces(value) {
  return clean(value).replace(/\s+/g, ' ');
}

function hashId(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 28);
}

function sanitizeFilePart(value) {
  return compactSpaces(value)
    .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'UNKNOWN';
}

function toDate(value) {
  if (!value) {
    return null;
  }

  if (typeof value?.toDate === 'function') {
    return value.toDate();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getIso(value) {
  const parsed = toDate(value);
  return parsed ? parsed.toISOString() : '';
}

function getIsoDate(value) {
  const iso = getIso(value);
  return iso ? iso.slice(0, 10) : '';
}

function getClinicDateKey(value) {
  const parsed = toDate(value);
  if (!parsed) {
    return clean(value).slice(0, 10);
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(parsed);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return [part('year'), part('month'), part('day')].filter(Boolean).join('-');
}

function formatDisplayDate(iso) {
  const parsed = toDate(iso);
  if (!parsed) {
    return clean(iso);
  }

  return parsed.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatPrescriptionDate(iso) {
  const parsed = toDate(iso);
  if (!parsed) {
    return clean(iso);
  }

  const datePart = parsed.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  const timePart = parsed.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).toLowerCase();

  return `${datePart}, ${timePart}`;
}

function listValues(value) {
  if (Array.isArray(value)) {
    return value.map(compactSpaces).filter(Boolean);
  }

  return clean(value)
    .split(',')
    .map(compactSpaces)
    .filter(Boolean);
}

function uniqueValues(values) {
  const seen = new Set();
  const result = [];
  values.flatMap(listValues).forEach((value) => {
    const normalized = compactSpaces(value);
    const key = normalized.toLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  });
  return result;
}

function mergeTextValues(values) {
  return uniqueValues(values).join(', ');
}

function numberValue(value) {
  const match = clean(value).match(/-?\d+(?:\.\d+)?/);
  const parsed = match ? Number.parseFloat(match[0]) : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isVitalInRange(key, value) {
  const parsed = numberValue(value);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  const ranges = {
    weight: [0.5, 250],
    height: [20, 250],
    head: [20, 80],
    spo2: [50, 100],
    pulse: [30, 250],
    systolic: [40, 220],
    diastolic: [20, 140],
    temp: [30, 45]
  };
  const [min, max] = ranges[key] || [-Infinity, Infinity];
  return parsed >= min && parsed <= max;
}

function extractRawVitalValue(rawVitals, labelPattern) {
  const rows = Array.isArray(rawVitals) ? rawVitals : [rawVitals];
  for (const row of rows) {
    const text = clean(row);
    if (!text) {
      continue;
    }

    const segments = text.split(',').map(compactSpaces);
    for (const segment of segments) {
      if (labelPattern.test(segment)) {
        const match = segment.match(/-\s*(-?\d+(?:\.\d+)?)/);
        const parsed = match ? Number.parseFloat(match[1]) : NaN;
        if (Number.isFinite(parsed)) {
          return String(parsed);
        }
      }
    }
  }
  return '';
}

function normalizeVitalsFromRaw(entry) {
  const rawVitals = Array.isArray(entry.rawVitals) ? entry.rawVitals : [];
  if (!rawVitals.length) {
    return entry;
  }

  const bodyWeight = extractRawVitalValue(rawVitals, /^Body weight\b/i);
  const bodyHeight = extractRawVitalValue(rawVitals, /^Body height\b/i);
  const ofc = extractRawVitalValue(rawVitals, /^(?:Occipital frontal circumference|ofc)\b/i);
  const next = { ...entry };

  if (bodyWeight) {
    next.weight = bodyWeight;
  }
  if (bodyHeight && (!clean(next.height) || !isVitalInRange('height', next.height))) {
    next.height = bodyHeight;
  }
  if (ofc && !clean(next.head)) {
    next.head = ofc;
  }

  ['weight', 'height', 'head', 'spo2', 'pulse', 'systolic', 'diastolic', 'temp'].forEach((key) => {
    if (clean(next[key]) && !isVitalInRange(key, next[key])) {
      next[key] = '';
    }
  });

  return next;
}

function calculateAgeYears(dobValue, atValue) {
  const dob = toDate(dobValue);
  const at = toDate(atValue) || new Date();
  if (!dob || !at || dob > at) {
    return NaN;
  }

  return (at - dob) / (365.25 * 24 * 60 * 60 * 1000);
}

function getChartPatientData(entry, visitIso) {
  const height = numberValue(entry.height);
  const weight = numberValue(entry.weight);
  const ageYears = calculateAgeYears(entry.dob || '', visitIso);

  return {
    ageYears,
    ageMonths: Number.isFinite(ageYears) ? ageYears * 12 : NaN,
    height,
    weight,
    head: numberValue(entry.head),
    bmi: Number.isFinite(weight) && Number.isFinite(height) && height > 0 ? weight / ((height / 100) ** 2) : NaN
  };
}

function normalizeGenderForChart(value) {
  const normalized = clean(value).toLowerCase();
  if (normalized.startsWith('m')) {
    return 'male';
  }
  if (normalized.startsWith('f')) {
    return 'female';
  }
  return '';
}

function getChartRequests(entry, visitIso) {
  const patientData = getChartPatientData(entry, visitIso);
  const sex = normalizeGenderForChart(entry.gender);
  const ageGroup = patientData.ageYears < 5 ? '0-5' : patientData.ageYears <= 18 ? '5-18' : '';

  if (!sex || !ageGroup || !Number.isFinite(patientData.ageYears)) {
    return [];
  }

  return [
    { metric: 'height', value: patientData.height, xValue: ageGroup === '0-5' ? patientData.ageMonths : patientData.ageYears },
    { metric: 'weight', value: patientData.weight, xValue: ageGroup === '0-5' ? patientData.ageMonths : patientData.ageYears },
    { metric: 'head', value: patientData.head, xValue: patientData.ageMonths },
    { metric: 'bmi', value: patientData.bmi, xValue: ageGroup === '0-5' ? patientData.ageMonths : patientData.ageYears }
  ]
    .filter((request) => Number.isFinite(request.value) && Number.isFinite(request.xValue))
    .filter((request) => !(ageGroup === '5-18' && request.metric === 'head'))
    .map((request) => {
      const chart = sharedGrowthCharts.find((item) => (
        item.sex === sex
        && item.ageGroup === ageGroup
        && item.metric === request.metric
      ));

      if (!chart?.backgroundImage) {
        return null;
      }

      return { ...request, chart };
    })
    .filter(Boolean)
    .slice(0, 4);
}

function hasClinicalContent(entry) {
  return [
    'symptoms',
    'diagnosis',
    'drugs',
    'rawSymptom',
    'rawDiagnosis',
    'rawDrug',
    'rawVitals',
    'appointmentType',
    'visitType',
    'appointmentStatus',
    'weight',
    'height',
    'head',
    'spo2',
    'pulse',
    'temp'
  ].some((key) => {
    const value = entry[key];
    return Array.isArray(value) ? value.length > 0 : Boolean(clean(value));
  });
}

function hasVitalsContent(entry) {
  return [
    'weight',
    'height',
    'head',
    'spo2',
    'pulse',
    'systolic',
    'diastolic',
    'temp',
    'rawVitals'
  ].some((key) => {
    const value = entry[key];
    return Array.isArray(value) ? value.some((item) => clean(item)) : Boolean(clean(value));
  });
}

function getNormalizedPatientId(value) {
  return clean(value).toUpperCase();
}

function isValidKidPatientId(value) {
  return /^TBK\d{4}$/.test(getNormalizedPatientId(value));
}

function hasPrescriptionMinimumValues(entry) {
  const hasPatientIdentity = isValidKidPatientId(entry.patientId)
    && Boolean(compactSpaces(entry.childName || entry.name));
  const hasVisitDate = Boolean(getIso(entry.createdAtIso || entry.measuredAt || entry.visitDate || entry.savedAt));
  const hasPrescriptionBody = vitalsOnlyMode ? hasVitalsContent(entry) : hasClinicalContent(entry);

  return hasPatientIdentity && hasVisitDate && hasPrescriptionBody;
}

function getEntryVisitDateKey(entry) {
  return getClinicDateKey(entry.createdAtIso || entry.measuredAt || entry.visitDate || entry.savedAt);
}

function getPatientDateKey(entry) {
  return `${clean(entry.patientId).toUpperCase()}|${getEntryVisitDateKey(entry)}`;
}

function buildVisitEntryIndex(entries) {
  const index = new Map();
  entries.forEach((entry) => {
    const key = getPatientDateKey(entry);
    if (!clean(entry.patientId) || !key.endsWith(getEntryVisitDateKey(entry)) || !getEntryVisitDateKey(entry)) {
      return;
    }

    const list = index.get(key) || [];
    list.push(entry);
    index.set(key, list);
  });

  index.forEach((list) => {
    list.sort((left, right) => getEntryTimestamp(left) - getEntryTimestamp(right));
  });
  return index;
}

function mergeVisitEntries(baseEntry, relatedEntries = []) {
  const entries = [baseEntry, ...relatedEntries.filter((entry) => entry.id !== baseEntry.id)];
  const merged = normalizeVitalsFromRaw({ ...baseEntry });
  const mergeArrayField = (field, rawField = '') => {
    merged[field] = uniqueValues(entries.map((entry) => entry[field] || (rawField ? entry[rawField] : '')));
  };
  const mergeRawField = (field) => {
    merged[field] = mergeTextValues(entries.map((entry) => entry[field]));
  };
  const firstValue = (...fields) => {
    for (const entry of entries) {
      for (const field of fields) {
        const value = entry[field];
        if (Array.isArray(value) ? value.some((item) => clean(item)) : clean(value)) {
          return value;
        }
      }
    }
    return '';
  };

  mergeArrayField('symptoms', 'rawSymptom');
  mergeArrayField('findings', 'rawFinding');
  mergeArrayField('notes', 'rawNotes');
  mergeArrayField('diagnosis', 'rawDiagnosis');
  mergeArrayField('investigation', 'rawInvestigation');
  mergeArrayField('pastMedicalHistory', 'rawPastMedicalHistory');
  mergeArrayField('drugs', 'rawDrug');
  mergeArrayField('instructions', 'rawInstruction');
  mergeRawField('rawSymptom');
  mergeRawField('rawFinding');
  mergeRawField('rawNotes');
  mergeRawField('rawDiagnosis');
  mergeRawField('rawInvestigation');
  mergeRawField('rawPastMedicalHistory');
  mergeRawField('rawDrug');
  mergeRawField('rawInstruction');

  merged.rawVitals = uniqueValues(entries.map((entry) => entry.rawVitals));
  Object.assign(merged, normalizeVitalsFromRaw(merged));
  merged.appointmentId = clean(firstValue('appointmentId')) || merged.appointmentId || '';
  merged.appointmentStatus = clean(firstValue('appointmentStatus')) || merged.appointmentStatus || '';
  merged.appointmentType = clean(firstValue('appointmentType')) || merged.appointmentType || '';
  merged.visitType = clean(firstValue('visitType')) || merged.visitType || '';
  merged.mergedCsvHistoryDocIds = entries.map((entry) => entry.id).filter(Boolean);
  merged.mergedCsvHistoryCount = merged.mergedCsvHistoryDocIds.length;
  return merged;
}

function makeGeneratedIds(entry) {
  const seed = entry.importKey || entry.id || `${entry.patientId}|${entry.createdAtIso || entry.visitDate || ''}`;
  const hash = hashId(seed);
  const patientId = sanitizeFilePart(getNormalizedPatientId(entry.patientId));
  const visitDate = getIsoDate(entry.createdAtIso || entry.measuredAt || entry.visitDate) || 'unknown-date';
  const docId = vitalsOnlyMode ? `csvVitalPrescription_${hash}` : `csvPrescription_${hash}`;
  const fileName = `${visitDate}-${docId}.pdf`;
  const storagePath = `${CLINIC_STORAGE_PREFIX}/prescriptions/${patientId}/${fileName}`;
  return { docId, fileName, storagePath };
}

function buildPatientPrescriptionLink(historyRecord, docId) {
  return {
    id: docId,
    prescriptionSaveId: historyRecord.prescriptionSaveId || historyRecord.storagePath || docId,
    patientId: historyRecord.patientId,
    fileName: historyRecord.fileName || '',
    storagePath: historyRecord.storagePath || '',
    downloadURL: historyRecord.downloadURL || '',
    source: historyRecord.source || 'prescription-pdf',
    type: historyRecord.type || 'prescription',
    generatedFrom: historyRecord.generatedFrom || '',
    generatedFor: historyRecord.generatedFor || '',
    createdAtIso: historyRecord.createdAtIso || '',
    createdAtDisplay: historyRecord.createdAtDisplay || ''
  };
}

function addWrappedText(pdf, text, x, y, options = {}) {
  const lineHeight = options.lineHeight || 5;
  const width = options.width || 176;
  const lines = pdf.splitTextToSize(clean(text) || '-', width);

  lines.forEach((line) => {
    if (y > 276) {
      pdf.addPage();
      y = 18;
    }
    pdf.text(line, x, y);
    y += lineHeight;
  });

  return y;
}

function formatCompactAge(value) {
  const raw = clean(value);
  if (!raw) {
    return '-';
  }

  return raw
    .replace(/\bYears?\b/gi, 'y')
    .replace(/\bMonths?\b/gi, 'm')
    .replace(/\bDays?\b/gi, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

function addInlineRow(pdf, label, value, x, y, width = 190) {
  const text = clean(value);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9.5);
  pdf.setTextColor(17, 24, 39);
  pdf.text(`${label}:`, x, y);

  if (!text) {
    return y + 5.4;
  }

  const labelWidth = pdf.getTextWidth(`${label}: `);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.8);
  const lines = pdf.splitTextToSize(text, Math.max(20, width - labelWidth));
  lines.forEach((line, index) => {
    pdf.text(line, index === 0 ? x + labelWidth : x, y + index * 4.4);
  });
  return y + Math.max(1, lines.length) * 4.4 + 1;
}

function addMultilineText(pdf, text, x, y, options = {}) {
  const lines = clean(text)
    .split(/\n+/)
    .map(compactSpaces)
    .filter(Boolean)
    .flatMap((line) => (options.width ? pdf.splitTextToSize(line, options.width) : [line]));
  const lineHeight = options.lineHeight || 4;
  lines.forEach((line, index) => {
    pdf.text(line, x, y + index * lineHeight, options.align ? { align: options.align } : undefined);
  });
  return y + lines.length * lineHeight;
}

function addPrescriptionHeader(pdf, branding = DEFAULT_BRANDING) {
  pdf.setTextColor(17, 24, 39);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(13);
  pdf.text(branding.clinicTitle || DEFAULT_BRANDING.clinicTitle, 6, 12);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.6);
  addMultilineText(pdf, branding.clinicAddress || DEFAULT_BRANDING.clinicAddress, 6, 18, { lineHeight: 4, width: 82 });

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8.8);
  pdf.text(branding.doctorName || DEFAULT_BRANDING.doctorName, 204, 12, { align: 'right' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.8);
  addMultilineText(pdf, branding.doctorDetails || DEFAULT_BRANDING.doctorDetails, 204, 17, { lineHeight: 4, width: 70, align: 'right' });

  pdf.setDrawColor(95, 104, 116);
  pdf.setLineWidth(0.25);
  pdf.line(6, 25, 204, 25);
}

function addPatientBand(pdf, entry, visitIso) {
  pdf.setDrawColor(222, 226, 232);
  pdf.setLineWidth(0.25);
  pdf.rect(6, 29, 198, 16);
  pdf.setFontSize(8.3);
  pdf.setTextColor(17, 24, 39);

  const leftX = 8;
  const midX = 83;
  const rightX = 146;
  const row1 = 34;
  const row2 = 38.5;
  const row3 = 43;

  const writePair = (label, value, x, y) => {
    pdf.setFont('helvetica', 'bold');
    pdf.text(`${label}:`, x, y);
    pdf.setFont('helvetica', 'normal');
    pdf.text(clean(value) || '-', x + pdf.getTextWidth(`${label}: `) + 0.8, y);
  };

  writePair('Name', entry.childName || '-', leftX, row1);
  writePair('Age/Sex', `${formatCompactAge(entry.age || entry.ageText || '-')} / ${entry.gender || '-'}`, leftX, row2);
  writePair('Office ID', entry.patientId || '-', leftX, row3);
  writePair('Date', formatPrescriptionDate(visitIso), midX, row1);
  writePair('Mobile', entry.phone || entry.mobileNumber || '-', midX, row2);
  writePair('Weight', clean(entry.weight) ? `${entry.weight} kg` : '-', rightX, row1);
  writePair('Height', clean(entry.height) ? `${entry.height} cm` : '-', rightX, row2);
}

function parseMedicationRows(entry) {
  return listValues(entry.drugs || entry.rawDrug)
    .map((item) => ({
      name: item,
      quantity: '-',
      frequency: '-',
      duration: '-',
      food: ''
    }))
    .slice(0, 8);
}

function addMedicationTable(pdf, rows, y) {
  if (!rows.length) {
    return y;
  }

  y = ensurePageSpace(pdf, y, 28 + rows.length * 9);
  const x = 6;
  const widths = [14, 66, 38, 44, 36];
  const xs = widths.reduce((acc, width) => {
    acc.push(acc[acc.length - 1] + width);
    return acc;
  }, [x]);
  const tableWidth = widths.reduce((sum, width) => sum + width, 0);
  const headerHeight = 7;
  const rowHeight = 9;

  pdf.setDrawColor(83, 94, 108);
  pdf.setLineWidth(0.45);
  pdf.setFillColor(232, 234, 238);
  pdf.rect(x, y, tableWidth, headerHeight, 'FD');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8.4);
  [' ', 'Medication', 'Quantity', 'Frequency', 'Duration'].forEach((header, index) => {
    pdf.text(header, xs[index] + widths[index] / 2, y + 4.7, { align: 'center' });
  });
  for (let index = 1; index < xs.length - 1; index += 1) {
    pdf.line(xs[index], y, xs[index], y + headerHeight + rows.length * rowHeight);
  }

  y += headerHeight;
  rows.forEach((row, index) => {
    pdf.rect(x, y, tableWidth, rowHeight);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.4);
    pdf.text(String(index + 1), xs[0] + widths[0] / 2, y + 5.7, { align: 'center' });
    pdf.setFont('helvetica', 'bold');
    pdf.text(pdf.splitTextToSize(row.name || '-', widths[1] - 4).slice(0, 1), xs[1] + 2, y + 4.2);
    if (row.food) {
      pdf.setFont('helvetica', 'italic');
      pdf.setFontSize(6.8);
      pdf.text(row.food, xs[1] + 2, y + 7.4);
    }
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8.2);
    pdf.text(row.quantity || '-', xs[2] + widths[2] / 2, y + 5.7, { align: 'center' });
    pdf.text(row.frequency || '-', xs[3] + widths[3] / 2, y + 5.7, { align: 'center' });
    pdf.text(row.duration || '-', xs[4] + widths[4] / 2, y + 5.7, { align: 'center' });
    y += rowHeight;
  });

  return y + 5;
}

function addPrescriptionFooter(pdf, branding = DEFAULT_BRANDING) {
  const footerY = 277;
  if (branding.signatureDataUrl) {
    try {
      pdf.addImage(branding.signatureDataUrl, 'PNG', 6, footerY - 19, 48, 16, undefined, 'FAST');
    } catch {
      // Ignore invalid signature data and keep the footer text.
    }
  }

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7.5);
  pdf.setTextColor(17, 24, 39);
  pdf.text(branding.doctorName || DEFAULT_BRANDING.doctorName, 6, footerY);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.2);
  addMultilineText(pdf, branding.doctorDetails || DEFAULT_BRANDING.doctorDetails, 6, footerY + 4, { lineHeight: 4, width: 70 });

  pdf.setFontSize(6.8);
  addMultilineText(pdf, branding.footerText || DEFAULT_BRANDING.footerText, 204, footerY + 1, { lineHeight: 4, width: 82, align: 'right' });
}

function addSection(pdf, title, values, y) {
  const items = Array.isArray(values) ? values.filter(Boolean) : [values].filter(Boolean);
  if (!items.length) {
    return y;
  }

  if (y > 266) {
    pdf.addPage();
    y = 18;
  }

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.text(title, 16, y);
  y += 6;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  for (const item of items) {
    y = addWrappedText(pdf, `- ${item}`, 19, y, { width: 172, lineHeight: 4.5 });
  }

  return y + 3;
}

function buildVitals(entry) {
  const rows = [
    ['Weight', entry.weight, 'kg'],
    ['Height', entry.height, 'cm'],
    ['OFC', entry.head, 'cm'],
    ['SpO2', entry.spo2, '%'],
    ['Pulse', entry.pulse, 'bpm'],
    ['Temperature', entry.temp, 'C']
  ]
    .filter(([, value]) => clean(value))
    .map(([label, value, unit]) => `${label}: ${value} ${unit}`);

  if (Array.isArray(entry.rawVitals)) {
    rows.push(...entry.rawVitals.map(compactSpaces).filter(Boolean));
  }

  return rows;
}

function ensurePageSpace(pdf, y, needed = 38) {
  if (y + needed <= 282) {
    return y;
  }

  pdf.addPage();
  return 18;
}

function getEntryTimestamp(entry) {
  return Date.parse(getIso(entry.createdAtIso || entry.measuredAt || entry.visitDate || entry.savedAt)) || 0;
}

function getMetricValue(entry, metric) {
  if (metric === 'bmi') {
    const weight = numberValue(entry.weight);
    const height = numberValue(entry.height);
    return Number.isFinite(weight) && Number.isFinite(height) && height > 0
      ? weight / ((height / 100) ** 2)
      : NaN;
  }
  return numberValue(metric === 'head' ? entry.head : entry[metric]);
}

function getChartPoint(request, entry) {
  const visitIso = getIso(entry.createdAtIso || entry.measuredAt || entry.visitDate);
  const patientData = getChartPatientData(entry, visitIso);
  const xValue = request.metric === 'head' || request.chart.ageGroup === '0-5'
    ? patientData.ageMonths
    : patientData.ageYears;
  const value = getMetricValue(entry, request.metric);

  if (!Number.isFinite(xValue) || !Number.isFinite(value)) {
    return null;
  }

  const plot = request.chart.plotArea || { left: 0.1731, top: 0.117, right: 0.8269, bottom: 0.8617 };
  const rawXRatio = (xValue - request.chart.xMin) / (request.chart.xMax - request.chart.xMin);
  const rawYRatio = (value - request.chart.yMin) / (request.chart.yMax - request.chart.yMin);
  const xRatio = Math.min(1, Math.max(0, rawXRatio));
  const yRatio = Math.min(1, Math.max(0, rawYRatio));

  return {
    xRatio,
    yRatio,
    plot
  };
}

function mapChartValueToPage(chart, x, y, width, height, xValue, yValue) {
  const plot = chart.plotArea || { left: 0.1731, top: 0.117, right: 0.8269, bottom: 0.8617 };
  const rawXRatio = (xValue - chart.xMin) / (chart.xMax - chart.xMin);
  const rawYRatio = (yValue - chart.yMin) / (chart.yMax - chart.yMin);
  const xRatio = Math.min(1, Math.max(0, rawXRatio));
  const yRatio = Math.min(1, Math.max(0, rawYRatio));

  return {
    x: x + (plot.left + xRatio * (plot.right - plot.left)) * width,
    y: y + 2 + (plot.bottom - yRatio * (plot.bottom - plot.top)) * height
  };
}

function getReferenceCurveAnchors(chart) {
  const sexOffset = chart.sex === 'female' ? -0.04 : 0;
  const metric = chart.metric;

  if (chart.ageGroup !== '0-5') {
    return null;
  }

  if (metric === 'height') {
    const shift = chart.sex === 'female' ? -1.2 : 0;
    return [
      { label: 'P3', start: 46 + shift, end: 100 + shift },
      { label: 'P15', start: 48 + shift, end: 104 + shift },
      { label: 'P50', start: 50 + shift, end: 110 + shift },
      { label: 'P85', start: 52 + shift, end: 116 + shift },
      { label: 'P97', start: 54 + shift, end: 120 + shift }
    ];
  }

  if (metric === 'weight') {
    const shift = chart.sex === 'female' ? -0.5 : 0;
    return [
      { label: 'P3', start: 2.5 + shift, end: 14 + shift },
      { label: 'P15', start: 2.9 + shift, end: 16 + shift },
      { label: 'P50', start: 3.4 + shift, end: 18 + shift },
      { label: 'P85', start: 4 + shift, end: 21 + shift },
      { label: 'P97', start: 4.6 + shift, end: 24 + shift }
    ];
  }

  if (metric === 'head') {
    const shift = chart.sex === 'female' ? -0.8 : 0;
    return [
      { label: 'P3', start: 32 + shift, end: 47 + shift },
      { label: 'P15', start: 33.5 + shift, end: 49 + shift },
      { label: 'P50', start: 35 + shift, end: 51 + shift },
      { label: 'P85', start: 36.5 + shift, end: 53 + shift },
      { label: 'P97', start: 38 + shift, end: 55 + shift }
    ];
  }

  if (metric === 'bmi') {
    return [
      { label: 'P3', start: 12 + sexOffset, peak: 13.4 + sexOffset, end: 12.4 + sexOffset },
      { label: 'P15', start: 12.8 + sexOffset, peak: 14.5 + sexOffset, end: 13.4 + sexOffset },
      { label: 'P50', start: 13.8 + sexOffset, peak: 16.2 + sexOffset, end: 15.2 + sexOffset },
      { label: 'P85', start: 15.3 + sexOffset, peak: 18.3 + sexOffset, end: 17.5 + sexOffset },
      { label: 'P97', start: 16.8 + sexOffset, peak: 20.4 + sexOffset, end: 19.5 + sexOffset }
    ];
  }

  return null;
}

function drawReferenceCurves(pdf, chart, x, y, width, height) {
  const anchors = getReferenceCurveAnchors(chart);
  if (!anchors) {
    return;
  }

  pdf.setDrawColor(152, 161, 171);
  pdf.setLineWidth(0.16);
  pdf.setTextColor(82, 90, 101);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(3.6);

  anchors.forEach((curve) => {
    const points = [];
    for (let step = 0; step <= 18; step += 1) {
      const ratio = step / 18;
      const xValue = chart.xMin + ratio * (chart.xMax - chart.xMin);
      let yValue;

      if (chart.metric === 'bmi') {
        const peakRatio = 0.18;
        if (ratio <= peakRatio) {
          const local = ratio / peakRatio;
          yValue = curve.start + (curve.peak - curve.start) * (1 - Math.cos(local * Math.PI)) / 2;
        } else {
          const local = (ratio - peakRatio) / (1 - peakRatio);
          yValue = curve.peak + (curve.end - curve.peak) * (1 - Math.cos(local * Math.PI)) / 2;
        }
      } else {
        const eased = (1 - Math.exp(-3.2 * ratio)) / (1 - Math.exp(-3.2));
        yValue = curve.start + (curve.end - curve.start) * eased;
      }

      points.push(mapChartValueToPage(chart, x, y, width, height, xValue, yValue));
    }

    for (let index = 1; index < points.length; index += 1) {
      pdf.line(points[index - 1].x, points[index - 1].y, points[index].x, points[index].y);
    }

    const labelPoint = points[points.length - 1];
    if (labelPoint) {
      pdf.text(curve.label, Math.min(x + width - 1, labelPoint.x + 1), labelPoint.y + 0.8);
    }
  });
}

function addChartCard(pdf, request, x, y, width, height, seriesEntries = []) {
  const imagePath = path.join(KID_ROOT, request.chart.backgroundImage);
  if (!fs.existsSync(imagePath)) {
    return false;
  }

  const imageData = `data:image/png;base64,${fs.readFileSync(imagePath).toString('base64')}`;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7.5);
  pdf.setTextColor(17, 24, 39);
  pdf.text(request.chart.label || `${request.metric} chart`, x, y);
  pdf.addImage(imageData, 'PNG', x, y + 2, width, height, undefined, 'FAST');
  drawReferenceCurves(pdf, request.chart, x, y, width, height);

  const points = seriesEntries
    .map((entry) => getChartPoint(request, entry))
    .filter(Boolean)
    .map((point) => ({
      x: x + (point.plot.left + point.xRatio * (point.plot.right - point.plot.left)) * width,
      y: y + 2 + (point.plot.bottom - point.yRatio * (point.plot.bottom - point.plot.top)) * height
    }));

  if (!points.length) {
    return true;
  }

  pdf.setDrawColor(17, 17, 17);
  pdf.setLineWidth(0.3);
  if (points.length > 1) {
    for (let index = 1; index < points.length; index += 1) {
      pdf.line(points[index - 1].x, points[index - 1].y, points[index].x, points[index].y);
    }
  }

  points.forEach((point) => {
    pdf.setFillColor(17, 17, 17);
    pdf.circle(point.x, point.y, 0.75, 'F');
    pdf.setDrawColor(255, 255, 255);
    pdf.circle(point.x, point.y, 1.05, 'S');
  });
  return true;
}

function addGrowthCharts(pdf, entry, visitIso, y, seriesEntries = []) {
  const requests = getChartRequests(entry, visitIso);
  if (!requests.length) {
    return y;
  }

  y = ensurePageSpace(pdf, y, 42);

  const cardWidth = 43;
  const cardHeight = 33;
  const gap = 7;
  let rendered = 0;

  requests.forEach((request, index) => {
    const col = index % 4;
    const row = Math.floor(index / 4);
    const cardX = 13 + col * (cardWidth + gap);
    const cardY = y + row * 40;
    if (addChartCard(pdf, request, cardX, cardY, cardWidth, cardHeight, seriesEntries)) {
      rendered += 1;
    }
  });

  return rendered ? y + Math.ceil(requests.length / 4) * 40 + 2 : y;
}

function renderPdf(entry, options = {}) {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const visitIso = getIso(entry.createdAtIso || entry.measuredAt || entry.visitDate);
  const branding = options.branding || DEFAULT_BRANDING;
  const seriesEntries = Array.isArray(options.seriesEntries) && options.seriesEntries.length
    ? options.seriesEntries
    : [entry];

  addPrescriptionHeader(pdf, branding);
  addPatientBand(pdf, entry, visitIso);

  let y = 51;
  y = addInlineRow(pdf, 'Symptoms', listValues(entry.symptoms || entry.rawSymptom).join(', '), 6, y, 198);
  y = addInlineRow(pdf, 'Finding', listValues(entry.findings || entry.rawFinding).join(', '), 6, y, 198);
  y = addInlineRow(pdf, 'Notes', listValues(entry.notes || entry.rawNotes).join(', '), 6, y, 198);
  y = addInlineRow(pdf, 'Diagnosis', listValues(entry.diagnosis || entry.rawDiagnosis).join(', '), 6, y, 198);
  y = addInlineRow(pdf, 'Investigation', listValues(entry.investigation || entry.rawInvestigation).join(', '), 6, y, 198);
  y = addInlineRow(pdf, 'Past Medical History', listValues(entry.pastMedicalHistory || entry.rawPastMedicalHistory).join(', '), 6, y, 198);
  y = addMedicationTable(pdf, parseMedicationRows(entry), y + 2);
  y = addInlineRow(pdf, 'Instruction', listValues(entry.instruction || entry.instructions || entry.rawInstruction).join(' | '), 6, y, 198);
  y = addGrowthCharts(pdf, entry, visitIso, y, seriesEntries);

  addPrescriptionFooter(pdf, branding);

  return Buffer.from(pdf.output('arraybuffer'));
}

async function main() {
  const app = initializeApp(DEFAULT_FIREBASE_CONFIG, `kid-csv-prescription-backfill-${Date.now()}`);
  const db = getFirestore(app);
  const storage = getStorage(app);

  const historyRef = collection(db, `${CLINIC_NAMESPACE}/history`);
  const patientsRef = collection(db, `${CLINIC_NAMESPACE}/patients`);
  const historyQuery = query(historyRef, where('source', '==', 'csv-import'));
  const generatedFromMarker = vitalsOnlyMode ? 'csv-import-vitals-history' : 'csv-import-history';
  const storageSourceMarker = vitalsOnlyMode ? 'csv-import-vitals-prescription-pdf' : 'csv-import-prescription-pdf';
  const existingQuery = query(historyRef, where('generatedFrom', '==', generatedFromMarker));
  const brandingRef = doc(db, CLINIC_NAMESPACE, 'clinicSettings', 'prescriptionBranding');
  const [snapshot, existingSnapshot, patientsSnapshot, brandingSnapshot] = await Promise.all([
    getDocs(historyQuery),
    getDocs(existingQuery),
    getDocs(patientsRef),
    getDoc(brandingRef)
  ]);
  const branding = {
    ...DEFAULT_BRANDING,
    ...(brandingSnapshot.exists() ? brandingSnapshot.data() : {})
  };

  const existingGeneratedDocIds = new Set(existingSnapshot.docs.map((docSnapshot) => docSnapshot.id));
  const patientsById = new Map(patientsSnapshot.docs.map((docSnapshot) => {
    const data = docSnapshot.data();
    return [clean(data.patientId || docSnapshot.id).toUpperCase(), data];
  }));
  const sourceEntries = snapshot.docs
    .map((docSnapshot) => {
      const entry = { id: docSnapshot.id, ...docSnapshot.data() };
      const patient = patientsById.get(clean(entry.patientId).toUpperCase()) || {};
      return {
        ...patient,
        ...entry,
        dob: entry.dob || patient.dob || '',
        ageText: entry.ageText || patient.ageText || '',
        mobileNumber: entry.mobileNumber || patient.mobileNumber || ''
      };
    })
    .sort((left, right) => {
      const leftTime = Date.parse(getIso(left.createdAtIso || left.measuredAt || left.visitDate)) || 0;
      const rightTime = Date.parse(getIso(right.createdAtIso || right.measuredAt || right.visitDate)) || 0;
      return leftTime - rightTime || clean(left.patientId).localeCompare(clean(right.patientId));
    });
  const entriesByPatientDate = buildVisitEntryIndex(sourceEntries);
  const candidates = sourceEntries
    .filter(hasPrescriptionMinimumValues)
    .sort((left, right) => {
      const leftTime = Date.parse(getIso(left.createdAtIso || left.measuredAt || left.visitDate)) || 0;
      const rightTime = Date.parse(getIso(right.createdAtIso || right.measuredAt || right.visitDate)) || 0;
      return leftTime - rightTime || clean(left.patientId).localeCompare(clean(right.patientId));
    });
  const vitalsByPatient = new Map();
  candidates.forEach((entry) => {
    if (!hasVitalsContent(entry)) {
      return;
    }

    const patientId = clean(entry.patientId).toUpperCase();
    const entries = vitalsByPatient.get(patientId) || [];
    entries.push(entry);
    vitalsByPatient.set(patientId, entries);
  });
  vitalsByPatient.forEach((entries) => {
    entries.sort((left, right) => getEntryTimestamp(left) - getEntryTimestamp(right));
  });

  const pending = forceMode
    ? candidates
    : candidates.filter((entry) => !existingGeneratedDocIds.has(makeGeneratedIds(entry).docId));
  const selected = limit > 0 ? pending.slice(0, limit) : pending;

  console.log(`Kid CSV prescription PDF backfill ${writeMode ? 'WRITE' : 'DRY RUN'}`);
  console.log(`CSV history records found: ${snapshot.size}`);
  console.log(`Eligible prescription PDFs: ${candidates.length}`);
  console.log(`Already generated: ${existingGeneratedDocIds.size}`);
  console.log(`Pending after resume check: ${pending.length}`);
  console.log(`Selected this run: ${selected.length}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Import batch: ${importBatchId}`);
  console.log(`Mode: ${vitalsOnlyMode ? 'vitals only' : 'all clinical CSV history'}`);
  console.log('Renderer: normal-preview-layout-v2');
  if (referencePdfName) {
    console.log(`Reference PDF: ${referencePdfName}`);
  }
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`Output directory: ${outputDir}`);
  }

  if (!writeMode) {
    console.log('No writes performed. Add --write to upload PDFs and create prescription history records.');
    return;
  }

  let completed = 0;
  async function processEntry(entry) {
    const { docId, fileName, storagePath } = makeGeneratedIds(entry);
    const visitIso = getIso(entry.createdAtIso || entry.measuredAt || entry.visitDate) || new Date().toISOString();
    const mergedEntry = mergeVisitEntries(entry, entriesByPatientDate.get(getPatientDateKey(entry)) || []);
    const patientVitals = vitalsByPatient.get(clean(entry.patientId).toUpperCase()) || [entry];
    const visitTime = getEntryTimestamp(entry) || Date.parse(visitIso) || Date.now();
    const seriesEntries = patientVitals
      .filter((candidate) => (getEntryTimestamp(candidate) || 0) <= visitTime)
      .slice(-30);
    const pdfBuffer = renderPdf(mergedEntry, { seriesEntries, referencePdfName, branding });
    const storageRef = ref(storage, storagePath);
    if (outputDir) {
      fs.writeFileSync(path.join(outputDir, fileName), pdfBuffer);
    }

    await uploadBytes(storageRef, pdfBuffer, {
      contentType: 'application/pdf',
      contentDisposition: 'inline',
      customMetadata: {
      source: storageSourceMarker,
      csvHistoryDocId: entry.id,
      mergedCsvHistoryDocIds: (mergedEntry.mergedCsvHistoryDocIds || []).join(','),
      visitDate: visitIso.slice(0, 10),
      referencePdfName: referencePdfName || ''
      }
    });

    const downloadURL = await getDownloadURL(storageRef);
    const patientId = getNormalizedPatientId(mergedEntry.patientId);
    const historyRecord = {
      prescriptionSaveId: storagePath,
      patientId,
      childName: mergedEntry.childName || '',
      parentName: mergedEntry.parentName || '',
      phone: mergedEntry.phone || '',
      gender: mergedEntry.gender || '',
      dob: mergedEntry.dob || '',
      age: mergedEntry.age || mergedEntry.ageText || '',
      weight: mergedEntry.weight || '',
      height: mergedEntry.height || '',
      head: mergedEntry.head || '',
      spo2: mergedEntry.spo2 || '',
      pulse: mergedEntry.pulse || '',
      systolic: mergedEntry.systolic || '',
      diastolic: mergedEntry.diastolic || '',
      temp: mergedEntry.temp || '',
      fileName,
      storagePath,
      downloadURL,
      source: 'prescription-pdf',
      type: 'prescription',
      generatedFrom: generatedFromMarker,
      csvHistoryDocId: entry.id,
      mergedCsvHistoryDocIds: mergedEntry.mergedCsvHistoryDocIds || [entry.id],
      mergedCsvHistoryCount: mergedEntry.mergedCsvHistoryCount || 1,
      csvHistoryImportKey: entry.importKey || '',
      originalImportBatchId: entry.importBatchId || '',
      importBatchId,
      generatedFor: vitalsOnlyMode ? 'csv-vitals' : 'csv-history',
      referencePdfName: referencePdfName || '',
      plottedVitalsCount: seriesEntries.length,
      symptoms: Array.isArray(mergedEntry.symptoms) ? mergedEntry.symptoms : [],
      findings: Array.isArray(mergedEntry.findings) ? mergedEntry.findings : [],
      notes: Array.isArray(mergedEntry.notes) ? mergedEntry.notes : [],
      diagnosis: Array.isArray(mergedEntry.diagnosis) ? mergedEntry.diagnosis : [],
      investigation: Array.isArray(mergedEntry.investigation) ? mergedEntry.investigation : [],
      pastMedicalHistory: Array.isArray(mergedEntry.pastMedicalHistory) ? mergedEntry.pastMedicalHistory : [],
      drugs: Array.isArray(mergedEntry.drugs) ? mergedEntry.drugs : [],
      instructions: Array.isArray(mergedEntry.instructions) ? mergedEntry.instructions : [],
      rawSymptom: mergedEntry.rawSymptom || '',
      rawFinding: mergedEntry.rawFinding || '',
      rawNotes: mergedEntry.rawNotes || '',
      rawDiagnosis: mergedEntry.rawDiagnosis || '',
      rawInvestigation: mergedEntry.rawInvestigation || '',
      rawPastMedicalHistory: mergedEntry.rawPastMedicalHistory || '',
      rawDrug: mergedEntry.rawDrug || '',
      rawInstruction: mergedEntry.rawInstruction || '',
      rawVitals: Array.isArray(mergedEntry.rawVitals) ? mergedEntry.rawVitals : [],
      appointmentId: mergedEntry.appointmentId || '',
      appointmentStatus: mergedEntry.appointmentStatus || '',
      appointmentType: mergedEntry.appointmentType || '',
      visitType: mergedEntry.visitType || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdAtIso: visitIso,
      createdAtDisplay: formatDisplayDate(visitIso)
    };

    await setDoc(doc(db, `${CLINIC_NAMESPACE}/history`, docId), historyRecord, { merge: true });
    await setDoc(doc(db, `${CLINIC_NAMESPACE}/patients`, patientId), {
      patientId,
      childName: historyRecord.childName,
      prescriptionHistory: arrayUnion(buildPatientPrescriptionLink(historyRecord, docId)),
      updatedAt: serverTimestamp()
    }, { merge: true });
    completed += 1;

    if (completed % 25 === 0 || completed === selected.length) {
      console.log(`  completed ${completed} / ${selected.length}`);
    }
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (cursor < selected.length) {
      const currentIndex = cursor;
      cursor += 1;
      await processEntry(selected[currentIndex]);
    }
  });

  await Promise.all(workers);
  console.log('CSV prescription PDF backfill complete.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
