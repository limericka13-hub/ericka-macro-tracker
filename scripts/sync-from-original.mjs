/**
 * Rebuild this fork from the original Macro Tracker.
 *
 *   node scripts/sync-from-original.mjs [path-to-original]
 *
 * The default source is the original's folder on the development laptop, two
 * levels up from this repo.
 *
 * The original's app files are copied over and this instance's edits are
 * reapplied on top of them:
 *   app.js      reads its Supabase settings from config.js, not a literal
 *   index.html  loads config.js, carries this instance's name, and has the
 *               original's Supabase URL and key stripped from the settings modal
 *   sw.js       its own cache namespace, and config.js in the offline cache
 *   build.js    ships config.js
 *   *.json      this instance's app and package names
 *
 * Every edit has to land exactly once. If the original has changed shape so an
 * edit no longer fits, or has grown a file this script does not know about, it
 * stops before writing anything - a half-patched app is worse than a stale one.
 * As a last check it refuses to write any file that still contains the
 * original's Supabase project ref or key.
 *
 * Never touched: config.js, schema.sql, README.md, .gitignore, scripts/.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const CACHE_PREFIX = 'ericka-';
const PACKAGE_NAME = 'ericka-macro-tracker';
// Open Food Facts asks callers to identify themselves with a name and contact.
const USER_AGENT = 'ErickaMacroTracker/1.0 (personal macro tracker; https://github.com/limericka13-hub/ericka-macro-tracker)';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, process.argv[2] || '../../Macro Tracker Project/macro tracker project');

// Copied as-is.
const VERBATIM = ['styles.css', 'icon.svg', 'server.js'];
// Copied, then edited below.
const PATCHED = ['app.js', 'index.html', 'sw.js', 'build.js', 'vercel.json', 'manifest.json', 'package.json', 'package-lock.json'];
// Mirrored whole, so a new serverless function comes across too.
const DIRS = ['api'];
// In the original but deliberately not part of this fork.
const IGNORED = ['.claude', '.git', '.gitignore', '.vercel', 'README.md', 'metadata.json', 'node_modules', 'public'];

function fail(msg) {
  console.error(`\nSync stopped, nothing written.\n${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(path.join(SRC, 'app.js'))) {
  fail(`No app.js in ${SRC}.\nPass the original's folder: node scripts/sync-from-original.mjs "<path>"`);
}

// The original is developed on more than one machine, so the local copy can
// lag what is already live. Syncing from it would quietly hand this instance
// an older app than the original's. Skipped when there is no git, no remote
// or no network - the check is a guard, not a requirement.
const git = (...args) => execFileSync('git', ['-C', SRC, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let uncommitted = '';
try {
  git('fetch', '--quiet');
  const behind = Number(git('rev-list', '--count', 'HEAD..@{u}'));
  if (behind > 0) fail(`The original is ${behind} commit(s) behind its GitHub copy.\nPull it first: git -C "${SRC}" pull`);
  uncommitted = git('status', '--porcelain');
} catch (e) { /* not a git checkout, no upstream, or offline */ }

// A file the original gained since the last sync may be something index.html
// now loads. Copying it blindly and skipping it silently are both wrong.
const known = new Set([...VERBATIM, ...PATCHED, ...DIRS, ...IGNORED]);
const unknown = fs.readdirSync(SRC).filter(f => !known.has(f) && !f.startsWith('.env'));
if (unknown.length) {
  fail(`The original has files this script does not know about:\n  ${unknown.join('\n  ')}\n` +
       `Add each to VERBATIM, PATCHED or IGNORED at the top of this script.`);
}

// This instance's settings live in config.js only.
const sandbox = {};
new Function('window', fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8'))(sandbox);
const APP = sandbox.APP_CONFIG;
if (!APP || !APP.APP_NAME) fail('config.js does not define window.APP_CONFIG.APP_NAME.');

const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Apply each [description, pattern, replacer] exactly once, or stop.
function patch(file, text, edits) {
  for (const [what, pattern, replacer] of edits) {
    const n = (text.match(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g')) || []).length;
    if (n !== 1) fail(`${file}: expected exactly one match for "${what}", found ${n}.`);
    text = text.replace(pattern, replacer);
  }
  return text;
}

const out = new Map(); // repo-relative path -> new contents

// ---- app.js ----------------------------------------------------------------
const appSrc = read('app.js');
const CONFIG_RE = /const CONFIG = \{\r?\n([\s\S]*?)\r?\n\};/;
const configBody = (appSrc.match(CONFIG_RE) || [])[1];
if (!configBody) fail('app.js: could not find the CONFIG literal.');

// app.js will read window.APP_CONFIG instead, so a key the original's CONFIG
// gains later would otherwise silently arrive as undefined.
const missing = [...configBody.matchAll(/^\s*([A-Z_]+):/gm)].map(m => m[1]).filter(k => !(k in APP));
if (missing.length) fail(`The original's CONFIG has keys config.js lacks: ${missing.join(', ')}.\nAdd them to config.js, then sync again.`);

const originalRef = (configBody.match(/https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1];
const originalKey = (configBody.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/) || [])[1];
if (!originalRef || !originalKey) fail('app.js: could not read the original Supabase URL and key from CONFIG.');
if (String(APP.SUPABASE_URL).includes(originalRef) || APP.SUPABASE_ANON_KEY === originalKey) {
  fail("config.js points at the original's Supabase project. It must hold this instance's own.");
}

{
  const eol = eolOf(appSrc);
  out.set('app.js', patch('app.js', appSrc, [
    ['CONFIG literal', CONFIG_RE, () => [
      '// Supplied by config.js, which loads first. Held as a reference rather than a',
      '// copy because saveCustomSupabaseConfig() reassigns CONFIG.SUPABASE_URL and',
      '// .SUPABASE_ANON_KEY in place before re-initialising the client.',
      'const CONFIG = window.APP_CONFIG;'
    ].join(eol)]
  ]));
}

// ---- index.html ------------------------------------------------------------
{
  const src = read('index.html');
  const eol = eolOf(src);
  const name = escapeHtml(APP.APP_NAME);
  out.set('index.html', patch('index.html', src, [
    ['app.js script tag', /<script src="\/app\.js[^"]*"><\/script>/, (m) => `<script src="/config.js"></script>${eol}${m}`],
    // app.js fills these three from CONFIG whenever the modal opens; the
    // literals only leaked the original's project into view-source.
    ['settings modal URL value', /(id="config-supabase-url"[^>]*?)\svalue="[^"]*"/, (m, pre) => `${pre} value=""`],
    ['settings modal key value', /(id="config-supabase-key"[^>]*?)\svalue="[^"]*"/, (m, pre) => `${pre} value=""`],
    ['settings modal URL text', /(<code id="modal-project-url-display">)[^<]*(<\/code>)/, (m, a, b) => `${a}not connected${b}`],
    ['<title>', /<title>[^<]*<\/title>/, () => `<title>${name}</title>`],
    ['login logo alt text', /alt="Macro Tracker"/, () => `alt="${name}"`],
    ['login heading', /(class="login-brand-title">)Macro Tracker(<)/, (m, a, b) => `${a}${name}${b}`],
    ['header heading', /(class="brand-title">)Macro Tracker(<)/, (m, a, b) => `${a}${name}${b}`]
  ]));
}

// ---- sw.js / build.js ------------------------------------------------------
// The cache name keeps the original's version number, so every version bump
// there carries through here and installed copies pick up the new files.
out.set('sw.js', patch('sw.js', read('sw.js'), [
  ['CACHE_NAME', /const CACHE_NAME = '([^']+)';/, (m, v) => `const CACHE_NAME = '${CACHE_PREFIX}${v}';`],
  ["'/app.js' in APP_ASSETS", /(\r?\n)([ \t]*)'\/app\.js',/, (m, nl, ind) => `${nl}${ind}'/config.js',${nl}${ind}'/app.js',`]
]));
out.set('build.js', patch('build.js', read('build.js'), [
  ["'app.js' in filesToCopy", /(\r?\n)([ \t]*)'app\.js',/, (m, nl, ind) => `${nl}${ind}'config.js',${nl}${ind}'app.js',`]
]));

// ---- JSON ------------------------------------------------------------------
function json(file, mutate) {
  const src = read(file);
  const eol = eolOf(src);
  const obj = JSON.parse(src);
  mutate(obj);
  const body = JSON.stringify(obj, null, 2).replace(/\n/g, eol);
  out.set(file, src.endsWith('\n') ? body + eol : body);
}
// null pins the "Other" preset. A project created on Vercel today sees
// server.js plus the express dependency and auto-detects Express, which runs
// every request through server.js - and there express.static finds no files,
// so the catch-all answers /app.js, /config.js and the rest with index.html.
json('vercel.json', (v) => { v.framework = null; });
json('manifest.json', (m) => { m.name = APP.APP_NAME; if (APP.APP_SHORT_NAME) m.short_name = APP.APP_SHORT_NAME; });
json('package.json', (p) => { p.name = PACKAGE_NAME; });
json('package-lock.json', (l) => { l.name = PACKAGE_NAME; if (l.packages && l.packages['']) l.packages[''].name = PACKAGE_NAME; });

// ---- verbatim files and mirrored directories --------------------------------
for (const f of VERBATIM) out.set(f, fs.readFileSync(path.join(SRC, f)));

const removals = [];
for (const d of DIRS) {
  const names = fs.readdirSync(path.join(SRC, d));
  for (const f of names) {
    if (fs.statSync(path.join(SRC, d, f)).isDirectory()) fail(`${d}/${f} is a directory; this script only mirrors flat folders.`);
    out.set(`${d}/${f}`, fs.readFileSync(path.join(SRC, d, f)));
  }
  const here = path.join(ROOT, d);
  if (fs.existsSync(here)) for (const f of fs.readdirSync(here)) if (!names.includes(f)) removals.push(`${d}/${f}`);
}

// The food search names this instance to Open Food Facts, not the original.
out.set('api/off-search.js', patch('api/off-search.js', out.get('api/off-search.js').toString('utf8'), [
  ['USER_AGENT', /const USER_AGENT = '[^']*';/, () => `const USER_AGENT = '${USER_AGENT}';`]
]));

// ---- last check, then write --------------------------------------------------
for (const [f, content] of out) {
  const s = content.toString('utf8');
  if (s.includes(originalKey)) fail(`${f} still contains the original's Supabase key.`);
  if (s.includes(originalRef)) fail(`${f} still contains the original's Supabase project ref.`);
}

const depsOf = (file) => {
  try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); return JSON.stringify([p.dependencies, p.devDependencies]); }
  catch (e) { return null; }
};
const depsBefore = depsOf(path.join(ROOT, 'package.json'));

const changed = [];
for (const [f, content] of out) {
  const dest = path.join(ROOT, f);
  const before = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  const after = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (before && before.equals(after)) continue;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, after);
  changed.push(f);
}
for (const f of removals) fs.unlinkSync(path.join(ROOT, f));

console.log(`Synced from ${SRC}`);
console.log(changed.length ? `  updated: ${changed.join(', ')}` : '  already up to date');
if (removals.length) console.log(`  removed: ${removals.join(', ')}`);
console.log(`  cache:   ${(out.get('sw.js').match(/CACHE_NAME = '([^']+)'/) || [])[1]}`);
if (depsOf(path.join(ROOT, 'package.json')) !== depsBefore) console.log('\nDependencies changed - run npm install.');
if (uncommitted) {
  console.log('\nNote: the original has uncommitted changes, and they were synced too. Commit them there');
  console.log('as well, or the two apps will differ in a way neither history shows.');
}
if (/REPLACE_ME/.test(APP.SUPABASE_URL + APP.SUPABASE_ANON_KEY)) {
  console.log("\nNote: config.js still has placeholder Supabase values, so the app won't connect yet.");
}
