import * as L from 'lucide-react';
import fs from 'node:fs'; import path from 'node:path';
const files = []; (function walk(d){ for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.jsx?$/.test(f)) files.push(p); } })('src');
const missing = new Set();
for (const f of files) { const s = fs.readFileSync(f, 'utf8'); const m = s.match(/import\s*\{([^}]+)\}\s*from\s*'lucide-react'/); if (!m) continue; for (let n of m[1].split(',')) { n = n.trim().split(/\s+as\s+/)[0]; if (n && !(n in L)) missing.add(f + ': ' + n); } }
console.log([...missing].join('\n') || 'all icons ok');
