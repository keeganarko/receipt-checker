// The receipt format, version 1: what a receipt may say, and the exact
// complaint for each way it can be wrong. Every problem is collected, so a
// person or an agent can fix a receipt in one pass.

import { JsonError, joinPath, parseJson } from './json.js';

export const RECEIPT_FORMAT = 'receipt-check/1';
export const FORMATS = ['tap', 'junit', 'exit-code'];
export const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 86400;
const MAX_CHECKS = 100;
const MAX_ERRORS = 50;

const KEYS = {
  receipt: ['receipt', 'status', 'commit', 'checks', 'delivered', 'done_when', 'note'],
  check: ['id', 'run', 'format', 'file', 'counts', 'timeout_seconds', 'env'],
  counts: ['passed', 'failed', 'skipped'],
  item: ['id', 'text', 'check'],
};

// Names people reach for first, mapped to the key this format uses.
const ALIASES = {
  version: 'receipt', schema: 'receipt', sha: 'commit', revision: 'commit', rev: 'commit',
  command: 'run', cmd: 'run', script: 'run', timeout: 'timeout_seconds', reporter: 'format',
  report: 'file', files: 'delivered', deliverables: 'delivered', doneWhen: 'done_when',
  'done-when': 'done_when', name: 'id', description: 'text', pass: 'passed', fail: 'failed',
  skip: 'skipped', failures: 'failed', skips: 'skipped', total: 'passed',
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// JSON has two containers; the list is the one that can be iterated.
export const isList = (v) => v !== null && typeof v === 'object' && typeof v[Symbol.iterator] === 'function';
export const isObject = (v) => v !== null && typeof v === 'object' && !isList(v);

export function kindOf(v) {
  if (v === null) return 'null';
  if (isList(v)) return 'a list';
  if (typeof v === 'object') return 'an object';
  if (typeof v === 'string') return `a string (${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)})`;
  if (typeof v === 'number') return `the number ${v}`;
  return String(v);
}

// Parses and validates receipt text. Returns { receipt } with defaults filled
// in, or { errors: [{ path, line, column, message }] } naming every problem.
export function readReceipt(text) {
  let parsed;
  try {
    parsed = parseJson(text);
  } catch (error) {
    if (!(error instanceof JsonError)) throw error;
    return { errors: [{ path: null, line: error.line, column: error.column, message: error.message }] };
  }
  const errors = [];
  const problem = (path, message, onKey = false) => {
    if (errors.length >= MAX_ERRORS) return;
    const at = (onKey && parsed.keys.get(path)) || parsed.values.get(path) || {};
    errors.push({ path, line: at.line ?? null, column: at.column ?? null, message });
  };
  const receipt = validate(parsed.value, problem);
  return errors.length ? { errors } : { receipt };
}

function validate(doc, problem) {
  if (!isObject(doc)) {
    problem('', `a receipt is one JSON object ({ ... }), not ${kindOf(doc)}`);
    return null;
  }
  unknownKeys(doc, '', KEYS.receipt, problem);
  const missing = {
    receipt: `add "receipt": "${RECEIPT_FORMAT}"`,
    status: 'add "status": "PASS"',
    commit: 'add the full commit id that git rev-parse HEAD prints',
    checks: 'add the checks to rerun, such as [{ "id": "tests", "run": "npm test" }]',
  };
  for (const [key, hint] of Object.entries(missing)) {
    if (!(key in doc)) problem('', `missing "${key}": ${hint}`);
  }

  if ('receipt' in doc && doc.receipt !== RECEIPT_FORMAT) {
    const v = doc.receipt;
    problem('receipt', typeof v === 'string' && /^receipt-check\/[0-9]+$/.test(v)
      ? `this checker reads ${RECEIPT_FORMAT}, and this receipt is ${v}`
      : `must be "${RECEIPT_FORMAT}", not ${kindOf(v)}`);
  }

  if ('status' in doc && doc.status !== 'PASS') {
    const v = doc.status;
    problem('status', typeof v === 'string' && v.toUpperCase() === 'PASS'
      ? 'write "PASS" in capitals'
      : `must be "PASS", not ${kindOf(v)}: a receipt claims that work is done, and a failure needs no proof`);
  }

  if ('commit' in doc) {
    const v = doc.commit;
    if (typeof v !== 'string') problem('commit', `must be the full commit id as a string, not ${kindOf(v)}`);
    else if (!FULL_COMMIT.test(v)) {
      if (FULL_COMMIT.test(v.toLowerCase())) problem('commit', 'write the id in lowercase, as git prints it');
      else if (/^[0-9a-fA-F]{4,39}$/.test(v)) problem('commit', `"${v}" is a short id; give all 40 characters (git rev-parse ${v})`);
      else problem('commit', `${JSON.stringify(v)} is not a full commit id: give the 40 hex characters that git rev-parse prints, since a branch, a tag or HEAD can move`);
    }
  }

  const checks = [];
  if ('checks' in doc) {
    const v = doc.checks;
    if (!isList(v)) problem('checks', `must be a list of checks, not ${kindOf(v)}`);
    else if (v.length === 0) problem('checks', 'is empty: a receipt needs at least one check to rerun');
    else if (v.length > MAX_CHECKS) problem('checks', `has ${v.length} checks; the limit is ${MAX_CHECKS}`);
    else {
      const firstUse = new Map();
      v.forEach((item, n) => {
        const check = validateCheck(item, `checks[${n}]`, doc.status, problem);
        if (!check) return;
        if (firstUse.has(check.id)) problem(`checks[${n}].id`, `check id "${check.id}" is used twice (also at ${firstUse.get(check.id)})`);
        else firstUse.set(check.id, `checks[${n}]`);
        checks.push(check);
      });
    }
  }

  const delivered = [];
  if ('delivered' in doc) {
    const v = doc.delivered;
    if (!isList(v)) problem('delivered', `must be a list of paths, not ${kindOf(v)}`);
    else {
      v.forEach((p, n) => {
        const path = `delivered[${n}]`;
        const issue = pathProblem(p);
        if (issue) problem(path, issue);
        else if (delivered.includes(p)) problem(path, `"${p}" is listed twice`);
        else delivered.push(p);
      });
    }
  }

  const doneWhen = [];
  if ('done_when' in doc) {
    const v = doc.done_when;
    if (!isList(v)) problem('done_when', `must be a list of items, not ${kindOf(v)}`);
    else {
      const ids = new Set();
      v.forEach((item, n) => {
        const path = `done_when[${n}]`;
        if (!isObject(item)) {
          problem(path, `each item is an object such as { "id": "r1", "text": "tests pass", "check": "tests" }, not ${kindOf(item)}`);
          return;
        }
        unknownKeys(item, path, KEYS.item, problem);
        for (const key of KEYS.item) if (!(key in item)) problem(path, `missing "${key}"`);
        const id = checkId(item.id, joinPath(path, 'id'), problem);
        if (id !== null && ids.has(id)) problem(joinPath(path, 'id'), `done-when id "${id}" is used twice`);
        if (id !== null) ids.add(id);
        if ('text' in item && (typeof item.text !== 'string' || item.text.trim() === '')) {
          problem(joinPath(path, 'text'), typeof item.text === 'string' ? 'is empty: say what was promised' : `must be a string, not ${kindOf(item.text)}`);
        }
        if ('check' in item) {
          if (typeof item.check !== 'string') problem(joinPath(path, 'check'), `must name a check id as a string, not ${kindOf(item.check)}`);
          else if (checks.length && !checks.some((c) => c.id === item.check)) {
            problem(joinPath(path, 'check'), `names check "${item.check}", but no check has that id (checks: ${[...new Set(checks.map((c) => c.id))].join(', ')})`);
          }
        }
        doneWhen.push({ id: item.id, text: item.text, check: item.check });
      });
    }
  }

  if ('note' in doc && typeof doc.note !== 'string') problem('note', `must be a string, not ${kindOf(doc.note)}`);

  return {
    receipt: RECEIPT_FORMAT,
    status: doc.status,
    commit: doc.commit,
    checks,
    delivered,
    done_when: doneWhen,
    note: doc.note ?? null,
  };
}

function validateCheck(item, path, status, problem) {
  if (!isObject(item)) {
    problem(path, `each check is an object such as { "id": "tests", "run": "npm test" }, not ${kindOf(item)}`);
    return null;
  }
  unknownKeys(item, path, KEYS.check, problem);
  for (const key of ['id', 'run']) if (!(key in item)) problem(path, `missing "${key}"`);
  const id = checkId(item.id, joinPath(path, 'id'), problem);

  if ('run' in item) {
    const run = item.run;
    if (typeof run !== 'string') problem(joinPath(path, 'run'), `must be a shell command as a string, not ${kindOf(run)}`);
    else if (run.trim() === '') problem(joinPath(path, 'run'), 'is empty: give the shell command to rerun');
    else if (run.includes('\0')) problem(joinPath(path, 'run'), 'contains a NUL character');
  }

  let format = 'exit-code';
  let formatKnown = true;
  if ('format' in item) {
    const v = item.format;
    if (FORMATS.includes(v)) format = v;
    else {
      formatKnown = false;
      problem(joinPath(path, 'format'), typeof v === 'string' && FORMATS.includes(v.toLowerCase())
        ? `write "${v.toLowerCase()}" in lowercase`
        : `must be "tap", "junit" or "exit-code", not ${kindOf(v)}`);
    }
  }
  const reports = format === 'tap' || format === 'junit';

  if ('file' in item) {
    const issue = pathProblem(item.file);
    if (issue) problem(joinPath(path, 'file'), issue);
    else if (formatKnown && !reports) problem(joinPath(path, 'file'), '"file" is only read when "format" is "tap" or "junit"');
  }

  let counts = null;
  if ('counts' in item) {
    const v = item.counts;
    if (formatKnown && !reports) {
      problem(joinPath(path, 'counts'), '"counts" need "format": "tap" or "junit"; with "exit-code" only the exit status is checked');
    } else if (!isObject(v)) {
      problem(joinPath(path, 'counts'), `must be an object such as { "passed": 10, "failed": 0, "skipped": 0 }, not ${kindOf(v)}`);
    } else {
      const countsPath = joinPath(path, 'counts');
      unknownKeys(v, countsPath, KEYS.counts, problem);
      counts = {};
      for (const key of KEYS.counts) {
        const n = v[key];
        if (!(key in v)) problem(countsPath, `missing "${key}": give passed, failed and skipped, even when one is 0`);
        else if (!Number.isSafeInteger(n) || n < 0) problem(joinPath(countsPath, key), `must be a whole number of 0 or more, not ${kindOf(n)}`);
        else counts[key] = n;
      }
      if (status === 'PASS' && counts.failed > 0) {
        problem(joinPath(countsPath, 'failed'), `is ${counts.failed}, but a PASS receipt can't have failed tests`);
      }
    }
  } else if (reports) {
    problem(path, `missing "counts": format "${format}" compares the passed, failed and skipped numbers you claim with the ones the rerun reports`);
  }

  let timeout = DEFAULT_TIMEOUT_SECONDS;
  if ('timeout_seconds' in item) {
    const v = item.timeout_seconds;
    if (Number.isSafeInteger(v) && v >= 1 && v <= MAX_TIMEOUT_SECONDS) timeout = v;
    else problem(joinPath(path, 'timeout_seconds'), `must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}, not ${kindOf(v)}`);
  }

  const env = {};
  if ('env' in item) {
    const v = item.env;
    if (!isObject(v)) problem(joinPath(path, 'env'), `must be an object of NAME: "value" pairs, not ${kindOf(v)}`);
    else {
      for (const [name, value] of Object.entries(v)) {
        const at = joinPath(joinPath(path, 'env'), name);
        if (!ENV_NAME.test(name)) problem(at, `"${name}" is not a usable environment variable name`, true);
        else if (typeof value !== 'string') problem(at, `must be a string, not ${kindOf(value)}`);
        else if (value.includes('\0')) problem(at, 'contains a NUL character');
        // defined, not assigned: assigning "__proto__" would set the prototype and drop the variable
        else Object.defineProperty(env, name, { value, enumerable: true, writable: true, configurable: true });
      }
    }
  }

  if (id === null) return null;
  return { id, run: item.run, format, file: item.file ?? null, counts, timeout_seconds: timeout, env };
}

function checkId(v, path, problem) {
  if (v === undefined) return null;
  if (typeof v !== 'string') {
    problem(path, `must be a string, not ${kindOf(v)}`);
    return null;
  }
  if (!ID.test(v)) {
    problem(path, `"${v}" is not a usable id: use up to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit`);
    return null;
  }
  return v;
}

// Paths are relative to the repository root, written the way git writes them.
export function pathProblem(p) {
  if (typeof p !== 'string') return `must be a path as a string, not ${kindOf(p)}`;
  if (p === '') return 'is empty';
  if (/[\x00-\x1f\x7f]/.test(p)) return `${JSON.stringify(p)} contains a control character`;
  if (p.includes('\\')) return `"${p}" uses \\; write / between folders`;
  if (p.startsWith('/')) return `"${p}" is absolute; write it relative to the repository root`;
  if (p.endsWith('/')) return `"${p}" ends with /; drop it`;
  for (const part of p.split('/')) {
    if (part === '') return `"${p}" has an empty folder name (//)`;
    if (part === '.' || part === '..') return `"${p}" contains "${part}"; write the plain path from the repository root`;
  }
  return null;
}

function unknownKeys(obj, path, allowed, problem) {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue;
    const hint = suggest(key, allowed);
    problem(joinPath(path, key), hint
      ? `unknown key "${key}"; did you mean "${hint}"?`
      : `unknown key "${key}"; the keys here are ${allowed.join(', ')}`, true);
  }
}

function suggest(key, allowed) {
  if (allowed.includes(ALIASES[key])) return ALIASES[key];
  let best = null;
  let bestDistance = 3;
  for (const candidate of allowed) {
    const d = distance(key.toLowerCase(), candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

// Levenshtein distance, for "did you mean".
function distance(a, b) {
  let previous = [];
  for (let j = 0; j <= b.length; j++) previous.push(j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    previous = row;
  }
  return previous[b.length];
}
