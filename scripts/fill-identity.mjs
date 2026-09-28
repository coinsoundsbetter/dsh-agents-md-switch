#!/usr/bin/env node
/**
 * Fill in the publishing identity.
 *
 * The repository ships explicit placeholders instead of an author identity, so that
 * whoever publishes decides what the registry and the licence file record — a work or
 * company address never has to become public by accident.
 *
 * Usage:
 *   node scripts/fill-identity.mjs \
 *     --owner <github-owner> \
 *     --name "<author name>" \
 *     --email "<author email>" \
 *     [--copyright "<licence holder>"]
 *
 * `--owner` is the GitHub account that hosts the repository; it is also used for the
 * repository, homepage and issues URLs. `--copyright` defaults to `--name`.
 *
 * Replacing is idempotent: run it again with different values to change your mind.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files that may carry an identity placeholder.
 *
 * This list has to stay a superset of every repository-only file the preflight scans,
 * and it is re-verified at the end of this script rather than trusted.
 */
const TARGETS = [
  'package.json',
  'LICENSE',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  '.github/workflows/publish.yml',
];

/** Parse `--key value` pairs. */
function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--') === false) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    parsed[token.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const owner = args.owner;
const authorName = args.name;
const authorEmail = args.email;
const copyrighter = args.copyright ?? authorName;

if (owner === undefined || authorName === undefined || authorEmail === undefined) {
  console.error('usage: node scripts/fill-identity.mjs --owner <github-owner> --name "<author name>" --email "<email>" [--copyright "<holder>"]');
  process.exit(2);
}
if (/^@/.test(owner) || /\s/.test(owner)) {
  console.error(`--owner must be a bare GitHub account name, got ${JSON.stringify(owner)}`);
  process.exit(2);
}

const replacements = new Map([
  ['__GITHUB_OWNER__', owner],
  ['__AUTHOR_NAME__', authorName],
  ['__AUTHOR_EMAIL__', authorEmail],
  ['__COPYRIGHT_HOLDER__', copyrighter],
]);

/** Apply every replacement, reporting how many substitutions each file took. */
function substitute(text) {
  let result = text;
  let count = 0;
  for (const [token, value] of replacements) {
    const parts = result.split(token);
    count += parts.length - 1;
    result = parts.join(value);
  }
  return { result, count };
}

let touched = 0;
for (const relative of TARGETS) {
  const absolute = join(root, relative);
  let original;
  try {
    original = await readFile(absolute, 'utf8');
  } catch {
    continue;
  }
  const { result, count } = substitute(original);
  if (result === original) continue;
  await writeFile(absolute, result, 'utf8');
  touched += 1;
  console.log(`updated ${relative} (${count} substitution(s))`);
}

if (touched === 0) {
  console.log('nothing to do: no placeholder left in the identity files');
} else {
  console.log(`\nidentity written: owner=${owner} author=${authorName} <${authorEmail}> copyright=${copyrighter}`);
}

// Prove the job is complete over the same set the preflight scans. The two lists once
// drifted — `CHANGELOG.md` was scanned but not substituted — and that blocked a release
// with a placeholder nothing was able to replace.
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const scanned = [...new Set([...(manifest.files ?? []), ...TARGETS, 'package.json'])].filter(
  (entry) => entry.includes('*') === false,
);
const leftovers = [];
for (const relative of scanned) {
  let text;
  try {
    text = await readFile(join(root, relative), 'utf8');
  } catch {
    continue;
  }
  const found = [...new Set(text.match(/__[A-Z][A-Z0-9_]*__/g) ?? [])];
  if (found.length > 0) leftovers.push(`${relative}: ${found.join(', ')}`);
}
if (leftovers.length > 0) {
  console.error('\nstill unresolved — add the file to TARGETS in this script, then run it again:');
  for (const line of leftovers) console.error(`  ${line}`);
  process.exitCode = 1;
} else {
  console.log('all identity placeholders are replaced');
  console.log('next: npm run check   then   git commit');
}
