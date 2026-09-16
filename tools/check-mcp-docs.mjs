// docs/mcp.md still describes the tools this build actually registers.
//
//   node tools/check-mcp-docs.mjs
//
// WHY THIS EXISTS. The Tools table and the group list in that document are
// hand-maintained, and they drifted badly: three whole groups - trees, particle
// effects and buildings - were never added, and the headline count said 67 where
// the server registered 91. Nobody noticed because nothing reads the document
// except a human deciding which groups to load, and a missing row looks exactly
// like a group that does not exist.
//
// It checks NAMES AND COUNTS ONLY, deliberately. The token estimates beside each
// selector are derived from the per-group `cost` figures and are approximations
// by nature; asserting them would fail on every wording change to a description
// and teach everyone to ignore this check.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = fs.readFileSync(path.join(root, 'docs', 'mcp.md'), 'utf8');
const index = fs.readFileSync(path.join(root, 'mcp', 'index.js'), 'utf8');

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) {
    failed++;
    if (detail) console.log(`        ${detail}`);
  }
  return ok;
};

// --- what the server actually registers --------------------------------------

const groupBlock = index.slice(index.indexOf('const TOOL_GROUPS'), index.indexOf('const GROUP_NAMES'));
const groups = [...groupBlock.matchAll(/^\s*(\w+):\s*\{\s*register:/gm)].map(m => m[1]);

// The register function's source file, so the tools can be counted from it.
const fileOf = {};
for (const match of index.matchAll(/import \{ (register\w+) \} from '\.\/tools\/([\w.]+)\.js'/g)) {
  fileOf[match[1]] = match[2];
}
const tools = new Map();
for (const group of groups) {
  const fn = groupBlock.match(new RegExp(`${group}:\\s*\\{\\s*register:\\s*(\\w+)`))?.[1];
  const file = fileOf[fn];
  if (!file) continue;
  const source = fs.readFileSync(path.join(root, 'mcp', 'tools', `${file}.js`), 'utf8');
  tools.set(group, [...source.matchAll(/registerTool\(\s*'([\w]+)'/g)].map(m => m[1]));
}

const allTools = [...tools.values()].flat();
console.log(`Checking docs/mcp.md against ${groups.length} groups and ${allTools.length} tools\n`);

// --- the checks ---------------------------------------------------------------

console.log('Group names');
const named = doc.match(/Group names: ([^.]+)\./)?.[1] || '';
for (const group of groups) {
  check(named.includes(`\`${group}\``), `${group} is listed`, `not in: ${named}`);
}

console.log('\nEvery tool appears in the document');
// A tool that is registered and undocumented is unreachable in practice: nobody
// loads a group they cannot see, and nobody calls a tool they never read about.
for (const [group, names] of tools) {
  const missing = names.filter(name => !doc.includes(`\`${name}\``));
  check(missing.length === 0, `${group} (${names.length} tools)`, `missing: ${missing.join(', ')}`);
}

console.log('\nNo tool is documented that no longer exists');
// The other direction, which is worse: a caller reads a name, calls it, and gets
// "unknown tool" from a server that looks broken rather than out of date.
// SCANNED IN THE TOOLS TABLE ONLY, not across the whole document. A
// verb_noun-shaped name in backticks is just as likely to be a PARAMETER -
// `simplify_ratio`, `far_sample_fraction` - and a check that cries wolf about
// those gets switched off. The table is the one place that claims to list tools.
// Ended on the first line that is not a table row, rather than on a blank line:
// this file has CRLF endings, so looking for '\n\n' finds nothing and the scan
// swallows the whole document - which reported sixty parameter names as phantom
// tools and made the check useless in exactly the way its comment warns about.
const lines = doc.split(/\r?\n/);
const tableStart = lines.findIndex(line => line.startsWith('| Group | Tools |'));
const rows = [];
for (let i = tableStart + 1; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i]);
const table = tableStart < 0 ? '' : rows.join('\n');
const known = new Set(allTools);
const ghosts = [...new Set([...table.matchAll(/`(\w+)`/g)].map(m => m[1]))]
  .filter(name => !known.has(name));
check(ghosts.length === 0, 'no phantom tools in the table',
  `listed but not registered: ${ghosts.join(', ')}`);

console.log('\nThe headline count');
const headline = Number(doc.match(/All (\d+) tools cost/)?.[1]);
check(headline === allTools.length, `says ${headline}, server has ${allTools.length}`);
const allRow = Number(doc.match(/\*\(unset\)\* \/ `all` \| (\d+) \|/)?.[1]);
check(allRow === allTools.length, `the selector table's "all" row says ${allRow}`);

console.log(failed ? `\n${failed} check(s) failed.` : '\ndocs/mcp.md is up to date.');
process.exitCode = failed ? 1 : 0;
