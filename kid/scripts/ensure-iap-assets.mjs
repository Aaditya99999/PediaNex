import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const kidDir = resolve(import.meta.dirname, '..');
const repoRoot = resolve(kidDir, '..', '..');
const generatorScript = resolve(repoRoot, 'scripts', 'generate_minimal_iap_pngs.py');
const whoGeneratorScript = resolve(repoRoot, 'scripts', 'generate_official_who_pngs.py');
const outputDir = resolve(kidDir, 'assets', 'iap-official-png');
const whoOutputDir = resolve(kidDir, 'assets', 'who-official-png');

const pythonCommands = [
  ['python', [generatorScript]],
  ['py', ['-3', generatorScript]]
];

function runGenerator() {
  for (const [command, args] of pythonCommands) {
    const result = spawnSync(command, args.map((arg) => arg === generatorScript ? generatorScript : arg), {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false
    });

    if (result.status === 0) {
      return true;
    }

    if (result.error && result.error.code === 'ENOENT') {
      continue;
    }
  }

  return false;
}

function runWhoGenerator() {
  for (const [command, args] of pythonCommands) {
    const result = spawnSync(command, args.map((arg) => arg === generatorScript ? whoGeneratorScript : arg), {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false
    });

    if (result.status === 0) {
      return true;
    }

    if (result.error && result.error.code === 'ENOENT') {
      continue;
    }
  }

  return false;
}

const generated = runGenerator();
const generatedWho = existsSync(whoOutputDir) || runWhoGenerator();

if (!generated && !existsSync(outputDir)) {
  console.error('Unable to run the Python IAP asset generator and no pre-generated assets were found.');
  process.exit(1);
}

if (!generatedWho && !existsSync(whoOutputDir)) {
  console.error('Unable to run the Python WHO chart asset generator and no pre-generated WHO assets were found.');
  process.exit(1);
}

if (!generated) {
  console.warn('Python was not available, so the app is using the existing generated IAP chart assets.');
} else {
  console.log('IAP chart assets refreshed from the Python generator.');
}
