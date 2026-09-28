#!/usr/bin/env node
/**
 * Publish a new version of this plugin from this checkout.
 *
 * Why this exists: `npm publish` on an account whose only second factor is a security
 * key cannot complete the OTP challenge from a terminal, so publishing needs a granular
 * access token with "bypass 2FA" enabled. That token is a secret, so this script reads
 * it from the `NPM_TOKEN` environment variable only — it never writes it to
 * `package.json`, `.npmrc`, or any file in this repository.
 *
 * It also never runs git. Bumping writes `package.json` only (`--no-git-tag-version`),
 * and the commit, tag and push are printed for you to run yourself.
 *
 * Usage:
 *   $env:NPM_TOKEN = 'npm_...'           # granular token, "bypass 2FA" enabled
 *   npm run release -- patch             # patch | minor | major | an exact x.y.z
 *   npm run release -- patch --dry-run   # rehearse: preflight only, change nothing
 *
 * Reminder: npm rejects an existing version, so every release needs a new one.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const bump = argv.find((arg) => arg.startsWith('--') === false);

if (bump === undefined) {
  console.error('usage: npm run release -- <patch|minor|major|x.y.z> [--dry-run]');
  process.exit(2);
}
if (/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump) === false) {
  console.error(`not a version bump: ${JSON.stringify(bump)}`);
  process.exit(2);
}

const token = process.env.NPM_TOKEN ?? '';
if (dryRun === false && token.startsWith('npm_') === false) {
  console.error('NPM_TOKEN is missing or is not an npm token.');
  console.error('Set it to a granular access token with "bypass 2FA" enabled, then retry.');
  console.error('The token stays in the environment: this script never writes it to disk.');
  process.exit(2);
}

/** Run one command in the checkout, with its output visible. */
function run(command, commandArgs, { shell = false } = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', shell });
  if (result.error) {
    console.error(`\ncould not run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n${command} ${commandArgs.join(' ')} exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

const before = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

console.log(`[1/3] preflight   ${before.name}@${before.version}`);
run(process.execPath, ['scripts/check-release.mjs']);

if (dryRun) {
  console.log(`\n[2/3] would bump ${bump} (package.json only, no git commit or tag)`);
  console.log('[3/3] would run  npm publish --access public --//registry.npmjs.org/:_authToken=<NPM_TOKEN>');
  console.log('\ndry run: nothing was changed');
  process.exit(0);
}

console.log(`\n[2/3] bumping ${bump} (package.json only, no git commit or tag)`);
run('npm', ['version', bump, '--no-git-tag-version'], { shell: true });

console.log('\n[3/3] publishing');
run('npm', ['publish', '--access', 'public', `--//registry.npmjs.org/:_authToken=${token}`], {
  shell: true,
});

const after = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
console.log(`\npublished ${after.name}@${after.version} (was ${before.version})`);

console.log(`
Now finish the release yourself — this script never runs git:

  git add -A
  git commit -m "release: v${after.version}"
  git tag v${after.version}
  git push --follow-tags

Then pick the new version up locally:

  Plugins page -> uninstall ${after.name} -> Add plugin -> ${after.name} -> Install -> restart DSH
`);
