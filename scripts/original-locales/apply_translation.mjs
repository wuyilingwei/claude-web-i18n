import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  compareMessageStructure,
  ensureDir,
  hasKana,
  hasObviousUntranslatedEnglish,
  readJson,
  readJsonl,
  writeJson,
} from '../../.translation/scripts/shared.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_PENDING_DIR = path.join(ROOT_DIR, '.pending', 'original-locale-update');

function usage() {
  throw new Error('Usage: node apply_translation.mjs --locale <locale> [--pending-dir <path>]');
}

function parseArgs(argv) {
  const args = {
    locale: null,
    pendingDir: DEFAULT_PENDING_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--locale' && next) {
      args.locale = next;
      index += 1;
    } else if (token === '--pending-dir' && next) {
      args.pendingDir = path.resolve(next);
      index += 1;
    } else {
      usage();
    }
  }

  if (!args.locale) usage();
  return args;
}

function validateChunk(inputRows, outputRows, label) {
  if (inputRows.length !== outputRows.length) {
    throw new Error(`${label}: row count mismatch (${outputRows.length} vs ${inputRows.length})`);
  }

  for (let index = 0; index < inputRows.length; index += 1) {
    const inputRow = inputRows[index];
    const outputRow = outputRows[index];
    const rowLabel = `${label}#${index + 1} (${inputRow.key})`;

    if (inputRow.file !== outputRow.file || inputRow.index !== outputRow.index || inputRow.key !== outputRow.key) {
      throw new Error(`${rowLabel}: file/index/key mismatch`);
    }
    if (typeof outputRow.zh !== 'string' || outputRow.zh.trim() === '') {
      throw new Error(`${rowLabel}: zh is empty or not a string`);
    }
    if (outputRow.zh.includes('�')) {
      throw new Error(`${rowLabel}: contains replacement character`);
    }
    if (/TODO/i.test(outputRow.zh)) {
      throw new Error(`${rowLabel}: contains TODO`);
    }
    if (hasKana(outputRow.zh)) {
      throw new Error(`${rowLabel}: contains Japanese kana`);
    }
    if (hasObviousUntranslatedEnglish(outputRow.zh)) {
      throw new Error(`${rowLabel}: looks like untranslated English`);
    }

    compareMessageStructure(inputRow.en, outputRow.zh, rowLabel);
  }
}

function loadWorkManifest(pendingDir, locale) {
  const manifestPath = path.join(pendingDir, 'translation', locale, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing translation manifest: ${manifestPath}`);
  }
  return readJson(manifestPath);
}

function collectTranslations(chunkInfos, fileLabel) {
  const translations = new Map();

  for (const chunkInfo of chunkInfos) {
    const inputRows = readJsonl(chunkInfo.inputPath);
    if (!fs.existsSync(chunkInfo.outputPath)) {
      throw new Error(`Missing translated chunk: ${chunkInfo.outputPath}`);
    }
    const outputRows = readJsonl(chunkInfo.outputPath);
    validateChunk(inputRows, outputRows, path.basename(chunkInfo.outputPath));

    for (const row of outputRows) {
      if (translations.has(row.key)) {
        throw new Error(`${fileLabel}: duplicate translated key ${row.key}`);
      }
      translations.set(row.key, row.zh);
    }
  }

  return translations;
}

function rebuildLocaleFile(fileLabel, baseData, currentTargetData, diffRows, translations) {
  const diffMap = new Map(diffRows.map((row) => [row.key, row]));
  const result = {};

  for (const [index, key] of Object.keys(baseData).entries()) {
    const diffRow = diffMap.get(key);
    if (diffRow) {
      if (diffRow.op === 'add' || diffRow.op === 'update') {
        if (diffRow.index !== index) {
          throw new Error(`${fileLabel}:${key}: diff index mismatch (${diffRow.index} vs ${index})`);
        }
        const translated = translations.get(key);
        if (typeof translated !== 'string' || translated.length === 0) {
          throw new Error(`${fileLabel}:${key}: missing translated value`);
        }
        result[key] = translated;
        continue;
      }
      if (diffRow.op !== 'remove') {
        throw new Error(`${fileLabel}:${key}: unsupported diff operation ${diffRow.op}`);
      }
    }

    if (!Object.prototype.hasOwnProperty.call(currentTargetData, key) || typeof currentTargetData[key] !== 'string') {
      throw new Error(`${fileLabel}:${key}: missing existing target value for unchanged key`);
    }
    result[key] = currentTargetData[key];
  }

  const expectedTranslationCount = diffRows.filter((row) => row.op === 'add' || row.op === 'update').length;
  if (translations.size !== expectedTranslationCount) {
    throw new Error(
      `${fileLabel}: translated key count mismatch (${translations.size} vs expected ${expectedTranslationCount})`
    );
  }

  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pendingManifest = readJson(path.join(args.pendingDir, 'manifest.json'));
  const workManifest = loadWorkManifest(args.pendingDir, args.locale);
  const mainDiffRows = readJsonl(path.join(args.pendingDir, 'main.diff.jsonl'));
  const statsigDiffRows = readJsonl(path.join(args.pendingDir, 'statsig.diff.jsonl'));

  const baseMainData = readJson(workManifest.source.main.en);
  const baseStatsigData = readJson(workManifest.source.statsig.en);
  const currentMainData = readJson(workManifest.output.main);
  const currentStatsigData = readJson(workManifest.output.statsig);

  const mainTranslations = collectTranslations(workManifest.chunks.main, 'main');
  const statsigTranslations = collectTranslations(workManifest.chunks.statsig, 'statsig');

  const nextMainData = rebuildLocaleFile('main', baseMainData, currentMainData, mainDiffRows, mainTranslations);
  const nextStatsigData = rebuildLocaleFile(
    'statsig',
    baseStatsigData,
    currentStatsigData,
    statsigDiffRows,
    statsigTranslations
  );

  ensureDir(path.dirname(workManifest.output.main));
  ensureDir(path.dirname(workManifest.output.statsig));
  writeJson(workManifest.output.main, nextMainData);
  writeJson(workManifest.output.statsig, nextStatsigData);

  fs.rmSync(args.pendingDir, { recursive: true, force: true });

  console.log(
    JSON.stringify(
      {
        locale: args.locale,
        baseLocale: pendingManifest.baseLocale,
        main: Object.keys(nextMainData).length,
        statsig: Object.keys(nextStatsigData).length,
        clearedPendingDir: args.pendingDir,
      },
      null,
      2
    )
  );
}

main();
