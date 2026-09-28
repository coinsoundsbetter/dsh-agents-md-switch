#!/usr/bin/env node
/**
 * Release preflight — run automatically by `prepublishOnly`, and by CI before
 * publishing. It fails the release rather than letting a defect ship.
 *
 * Checks, in order:
 *   1. no identity placeholder survived (an unpublished placeholder would leak into
 *      the registry metadata and the licence file);
 *   2. every file this package promises to publish actually exists;
 *   3. the locale dictionaries cover the same keys, and every `t('key')` call site in
 *      the client half resolves in all of them — lookup falls back to printing the key
 *      itself, so a missing entry is a user-visible "title"-style string;
 *   4. development leftovers (`activation.log`) are not sitting in the tree.
 *
 * No dependencies on purpose: it must run in a bare checkout.
 */
import { readFile, access, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const failures = [];
const notes = [];

/** Read a repository-relative file as UTF-8. */
function read(relative) {
  return readFile(join(root, relative), 'utf8');
}

/** Record a hard failure. */
function fail(message) {
  failures.push(message);
}

/** Record a non-fatal observation. */
function warn(message) {
  notes.push(message);
}

const manifest = JSON.parse(await read('package.json'));
// The workflow is not shipped, but a stale placeholder there means the OIDC setup
// instructions point at the wrong repository, so it is scanned too.
const shipped = [...new Set([...(manifest.files ?? []), 'package.json', '.github/workflows/publish.yml'])];

// 1. Identity placeholders.
const PLACEHOLDER = /__[A-Z][A-Z0-9_]*__/g;
for (const relative of shipped) {
  let text;
  try {
    text = await read(relative);
  } catch {
    continue;
  }
  const found = [...new Set(text.match(PLACEHOLDER) ?? [])];
  if (found.length > 0) {
    fail(`${relative}: unresolved placeholder(s) ${found.join(', ')} — run \`npm run fill-identity\` first`);
  }
}

// 2. Declared files and entry points.
const required = new Set(
  [
    ...(manifest.files ?? []),
    ...Object.values(manifest.exports ?? {}),
    manifest.main,
    manifest.icon,
    manifest.dsh?.bundle?.patch,
  ]
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.replace(/^\.\//, '')),
);
for (const relative of required) {
  if (relative.includes('*') === false) {
    try {
      await access(join(root, relative));
    } catch {
      fail(`declared but missing: ${relative}`);
    }
    continue;
  }
  // A shipped `files` entry may be a glob (for example `locale/*.json`). Require at
  // least one real match: a package that ships no dictionary silently loses its
  // localized display metadata, and the icon or locale exports would point at nothing.
  const pattern = new RegExp(
    `^${basename(relative).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
  );
  let matches = [];
  try {
    matches = (await readdir(join(root, dirname(relative)))).filter((name) => pattern.test(name));
  } catch {
    // Reported as a mismatch below.
  }
  if (matches.length === 0) fail(`declared but nothing matches: ${relative}`);
}

// 3. Client-half dictionaries.
const client = await read('lib/client.js');
const dictsStart = client.indexOf('const DICTS = {');
const dictsEnd = client.indexOf('\n    };', dictsStart);
if (dictsStart === -1 || dictsEnd === -1) {
  warn('lib/client.js: could not locate the DICTS block; key coverage was not checked');
} else {
  const block = client.slice(dictsStart, dictsEnd);
  const dicts = {};
  const localeRe = /^ {6}([A-Za-z][A-Za-z0-9-]*): \{\n([\s\S]*?)^ {6}\},$/gm;
  for (const match of block.matchAll(localeRe)) {
    const keys = new Set([...match[2].matchAll(/^ {8}([A-Za-z][A-Za-z0-9_]*):/gm)].map((entry) => entry[1]));
    dicts[match[1]] = keys;
  }
  const locales = Object.keys(dicts);
  if (locales.length < 2) {
    warn(`lib/client.js: found ${locales.length} dictionary block(s); expected at least two`);
  }
  const [first, ...rest] = locales;
  for (const locale of rest) {
    const missing = [...dicts[first]].filter((key) => dicts[locale].has(key) === false);
    const extra = [...dicts[locale]].filter((key) => dicts[first].has(key) === false);
    if (missing.length > 0) fail(`lib/client.js: locale "${locale}" is missing keys ${missing.join(', ')}`);
    if (extra.length > 0) fail(`lib/client.js: locale "${locale}" has keys absent from "${first}": ${extra.join(', ')}`);
  }
  const used = new Set([...client.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1]));
  for (const locale of locales) {
    const uncovered = [...used].filter((key) => dicts[locale].has(key) === false);
    if (uncovered.length > 0) fail(`lib/client.js: t() keys not defined for "${locale}": ${uncovered.join(', ')}`);
  }
}

// 4. Development leftovers.
for (const leftover of ['activation.log', 'node_modules', 'dist', 'lib/client.js.map']) {
  try {
    await access(join(root, leftover));
    warn(`present in the tree: ${leftover} (excluded from the tarball, but keep it out of git)`);
  } catch {
    // Absent is the expected state.
  }
}

for (const note of notes) console.warn(`warn  ${note}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  console.error(`\n${failures.length} problem(s) — refusing to publish.`);
  process.exit(1);
}
console.log(`ok    ${manifest.name}@${manifest.version}: preflight passed`);
