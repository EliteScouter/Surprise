// Fails if any SQL is built from strings instead of ? placeholders.
// The only interpolation allowed is ${order}, which comes from the fixed SORTS table.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../lib/store.js', import.meta.url), 'utf8');
const SQL = /\b(SELECT|INSERT|UPDATE|DELETE|REPLACE|WHERE|ORDER BY|LIMIT|VALUES)\b/i;
const problems = [];

// template literals that contain SQL and interpolate anything but ${order}
for (const m of src.matchAll(/`([^`]*)`/g)) {
  if (!SQL.test(m[1])) continue;
  for (const interp of m[1].matchAll(/\$\{([^}]*)\}/g)) {
    if (interp[1].trim() !== 'order') problems.push(`interpolated \${${interp[1]}} in: ${m[1].trim().slice(0, 80)}`);
  }
}
// SQL strings glued together with +
for (const m of src.matchAll(/(['"`])([^'"`\n]*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^'"`\n]*)\1\s*\+/gi)) {
  problems.push(`string concatenation: ${m[2].slice(0, 80)}`);
}
// every query/execute call must pass its SQL as a literal, never a variable
for (const m of src.matchAll(/\.(query|execute)\(\s*([A-Za-z_$][\w$.]*)\s*[,)]/g)) {
  if (m[2] !== 'stmt') problems.push(`.${m[1]}() called with variable SQL "${m[2]}"`);
}
// ORDER BY may only use the allowlisted sort
const sorts = src.match(/const SORTS = \{([\s\S]*?)\};/);
if (!sorts) problems.push('SORTS allowlist missing');

if (problems.length) { console.error('SQL safety FAILED:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('SQL safety: all queries parameterized');
