import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { appendToLedger, canonical, checkLedger } from '../src/ledger.js';
import { isList, isObject } from '../src/receipt.js';
import { sha256, withTemp } from './helpers.js';

const START = '0'.repeat(64);
const fields = (n) => ({ verdict: n % 2 ? 'VERIFIED' : 'REFUTED', commit: 'c'.repeat(40), receipt_sha256: 'd'.repeat(64), reasons: [`reason ${n}`], checker: 'receipt-check test' });

// An independent canonical form: keys sorted at every level, no spaces.
function sorted(value) {
  if (isList(value)) return value.map(sorted);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  return value;
}
const canon = (value) => JSON.stringify(sorted(value));
const hashOf = (entry) => {
  const { hash, ...body } = entry;
  return sha256(canon(body));
};

async function ledgerOf(dir, n) {
  const file = path.join(dir, 'ledger.jsonl');
  for (let k = 1; k <= n; k++) await appendToLedger(file, fields(k));
  return file;
}
const linesOf = (file) => fs.readFileSync(file, 'utf8').slice(0, -1).split('\n');
const entriesOf = (file) => linesOf(file).map((line) => JSON.parse(line));
const textOf = (entries) => `${entries.map(canon).join('\n')}\n`;
const brokenAt = (text) => checkLedger(text).problem;

describe('ledger: canonical form', () => {
  test('keys sorted at every level, no spaces', () => {
    assert.equal(canonical({ b: 1, a: [{ d: 'x', c: null }, true], é: 'ü' }), '{"a":[{"c":null,"d":"x"},true],"b":1,"é":"ü"}');
    assert.equal(canonical('a"b\n'), '"a\\"b\\n"');
    assert.equal(canonical([]), '[]');
    assert.equal(canonical({ a: { b: { c: 1 } } }), canon({ a: { b: { c: 1 } } }));
  });
});

describe('ledger: an intact chain', () => {
  test('an empty ledger is intact', () => {
    assert.deepEqual(checkLedger(''), { entries: 0, head: null });
  });

  test('appended entries form a chain of canonical lines', async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, 'ledger.jsonl');
      const first = await appendToLedger(file, fields(1));
      const second = await appendToLedger(file, fields(2));
      const third = await appendToLedger(file, fields(3));
      const entries = entriesOf(file);
      assert.deepEqual(entries, [first, second, third]);
      assert.deepEqual(linesOf(file), entries.map(canon));
      entries.forEach((entry, n) => {
        assert.deepEqual(Object.keys(entry).sort(), ['checker', 'commit', 'hash', 'prev', 'reasons', 'receipt_sha256', 'seq', 'time', 'v', 'verdict']);
        assert.equal(entry.v, 1);
        assert.equal(entry.seq, n + 1);
        assert.equal(entry.prev, n === 0 ? START : entries[n - 1].hash);
        assert.equal(entry.hash, hashOf(entry));
        assert.match(entry.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        assert.equal(entry.verdict, fields(n + 1).verdict);
        assert.deepEqual(entry.reasons, fields(n + 1).reasons);
      });
      assert.deepEqual(checkLedger(fs.readFileSync(file, 'utf8')), { entries: 3, head: third.hash });
      assert.equal(fs.existsSync(`${file}.lock`), false);
    });
  });

  test('an append waits for a lock held by another run', async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, 'ledger.jsonl');
      fs.writeFileSync(`${file}.lock`, '');
      const started = Date.now();
      setTimeout(() => fs.rmSync(`${file}.lock`), 300);
      const entry = await appendToLedger(file, fields(1));
      assert.ok(Date.now() - started >= 250, 'it waited for the lock');
      assert.equal(entry.seq, 1);
      assert.equal(fs.existsSync(`${file}.lock`), false);
    });
  });
});

describe('ledger: tampering is detected', () => {
  test('an edited entry no longer matches its own hash', async () => {
    await withTemp(async (dir) => {
      const entries = entriesOf(await ledgerOf(dir, 3));
      entries[1].verdict = 'VERIFIED';
      assert.deepEqual(brokenAt(textOf(entries)), { line: 2, message: 'does not match its own hash (this entry was edited)' });
    });
  });

  test('an edited entry given a fresh hash breaks the link from the next one', async () => {
    await withTemp(async (dir) => {
      const entries = entriesOf(await ledgerOf(dir, 3));
      entries[0].reasons = [];
      entries[0].hash = hashOf(entries[0]);
      assert.deepEqual(brokenAt(textOf(entries)), { line: 2, message: 'does not link to the entry before it (an earlier entry was changed, removed or reordered)' });
    });
  });

  test('a removed entry', async () => {
    await withTemp(async (dir) => {
      const entries = entriesOf(await ledgerOf(dir, 3));
      assert.deepEqual(brokenAt(textOf([entries[0], entries[2]])), { line: 2, message: 'is entry 3 where 2 was expected (an entry was removed or moved)' });
      assert.deepEqual(brokenAt(textOf([entries[1], entries[2]])), { line: 1, message: 'is entry 2 where 1 was expected (an entry was removed or moved)' });
    });
  });

  test('a removed entry with every later entry renumbered and rehashed', async () => {
    await withTemp(async (dir) => {
      const entries = entriesOf(await ledgerOf(dir, 3));
      const third = { ...entries[2], seq: 2 };
      third.hash = hashOf(third);
      assert.deepEqual(brokenAt(textOf([entries[0], third])), { line: 2, message: 'does not link to the entry before it (an earlier entry was changed, removed or reordered)' });
    });
  });

  test('reordered entries', async () => {
    await withTemp(async (dir) => {
      const entries = entriesOf(await ledgerOf(dir, 3));
      assert.deepEqual(brokenAt(textOf([entries[0], entries[2], entries[1]])), { line: 2, message: 'is entry 3 where 2 was expected (an entry was removed or moved)' });
      const moved = [entries[0], { ...entries[2], seq: 2 }, { ...entries[1], seq: 3 }].map((e) => ({ ...e, hash: hashOf(e) }));
      assert.deepEqual(brokenAt(textOf(moved)), { line: 2, message: 'does not link to the entry before it (an earlier entry was changed, removed or reordered)' });
    });
  });

  test('a line not in canonical form', async () => {
    await withTemp(async (dir) => {
      const lines = linesOf(await ledgerOf(dir, 2));
      const handWritten = 'is not in the form receipt-check writes (edited by hand?)';
      const spaced = [lines[0], JSON.stringify(JSON.parse(lines[1]), null, 1).replace(/\n */g, ' ')];
      assert.deepEqual(brokenAt(`${spaced.join('\n')}\n`), { line: 2, message: handWritten });
      const { v, ...rest } = JSON.parse(lines[0]);
      const unsorted = [JSON.stringify({ v, ...rest }), lines[1]];
      assert.notEqual(unsorted[0], lines[0]);
      assert.deepEqual(brokenAt(`${unsorted.join('\n')}\n`), { line: 1, message: handWritten });
      assert.deepEqual(brokenAt(`${lines[0]}\n[1,2]\n`), { line: 2, message: handWritten });
      assert.deepEqual(brokenAt(`${lines[0]}\n{"a":1,}\n`), { line: 2, message: 'is not valid JSON' });
      assert.deepEqual(brokenAt(`${lines[0]}\n\n${lines[1]}\n`), { line: 2, message: 'is not valid JSON' });
    });
  });

  test('a last line without its newline', async () => {
    await withTemp(async (dir) => {
      const text = fs.readFileSync(await ledgerOf(dir, 2), 'utf8');
      assert.deepEqual(brokenAt(text.slice(0, -1)), { line: 2, message: 'the last line is incomplete (a write was cut short, or the file was edited)' });
      assert.deepEqual(brokenAt(text.slice(0, -20)), { line: 2, message: 'the last line is incomplete (a write was cut short, or the file was edited)' });
    });
  });

  test('removing the newest entries is caught only by comparing the newest hash', async () => {
    await withTemp(async (dir) => {
      const file = await ledgerOf(dir, 3);
      const full = checkLedger(fs.readFileSync(file, 'utf8'));
      const cut = checkLedger(`${linesOf(file).slice(0, 2).join('\n')}\n`);
      assert.equal(cut.problem, undefined);
      assert.equal(cut.entries, 2);
      assert.notEqual(cut.head, full.head);
    });
  });

  test('an append refuses a broken chain and leaves the file as it was', async () => {
    await withTemp(async (dir) => {
      const file = await ledgerOf(dir, 2);
      const entries = entriesOf(file);
      entries[1].verdict = 'VERIFIED';
      fs.writeFileSync(file, textOf(entries));
      const before = fs.readFileSync(file);
      await assert.rejects(appendToLedger(file, fields(3)), {
        message: `${file} is broken at line 2: does not match its own hash (this entry was edited); nothing was added`,
      });
      assert.deepEqual(fs.readFileSync(file), before);
      assert.equal(fs.existsSync(`${file}.lock`), false);
    });
  });
});
