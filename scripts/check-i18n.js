// check-i18n.js
// Reports i18n table problems. Warnings only, exit code is always 0.
//   node scripts/check-i18n.js
// - keys missing from / extra in each language vs en
// - localize('...') keys used in content/ that en doesn't define
// - {placeholder} mismatches between en and a translation
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const i18nDir = path.join(root, 'content', 'i18n');

const sandbox = { globalThis: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of fs.readdirSync(i18nDir).filter(f => f.endsWith('.js'))) {
	vm.runInContext(fs.readFileSync(path.join(i18nDir, file), 'utf8'), sandbox, { filename: file });
}
const tables = sandbox.QOL_I18N;
const en = tables.en;
const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

let problems = 0;
const warn = msg => { problems++; console.log(msg); };

for (const [lang, table] of Object.entries(tables)) {
	if (lang === 'en') continue;
	const missing = Object.keys(en).filter(k => !(k in table));
	const extra = Object.keys(table).filter(k => !(k in en));
	if (missing.length) warn(`[${lang}] missing ${missing.length}: ${missing.join(', ')}`);
	if (extra.length) warn(`[${lang}] extra ${extra.length}: ${extra.join(', ')}`);
	for (const [k, v] of Object.entries(table)) {
		if (k in en && placeholders(v) !== placeholders(en[k])) {
			warn(`[${lang}] placeholder mismatch in ${k}: "${v}"`);
		}
	}
}

function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.name.endsWith('.js')) out.push(full);
	}
	return out;
}
for (const file of walk(path.join(root, 'content'))) {
	const src = fs.readFileSync(file, 'utf8');
	for (const m of src.matchAll(/localize\(\s*['"`]([\w.-]+)['"`]/g)) {
		if (!(m[1] in en)) warn(`[en] undefined key ${m[1]} used in ${path.relative(root, file)}`);
	}
}

console.log(problems ? `\n${problems} problem(s).` : 'i18n OK');
