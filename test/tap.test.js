import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseTap } from '../src/tap.js';
import { fixture } from './helpers.js';

const tap = (...lines) => `${lines.join('\n')}\n`;
function counts(text) {
  const r = parseTap(text);
  assert.equal(r.problem, undefined, r.problem);
  return r.counts;
}
function problemOf(text) {
  const r = parseTap(text);
  assert.equal(r.counts, undefined, `expected a problem, got ${JSON.stringify(r.counts)}`);
  return r.problem;
}
const c = (passed, failed, skipped) => ({ passed, failed, skipped });

describe('tap: real Node output', () => {
  test('a Node test runner stream counts its leaf tests: 4 passed, 0 failed, 2 skipped', () => {
    const text = fixture('node-tap.txt');
    assert.deepEqual(parseTap(text), { counts: c(4, 0, 2), bailOut: null });
  });

  test('the same stream with CRLF line ends counts the same', () => {
    const text = fixture('node-tap.txt').replace(/\n/g, '\r\n');
    assert.ok(text.includes('\r\n  ...\r\n'));
    assert.deepEqual(parseTap(text), { counts: c(4, 0, 2), bailOut: null });
  });

  test('the same stream cut short anywhere is a problem, never a count', () => {
    const lines = fixture('node-tap.txt').split('\n');
    const planAt = lines.indexOf('1..3');
    for (let n = 1; n <= planAt; n++) {
      const r = parseTap(lines.slice(0, n).join('\n'));
      assert.ok(r.problem, `cut after line ${n}: ${JSON.stringify(r)}`);
    }
  });
});

describe('tap: plans', () => {
  test('a flat stream with a closing plan', () => {
    assert.deepEqual(counts(tap('TAP version 14', 'ok 1 - a', 'not ok 2 - b', 'ok 3 - c # SKIP', '1..3')), c(1, 1, 1));
  });

  test('a leading plan', () => {
    assert.deepEqual(counts(tap('1..2', 'ok 1', 'ok 2')), c(2, 0, 0));
  });

  test('a test line after the closing plan', () => {
    assert.equal(problemOf(tap('ok 1', '1..1', 'ok 2')), 'line 3: a test line after the closing plan');
  });

  test('a plan that disagrees with the tests that ran', () => {
    assert.equal(problemOf(tap('ok 1', 'ok 2', '1..3')), 'the plan says 3 tests, but 2 reported');
    assert.equal(problemOf(tap('1..3', 'ok 1', 'ok 2')), 'the plan says 3 tests, but 2 reported');
    assert.equal(problemOf(tap('# Subtest: g', '    ok 1 - a', '    1..2', 'ok 1 - g', '1..1')), 'line 4: a block of subtests: the plan says 2 tests, but 1 reported');
  });

  test('no plan', () => {
    const none = 'no plan line (1..N); the output may have been cut short, or it is not TAP';
    assert.equal(problemOf(tap('ok 1', 'ok 2')), none);
    assert.equal(problemOf(''), none);
    assert.equal(problemOf(tap('hello', 'world')), none);
    assert.equal(problemOf(tap('TAP version 13')), none);
    assert.equal(problemOf(tap('    ok 1 - a', 'ok 1 - g', '1..1')), 'line 2: a block of subtests: no plan line (1..N)');
  });

  test('1..0 is an empty run', () => {
    assert.deepEqual(counts(tap('TAP version 13', '1..0')), c(0, 0, 0));
    assert.deepEqual(counts(tap('1..0 # SKIP nothing to run')), c(0, 0, 0));
    assert.equal(problemOf(tap('1..0', 'ok 1')), 'the plan says 0 tests, but 1 reported');
  });

  test('two streams in one output', () => {
    assert.equal(problemOf(tap('TAP version 13', 'ok 1', '1..1', 'TAP version 13', 'ok 1', '1..1')),
      'line 4: a second "TAP version" line; two TAP streams in one output? Give each its own check');
    assert.equal(problemOf(tap('1..1', 'ok 1', '1..1', 'ok 1')),
      'line 3: a second plan line; two TAP streams in one output? Give each its own check');
    assert.equal(problemOf(tap('    1..1', '    ok 1', '    1..1', 'ok 1', '1..1')), 'line 3: a second plan line');
  });

  test('only TAP versions 13 and 14 are read', () => {
    assert.equal(problemOf(tap('TAP version 12', 'ok 1', '1..1')), 'line 1: TAP version 12 is not supported (13 and 14 are)');
    assert.deepEqual(counts(tap('TAP version 13', 'ok 1', '1..1')), c(1, 0, 0));
  });
});

describe('tap: test lines', () => {
  test('numbers must run in order; unnumbered lines are fine', () => {
    assert.equal(problemOf(tap('ok 1', 'ok 3', '1..2')), 'line 2: test number 3 where 2 was expected');
    assert.equal(problemOf(tap('ok 2', '1..1')), 'line 1: test number 2 where 1 was expected');
    assert.deepEqual(counts(tap('ok', 'not ok - b', 'ok 3 - c', '1..3')), c(2, 1, 0));
  });

  test('numbering starts again inside each block of subtests', () => {
    assert.deepEqual(counts(tap('    ok 1 - a', '    ok 2 - b', '    1..2', 'ok 1 - g', '    ok 1 - c', '    1..1', 'ok 2 - h', '1..2')), c(3, 0, 0));
  });

  test('lines that are not TAP are ignored', () => {
    assert.deepEqual(counts(tap('compiling...', 'okay then', 'ok1 - glued', '# ok 9 - a comment', 'ok 1 - real', 'notok 2', '1..1', 'done.')), c(1, 0, 0));
  });

  test('directives: SKIP and TODO, in any case, even on not ok', () => {
    const text = tap(
      'ok 1 - a # SKIP slow',
      'not ok 2 - b # TODO later',
      'ok 3 - c # skip',
      'ok 4 - d #SKIP',
      'ok 5 - e # skipped: no network',
      'not ok 6 - f # todo',
      'ok 7 - # TODO',
      '1..7',
    );
    assert.deepEqual(counts(text), c(0, 0, 7));
  });

  test('directives: an escaped \\# is not one, and a later # still is', () => {
    const text = tap(
      'ok 1 - d \\# SKIP is part of the name',
      'not ok 2 - issue #5 # SKIP',
      'not ok 3 - issue #5 is fixed',
      'ok 4 - the word SKIP alone',
      'ok 5 - # not a directive',
      'not ok 6 - backslash \\\\# SKIP',
      'ok 7 - a \\#5 b # TODO',
      '1..7',
    );
    assert.deepEqual(counts(text), c(3, 1, 3));
  });
});

describe('tap: YAML blocks', () => {
  test('lines inside a YAML block are never counted', () => {
    const text = tap(
      'TAP version 13',
      'not ok 1 - real failure',
      '  ---',
      '  message: |',
      '    ok 2 - fake',
      '    not ok 3 - fake',
      'ok 4 - fake at the edge',
      '    1..9',
      '    Bail out! fake',
      '    TAP version 13',
      '  ...',
      '1..1',
    );
    assert.deepEqual(parseTap(text), { counts: c(0, 1, 0), bailOut: null });
  });

  test('a YAML block in a subtest ends at its own indentation', () => {
    const text = tap(
      '# Subtest: g',
      '    ok 1 - a',
      '      ---',
      '      note: |',
      '  ...',
      '        ok 2 - fake',
      '      ...',
      '    1..1',
      'ok 1 - g',
      '1..1',
    );
    assert.deepEqual(counts(text), c(1, 0, 0));
  });

  test('--- is only a YAML block right after a test line, two spaces in', () => {
    assert.equal(problemOf(tap('ok 1', '# comment', '  ---', '  ok 2', '  ...', '1..1')), 'line 4: a test line indented by 2 spaces; subtests are indented in steps of 4');
  });

  test('output that ends inside a YAML block', () => {
    assert.equal(problemOf(tap('not ok 1 - x', '  ---', '  message: boom')), 'the output ends inside a YAML block; was it cut short?');
  });
});

describe('tap: subtests', () => {
  test('a group is not counted; its leaves are', () => {
    const text = tap('# Subtest: g', '    ok 1 - a', '    not ok 2 - b', '    1..2', 'not ok 1 - g', '1..1');
    assert.deepEqual(counts(text), c(1, 1, 0));
  });

  test('a group that failed with no failing leaf counts as one failure', () => {
    assert.deepEqual(counts(tap('# Subtest: g', '    ok 1 - a', '    1..1', 'not ok 1 - g', '1..1')), c(1, 1, 0));
    assert.deepEqual(counts(tap('    1..0', 'not ok 1 - empty group with a failing hook', '1..1')), c(0, 1, 0));
  });

  test('a skipped group with a failing hook does not add a failure', () => {
    assert.deepEqual(counts(tap('    ok 1 - a # SKIP', '    1..1', 'not ok 1 - g # SKIP', '1..1')), c(0, 0, 1));
  });

  test('a block whose first child is a block opens two levels at once', () => {
    const text = tap(
      '        ok 1 - leaf',
      '        ok 2 - leaf # TODO',
      '        1..2',
      '    ok 1 - inner',
      '    ok 2 - sibling leaf',
      '    1..2',
      'ok 1 - outer',
      'ok 2 - top leaf',
      '1..2',
    );
    assert.deepEqual(counts(text), c(3, 0, 1));
  });

  test('real Node output for describe() > describe() > it() counts its leaves', () => {
    assert.deepEqual(parseTap(fixture('node-tap-nested.txt')), { counts: c(2, 0, 0), bailOut: null });
  });

  test('each level opened at once still needs its own plan and test line', () => {
    assert.equal(problemOf(tap('        ok 1 - leaf', '        1..1', 'ok 1 - outer', '1..1')), 'line 3: a block of subtests: no plan line (1..N)');
    assert.equal(problemOf(tap('        ok 1 - leaf', '        1..1', '    1..1', 'ok 1 - outer', '1..1')), 'line 3: a block of subtests is followed by a plan instead of its test line');
    assert.equal(problemOf(tap('        ok 1 - leaf', '        1..1', '    ok 1 - inner')), 'the output ends inside a block of subtests; was it cut short?');
  });

  test('a block that ends without its own test line', () => {
    const text = tap('    ok 1 - a', '        ok 1 - b', '        1..1', '    1..1', 'ok 1 - g', '1..1');
    assert.equal(problemOf(text), 'line 4: a block of subtests is followed by a plan instead of its test line');
    const skipLevel = tap('    1..1', '    ok 1 - a', '        ok 1 - c', '        1..1', 'ok 1 - g', '1..1');
    assert.equal(problemOf(skipLevel), 'line 5: a block of subtests ended without its own test line');
  });

  test('a block followed by a plan instead of its test line', () => {
    assert.equal(problemOf(tap('    ok 1 - a', '    1..1', '1..1')), 'line 3: a block of subtests is followed by a plan instead of its test line');
  });

  test('output that ends inside a block of subtests', () => {
    assert.equal(problemOf(tap('# Subtest: g', '    ok 1 - a', '    1..1')), 'the output ends inside a block of subtests; was it cut short?');
  });

  test('odd indentation', () => {
    assert.equal(problemOf(tap('  ok 1', '1..1')), 'line 1: a test line indented by 2 spaces; subtests are indented in steps of 4');
    assert.equal(problemOf(tap('ok 1', '   1..1')), 'line 2: a plan line indented by 3 spaces; subtests are indented in steps of 4');
  });
});

describe('tap: Bail out!', () => {
  test('a bail-out stops reading and keeps the counts so far', () => {
    assert.deepEqual(parseTap(tap('ok 1', 'not ok 2', 'Bail out! database down', 'ok 3', '1..9')), { counts: c(1, 1, 0), bailOut: 'database down' });
    assert.deepEqual(parseTap(tap('ok 1', 'Bail out!')), { counts: c(1, 0, 0), bailOut: 'no reason given' });
  });

  test('a bail-out inside an open block counts the open block too', () => {
    const text = tap('ok 1 - a', '# Subtest: g', '    ok 1 - b', '    ok 2 - c # SKIP', '    Bail out! out of memory');
    assert.deepEqual(parseTap(text), { counts: c(2, 0, 1), bailOut: 'out of memory' });
  });

  test('"Bail out!" inside a test name is not a bail-out', () => {
    assert.deepEqual(parseTap(tap('ok 1 - prints Bail out! correctly', '1..1')), { counts: c(1, 0, 0), bailOut: null });
  });
});
