// An append-only ledger of verdicts, one JSON line each, chained by SHA-256:
// every entry carries the hash of the entry before it, and its own hash covers
// its contents and that link. Editing, removing or reordering an earlier entry
// breaks the chain at that point.
//
// Tamper-evident, not tamper-proof: someone who rewrites the whole file with
// fresh hashes, or deletes the newest entries, is caught only if the newest
// hash was also kept somewhere else (a commit message, a CI log).

import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseJson } from './json.js';
import { isList, isObject } from './receipt.js';

const START = '0'.repeat(64);
const LOCK_WAIT_MS = 10000;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Sorted keys and no spaces: the one serialization the hashes are taken over.
export function canonical(value) {
  if (isList(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Returns { entries, head } for an intact chain, or { problem: { line, message } }.
export function checkLedger(text) {
  if (text === '') return { entries: 0, head: null };
  if (!text.endsWith('\n')) return broken(text.split('\n').length, 'the last line is incomplete (a write was cut short, or the file was edited)');
  const lines = text.slice(0, -1).split('\n');
  let previous = START;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    let entry;
    try {
      entry = parseJson(line).value;
    } catch {
      return broken(n + 1, 'is not valid JSON');
    }
    if (!isObject(entry) || canonical(entry) !== line) return broken(n + 1, 'is not in the form receipt-check writes (edited by hand?)');
    const { hash, ...body } = entry;
    if (entry.seq !== n + 1) return broken(n + 1, `is entry ${entry.seq} where ${n + 1} was expected (an entry was removed or moved)`);
    if (entry.prev !== previous) return broken(n + 1, 'does not link to the entry before it (an earlier entry was changed, removed or reordered)');
    if (sha256(canonical(body)) !== hash) return broken(n + 1, 'does not match its own hash (this entry was edited)');
    previous = hash;
  }
  return { entries: lines.length, head: previous };
}

const broken = (line, message) => ({ problem: { line, message } });

// Appends one entry after checking the whole chain; a broken ledger is never
// extended. A lock file keeps two runs from appending at once.
export async function appendToLedger(file, fields) {
  const lock = `${file}.lock`;
  await acquire(lock);
  try {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const state = checkLedger(text);
    if (state.problem) throw new Error(`${file} is broken at line ${state.problem.line}: ${state.problem.message}; nothing was added`);
    const body = { v: 1, seq: state.entries + 1, time: new Date().toISOString(), ...fields, prev: state.head ?? START };
    const entry = { ...body, hash: sha256(canonical(body)) };
    fs.appendFileSync(file, `${canonical(entry)}\n`);
    return entry;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

async function acquire(lock) {
  const started = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error(`${lock} exists: another run is writing this ledger, or one stopped midway (delete the lock file if none is running)`);
      }
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}
