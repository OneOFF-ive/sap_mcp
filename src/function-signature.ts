type Token = { value: string; literal: boolean };
type Definition = { signature: string; comments: string[]; implementation: string };
const sections = ['IMPORTING', 'EXPORTING', 'CHANGING', 'TABLES', 'EXCEPTIONS'];
const reserved = new Set([...sections, 'TYPE', 'LIKE', 'REF', 'TO', 'STANDARD', 'TABLE', 'OF', 'OPTIONAL', 'DEFAULT', 'VALUE', 'REFERENCE']);

// Deliberately limited grammar: unsupported constructs fall back to exact verification.
export function functionDefinition(source: string): Definition | undefined {
  const tokens: Token[] = []; const comments: string[] = [];
  let i = 0; let end = -1;
  while (i < source.length && tokens.length < 10000) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || (c === '*' && (i === 0 || source[i - 1] === '\n'))) {
      const start = i;
      while (i < source.length && source[i] !== '\n') i++;
      comments.push(source.slice(start, i).replace(/\r$/, '')); continue;
    }
    if (c === '.') { end = i + 1; break; }
    if (c === "'" || c === '`') {
      const start = i++; let closed = false;
      while (i < source.length) {
        if (source[i] === '\n' || source[i] === '\r') return undefined;
        if (source[i++] !== c) continue;
        if (source[i] === c) { i++; continue; }
        closed = true; break;
      }
      if (!closed) return undefined;
      tokens.push({ value: source.slice(start, i), literal: true }); continue;
    }
    const word = source.slice(i).match(/^(?:[A-Za-z_][A-Za-z0-9_]*|\/[A-Za-z0-9_]+\/[A-Za-z_][A-Za-z0-9_]*)/);
    const number = source.slice(i).match(/^[+-]?\d+/);
    const value = word?.[0] ?? number?.[0] ?? (c === '(' || c === ')' ? c : undefined);
    if (!value) return undefined;
    tokens.push({ value: value.toUpperCase(), literal: false }); i += value.length;
  }
  if (end < 0) return undefined;
  let p = 0;
  const take = (v: string) => !tokens[p]?.literal && tokens[p]?.value === v ? (p++, true) : false;
  const name = () => {
    const t = tokens[p];
    if (!t || t.literal || reserved.has(t.value) || !/^(?:[A-Z_][A-Z0-9_]*|\/[A-Z0-9_]+\/[A-Z_][A-Z0-9_]*)$/.test(t.value)) return undefined;
    p++; return t.value;
  };
  if (!take('FUNCTION') || !name()) return undefined;
  let previous = -1;
  const names = new Set<string>();
  while (p < tokens.length) {
    const section = tokens[p++];
    const order = section.literal ? -1 : sections.indexOf(section.value);
    if (order <= previous) return undefined;
    previous = order;
    let count = 0;
    while (p < tokens.length && !sections.includes(tokens[p].value)) {
      let parameter: string | undefined;
      if (take('VALUE') || take('REFERENCE')) {
        if (section.value === 'EXCEPTIONS' || !take('(')) return undefined;
        parameter = name(); if (!take(')')) return undefined;
      } else parameter = name();
      if (!parameter || names.has(parameter)) return undefined;
      names.add(parameter); count++;
      if (section.value === 'EXCEPTIONS') continue;
      if (!(take('TYPE') || take('LIKE'))) return undefined;
      if (take('REF')) { if (!take('TO') || !name()) return undefined; }
      else if (take('STANDARD')) {
        if (!take('TABLE')) return undefined;
        if (take('OF') && !name()) return undefined;
      } else if (!name()) return undefined;
      if (!take('OPTIONAL') && take('DEFAULT')) {
        const t = tokens[p];
        if (!t) return undefined;
        if (t.literal || /^[+-]?\d+$/.test(t.value)) p++;
        else if (!name()) return undefined;
      }
    }
    if (!count) return undefined;
  }
  return { signature: JSON.stringify(tokens), comments, implementation: source.slice(end) };
}
