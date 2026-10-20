// Prints the CHANGELOG.md section of one version, for its GitHub Release:
// `node scripts/release-notes.mjs 1.0.0`. Fails when the changelog has no section for the
// version, so a release cannot go out without its notes, and when the version does not
// match package.json, so a tag cannot publish another version's code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) {
  console.error(`package.json is at ${pkg.version}, not ${version}`);
  process.exit(1);
}

const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n');
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no "## [${version}]" section`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
const end = rest.findIndex(
  (line) => line.startsWith('## [') || /^\[[^\]]+\]: /.test(line),
);
const notes = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
if (notes === '') {
  console.error(`the "## [${version}]" section of CHANGELOG.md is empty`);
  process.exit(1);
}
console.log(notes);
