import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureDir, readJson, writeJson, writeJsonl } from '../../.translation/scripts/shared.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = path.join(ROOT_DIR, '.original', 'upstream-locales.json');
const DEFAULT_BEFORE_DIR = path.join(ROOT_DIR, '.original');
const DEFAULT_AFTER_DIR = path.join(ROOT_DIR, '.original');
const DEFAULT_PENDING_DIR = path.join(ROOT_DIR, '.pending', 'original-locale-update');

function usage() {
  throw new Error(
    'Usage: node build_diff.mjs --metadata <path> [--config <path>] [--before-dir <path>] [--after-dir <path>] [--pending-dir <path>]'
  );
}

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG_PATH,
    beforeDir: DEFAULT_BEFORE_DIR,
    afterDir: DEFAULT_AFTER_DIR,
    pendingDir: DEFAULT_PENDING_DIR,
    metadata: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--config' && next) {
      args.config = path.resolve(next);
      index += 1;
    } else if (token === '--before-dir' && next) {
      args.beforeDir = path.resolve(next);
      index += 1;
    } else if (token === '--after-dir' && next) {
      args.afterDir = path.resolve(next);
      index += 1;
    } else if (token === '--pending-dir' && next) {
      args.pendingDir = path.resolve(next);
      index += 1;
    } else if (token === '--metadata' && next) {
      args.metadata = path.resolve(next);
      index += 1;
    } else {
      usage();
    }
  }

  if (!args.metadata) usage();
  return args;
}

function readLocaleList(configPath) {
  const config = readJson(configPath);
  if (!Array.isArray(config.locales) || config.locales.length === 0) {
    throw new Error(`${configPath}: locales must be a non-empty array`);
  }
  for (const locale of config.locales) {
    if (typeof locale !== 'string' || locale.length === 0) {
      throw new Error(`${configPath}: locales entries must be non-empty strings`);
    }
  }
  return config.locales;
}

function readMetadata(metadataPath) {
  const metadata = readJson(metadataPath);
  return {
    successfulLocales: Array.isArray(metadata.successfulLocales) ? metadata.successfulLocales : [],
    failedLocales: Array.isArray(metadata.failedLocales) ? metadata.failedLocales : [],
    warnings: Array.isArray(metadata.warnings) ? metadata.warnings : [],
    changedFiles: Array.isArray(metadata.changedFiles) ? metadata.changedFiles : [],
  };
}

function localeFilePath(dirPath, locale, kind) {
  const suffix = kind === 'statsig' ? '.statsig.json' : '.json';
  return path.join(dirPath, `${locale}${suffix}`);
}

function readLocaleObject(filePath, label) {
  const data = readJson(filePath);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${label}: expected a flat JSON object`);
  }
  return data;
}

function maybeReadLocaleObject(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return readLocaleObject(filePath, filePath);
}

function maybeReferenceValue(data, key) {
  const value = data[key];
  return typeof value === "string" ? value : null;
}

function buildDiffRows(fileLabel, beforeData, afterData, referenceData) {
  const beforeKeys = Object.keys(beforeData);
  const afterKeys = Object.keys(afterData);
  const afterKeySet = new Set(afterKeys);
  const beforeKeySet = new Set(beforeKeys);
  const rows = [];
  const summary = { add: 0, update: 0, remove: 0, total: 0 };

  for (const key of beforeKeys) {
    if (!afterKeySet.has(key)) {
      rows.push({
        file: fileLabel,
        op: 'remove',
        index: null,
        key,
        beforeEn: beforeData[key],
        afterEn: null,
        afterJa: null,
      });
      summary.remove += 1;
      summary.total += 1;
    }
  }

  afterKeys.forEach((key, index) => {
    const afterEn = afterData[key];
    if (typeof afterEn !== 'string') {
      throw new Error(`${fileLabel}: source en value for ${key} is not a string`);
    }

    if (!beforeKeySet.has(key)) {
      rows.push({
        file: fileLabel,
        op: 'add',
        index,
        key,
        beforeEn: null,
        afterEn,
        afterJa: maybeReferenceValue(referenceData, key),
      });
      summary.add += 1;
      summary.total += 1;
      return;
    }

    if (beforeData[key] !== afterEn) {
      rows.push({
        file: fileLabel,
        op: 'update',
        index,
        key,
        beforeEn: beforeData[key],
        afterEn,
        afterJa: maybeReferenceValue(referenceData, key),
      });
      summary.update += 1;
      summary.total += 1;
    }
  });

  return { rows, summary };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const locales = readLocaleList(args.config);
  const baseLocale = locales[0];
  const referenceLocale = locales.length > 1 ? locales[1] : null;
  const metadata = readMetadata(args.metadata);

  const beforeMain = maybeReadLocaleObject(localeFilePath(args.beforeDir, baseLocale, 'main'));
  const afterMain = readLocaleObject(localeFilePath(args.afterDir, baseLocale, 'main'), `${baseLocale}:main`);
  const beforeStatsig = maybeReadLocaleObject(localeFilePath(args.beforeDir, baseLocale, 'statsig'));
  const afterStatsig = readLocaleObject(localeFilePath(args.afterDir, baseLocale, 'statsig'), `${baseLocale}:statsig`);

  const afterReferenceMain = referenceLocale
    ? maybeReadLocaleObject(localeFilePath(args.afterDir, referenceLocale, 'main'))
    : {};
  const afterReferenceStatsig = referenceLocale
    ? maybeReadLocaleObject(localeFilePath(args.afterDir, referenceLocale, 'statsig'))
    : {};

  const mainDiff = buildDiffRows('main', beforeMain, afterMain, afterReferenceMain);
  const statsigDiff = buildDiffRows('statsig', beforeStatsig, afterStatsig, afterReferenceStatsig);
  const needsTranslation =
    mainDiff.summary.add + mainDiff.summary.update + statsigDiff.summary.add + statsigDiff.summary.update > 0;

  fs.rmSync(args.pendingDir, { recursive: true, force: true });
  ensureDir(args.pendingDir);

  const mainDiffPath = path.join(args.pendingDir, 'main.diff.jsonl');
  const statsigDiffPath = path.join(args.pendingDir, 'statsig.diff.jsonl');
  writeJsonl(mainDiffPath, mainDiff.rows);
  writeJsonl(statsigDiffPath, statsigDiff.rows);

  const manifestPath = path.join(args.pendingDir, 'manifest.json');
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    baseLocale,
    referenceLocale,
    cachedLocales: locales,
    successfulLocales: metadata.successfulLocales,
    failedLocales: metadata.failedLocales,
    warnings: metadata.warnings,
    changedFiles: metadata.changedFiles,
    needsTranslation,
    source: {
      main: {
        en: path.join(ROOT_DIR, '.original', `${baseLocale}.json`),
        ja: referenceLocale ? path.join(ROOT_DIR, '.original', `${referenceLocale}.json`) : null,
      },
      statsig: {
        en: path.join(ROOT_DIR, '.original', `${baseLocale}.statsig.json`),
        ja: referenceLocale ? path.join(ROOT_DIR, '.original', `${referenceLocale}.statsig.json`) : null,
      },
    },
    pendingFiles: {
      manifest: manifestPath,
      mainDiff: mainDiffPath,
      statsigDiff: statsigDiffPath,
    },
    diffSummary: {
      main: mainDiff.summary,
      statsig: statsigDiff.summary,
    },
  };

  writeJson(manifestPath, manifest);

  const summary = {
    baseLocale,
    referenceLocale,
    pendingDir: args.pendingDir,
    pendingCreated: true,
    needsTranslation,
    diffSummary: manifest.diffSummary,
    pendingFiles: manifest.pendingFiles,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main();
