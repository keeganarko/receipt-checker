// Strict JSON for hand-written receipts.
//
// JSON.parse keeps the last of two duplicate keys without a word, and reports
// errors as a character offset. A receipt is a claim, so this reader refuses
// duplicate keys and records the line and column of every key and value: the
// schema checks can then point at the exact spot that is wrong.

export class JsonError extends Error {
  constructor(message, where) {
    super(message);
    this.line = where.line;
    this.column = where.column;
  }
}

const MAX_DEPTH = 64;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

// A path names a value the way the error messages do: checks[0].counts.passed.
export function joinPath(base, key) {
  if (typeof key === 'number') return `${base}[${key}]`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `${base}[${JSON.stringify(key)}]`;
  return base === '' ? key : `${base}.${key}`;
}

// Returns { value, values, keys }: `values` and `keys` map each path to the
// { line, column } where its value, or its key, starts.
export function parseJson(text) {
  if (text.startsWith('﻿')) text = text.slice(1);
  const lineStarts = [0];
  for (let n = 0; n < text.length; n++) if (text.charCodeAt(n) === 10) lineStarts.push(n + 1);
  const where = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
  };

  const values = new Map();
  const keys = new Map();
  let i = 0;

  const fail = (message, offset = i) => {
    throw new JsonError(message, where(offset));
  };
  const found = () => {
    if (i >= text.length) return 'the end of the file';
    return text[i] === '\n' || text[i] === '\r' ? 'a line break' : `"${text[i]}"`;
  };
  const space = () => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
      else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) fail('JSON has no comments; remove this one');
      else return;
    }
  };

  const string = () => {
    const start = i++;
    for (;;) {
      if (i >= text.length) fail('this string has no closing quote', start);
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      if (c === 0x5c) {
        const escape = text[i + 1];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('\\u needs four hex digits after it');
          i += 6;
        } else if (escape !== undefined && '"\\/bfnrt'.includes(escape)) {
          i += 2;
        } else {
          fail(`\\${escape ?? ''} is not a JSON escape`);
        }
        continue;
      }
      if (c === 0x0a) fail('this string runs past the end of the line: close it with " (or write \\n)');
      if (c < 0x20) fail('control characters must be escaped inside strings');
      i++;
    }
    i++;
    return JSON.parse(text.slice(start, i));
  };

  const number = () => {
    const start = i;
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(text);
    if (!match) fail(`expected a number, found ${found()}`);
    i += match[0].length;
    if (/[0-9.eE+-]/.test(text[i] ?? '')) fail(`${text.slice(start, i + 1)} is not a valid JSON number`, start);
    return Number(match[0]);
  };

  const object = (path, depth) => {
    const out = Object.create(null); // so a "__proto__" key is just a key
    const seen = new Map();
    i++;
    space();
    if (text[i] === '}') {
      i++;
      return out;
    }
    for (;;) {
      space();
      if (text[i] !== '"') {
        if (text[i] === '}') fail('remove the comma before }: JSON has no trailing commas');
        fail(`expected a key in double quotes, found ${found()}`);
      }
      const keyAt = i;
      const key = string();
      if (seen.has(key)) {
        const first = where(seen.get(key));
        fail(`duplicate key "${key}" (first used at line ${first.line}, column ${first.column})`, keyAt);
      }
      seen.set(key, keyAt);
      const child = joinPath(path, key);
      keys.set(child, where(keyAt));
      space();
      if (text[i] !== ':') fail(`expected : after "${key}", found ${found()}`);
      i++;
      out[key] = value(child, depth + 1);
      space();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === '}') {
        i++;
        return out;
      }
      fail(`expected , or } after the value of "${key}", found ${found()}`);
    }
  };

  const list = (path, depth) => {
    const out = [];
    i++;
    space();
    if (text[i] === ']') {
      i++;
      return out;
    }
    for (;;) {
      out.push(value(joinPath(path, out.length), depth + 1));
      space();
      if (text[i] === ',') {
        i++;
        space();
        if (text[i] === ']') fail('remove the comma before ]: JSON has no trailing commas');
        continue;
      }
      if (text[i] === ']') {
        i++;
        return out;
      }
      fail(`expected , or ] after an item in the list, found ${found()}`);
    }
  };

  const value = (path, depth) => {
    space();
    if (depth > MAX_DEPTH) fail(`more than ${MAX_DEPTH} levels of nesting`);
    values.set(path, where(i));
    const c = text[i];
    if (c === '{') return object(path, depth);
    if (c === '[') return list(path, depth);
    if (c === '"') return string();
    if (c === '-' || (c >= '0' && c <= '9')) return number();
    for (const [word, literal] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return literal;
      }
    }
    if (c === "'") fail('JSON strings take double quotes, not single quotes');
    return fail(`expected a value, found ${found()}`);
  };

  const result = value('', 0);
  space();
  if (i < text.length) fail(`unexpected ${found()} after the end of the JSON`);
  return { value: result, values, keys };
}
