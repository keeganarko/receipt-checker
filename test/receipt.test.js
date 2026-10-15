import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_TIMEOUT_SECONDS, isList, isObject, kindOf, pathProblem, readReceipt } from '../src/receipt.js';
import { FORMAT, positionOf } from './helpers.js';

const COMMIT = 'a'.repeat(40);
const good = (more = {}) => ({ receipt: FORMAT, status: 'PASS', commit: COMMIT, checks: [{ id: 'tests', run: 'npm test' }], ...more });
const withCheck = (fields) => good({ checks: [{ id: 'tests', run: 'npm test', ...fields }] });

// Every problem as [path, message], in the order reported.
function problems(doc) {
  const r = readReceipt(typeof doc === 'string' ? doc : JSON.stringify(doc));
  assert.ok(r.errors, `expected problems, got a valid receipt: ${JSON.stringify(r.receipt)}`);
  assert.equal(r.receipt, undefined);
  return r.errors.map((e) => [e.path, e.message]);
}
const only = (doc, path, message) => assert.deepEqual(problems(doc), [[path, message]]);
const valid = (doc) => {
  const r = readReceipt(typeof doc === 'string' ? doc : JSON.stringify(doc));
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  return r.receipt;
};

describe('receipt: valid receipts', () => {
  test('a minimal receipt gets its defaults filled in', () => {
    assert.deepEqual(valid(good()), {
      receipt: FORMAT,
      status: 'PASS',
      commit: COMMIT,
      checks: [{ id: 'tests', run: 'npm test', format: 'exit-code', file: null, counts: null, timeout_seconds: DEFAULT_TIMEOUT_SECONDS, env: {} }],
      delivered: [],
      done_when: [],
      note: null,
    });
    assert.equal(DEFAULT_TIMEOUT_SECONDS, 600);
  });

  test('a full receipt keeps every field', () => {
    const r = valid(good({
      checks: [
        { id: 'unit', run: 'node --test', format: 'tap', counts: { passed: 4, failed: 0, skipped: 2 }, timeout_seconds: 86400, env: { CI: '1', _X9: '' } },
        { id: 'xml.report-1', run: 'make junit', format: 'junit', file: 'out/report.xml', counts: { passed: 0, failed: 0, skipped: 0 }, timeout_seconds: 1 },
        { id: 'lint', run: 'npm run lint', format: 'exit-code' },
      ],
      delivered: ['src/a.js', 'docs'],
      done_when: [{ id: 'r1', text: 'unit tests pass', check: 'unit' }],
      note: 'hello',
    }));
    assert.deepEqual(r.checks.map((c) => [c.id, c.format, c.file, c.counts, c.timeout_seconds, c.env]), [
      ['unit', 'tap', null, { passed: 4, failed: 0, skipped: 2 }, 86400, { CI: '1', _X9: '' }],
      ['xml.report-1', 'junit', 'out/report.xml', { passed: 0, failed: 0, skipped: 0 }, 1, {}],
      ['lint', 'exit-code', null, null, 600, {}],
    ]);
    assert.deepEqual(r.delivered, ['src/a.js', 'docs']);
    assert.deepEqual(r.done_when, [{ id: 'r1', text: 'unit tests pass', check: 'unit' }]);
    assert.equal(r.note, 'hello');
  });

  test('a 64-character commit id (a SHA-256 repository) is accepted', () => {
    assert.equal(valid(good({ commit: 'b'.repeat(64) })).commit, 'b'.repeat(64));
  });

  test('an id of 64 characters is accepted; 65 is not', () => {
    assert.equal(valid(withCheck({ id: `a${'b'.repeat(63)}` })).checks[0].id.length, 64);
    const long = `a${'b'.repeat(64)}`;
    only(withCheck({ id: long }), 'checks[0].id', `"${long}" is not a usable id: use up to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit`);
  });

  test('an environment variable named __proto__ reaches the check environment', () => {
    const r = valid('{"receipt": "receipt-check/1", "status": "PASS", "commit": "' + COMMIT + '", "checks": [{"id": "t", "run": "true", "env": {"__proto__": "yes", "A": "b"}}]}');
    const env = r.checks[0].env;
    assert.deepEqual(Object.keys(env), ['__proto__', 'A']);
    assert.equal(Object.getOwnPropertyDescriptor(env, '__proto__').value, 'yes');
    assert.equal(Object.getPrototypeOf(env), Object.prototype);
    assert.equal({ ...env }.A, 'b');
    assert.equal(Object.getOwnPropertyDescriptor({ ...env }, '__proto__').value, 'yes');
  });
});

describe('receipt: the top level', () => {
  test('a receipt must be one object', () => {
    only('[]', '', 'a receipt is one JSON object ({ ... }), not a list');
    only('"x"', '', 'a receipt is one JSON object ({ ... }), not a string ("x")');
    only('null', '', 'a receipt is one JSON object ({ ... }), not null');
    only('5', '', 'a receipt is one JSON object ({ ... }), not the number 5');
    only('true', '', 'a receipt is one JSON object ({ ... }), not true');
  });

  test('each required key that is missing is named, with a hint', () => {
    assert.deepEqual(problems('{}'), [
      ['', 'missing "receipt": add "receipt": "receipt-check/1"'],
      ['', 'missing "status": add "status": "PASS"'],
      ['', 'missing "commit": add the full commit id that git rev-parse HEAD prints'],
      ['', 'missing "checks": add the checks to rerun, such as [{ "id": "tests", "run": "npm test" }]'],
    ]);
  });

  test('a JSON syntax error is reported alone, with its position', () => {
    const r = readReceipt('{\n  "receipt": "receipt-check/1",\n  "status": "PASS",,\n}');
    assert.deepEqual(r.errors, [{ path: null, line: 3, column: 20, message: 'expected a key in double quotes, found ","' }]);
  });

  test('unknown keys: an alias, a near miss, or the list of keys', () => {
    only({ ...good(), sha: 'x' }, 'sha', 'unknown key "sha"; did you mean "commit"?');
    only({ ...good(), stauts: 'x' }, 'stauts', 'unknown key "stauts"; did you mean "status"?');
    only({ ...good(), doneWhen: [] }, 'doneWhen', 'unknown key "doneWhen"; did you mean "done_when"?');
    only({ ...good(), 'done-when': [] }, '["done-when"]', 'unknown key "done-when"; did you mean "done_when"?');
    only({ ...good(), deliverables: [] }, 'deliverables', 'unknown key "deliverables"; did you mean "delivered"?');
    only({ ...good(), zzzzzzzz: 1 }, 'zzzzzzzz', 'unknown key "zzzzzzzz"; the keys here are receipt, status, commit, checks, delivered, done_when, note');
  });

  test('inherited property names are unknown keys like any other', () => {
    const text = `{"receipt": "${FORMAT}", "status": "PASS", "commit": "${COMMIT}", "checks": [{"id": "t", "run": "true"}], "__proto__": 1, "constructor": 2, "toString": 3}`;
    const all = 'the keys here are receipt, status, commit, checks, delivered, done_when, note';
    assert.deepEqual(problems(text), [
      ['__proto__', `unknown key "__proto__"; ${all}`],
      ['constructor', `unknown key "constructor"; ${all}`],
      ['toString', `unknown key "toString"; ${all}`],
    ]);
    assert.equal(Object.prototype.receipt, undefined);
  });

  test('"receipt" names the format', () => {
    only(good({ receipt: 'receipt-check/2' }), 'receipt', 'this checker reads receipt-check/1, and this receipt is receipt-check/2');
    only(good({ receipt: 'receipt-check/v1' }), 'receipt', 'must be "receipt-check/1", not a string ("receipt-check/v1")');
    only(good({ receipt: 1 }), 'receipt', 'must be "receipt-check/1", not the number 1');
  });

  test('"status" must be PASS', () => {
    only(good({ status: 'pass' }), 'status', 'write "PASS" in capitals');
    only(good({ status: 'FAIL' }), 'status', 'must be "PASS", not a string ("FAIL"): a receipt claims that work is done, and a failure needs no proof');
    only(good({ status: true }), 'status', 'must be "PASS", not true: a receipt claims that work is done, and a failure needs no proof');
  });

  test('"commit" must be a full lowercase commit id', () => {
    only(good({ commit: 123 }), 'commit', 'must be the full commit id as a string, not the number 123');
    only(good({ commit: 'A'.repeat(40) }), 'commit', 'write the id in lowercase, as git prints it');
    only(good({ commit: 'abc1234' }), 'commit', '"abc1234" is a short id; give all 40 characters (git rev-parse abc1234)');
    only(good({ commit: 'HEAD' }), 'commit', '"HEAD" is not a full commit id: give the 40 hex characters that git rev-parse prints, since a branch, a tag or HEAD can move');
    only(good({ commit: 'abc' }), 'commit', '"abc" is not a full commit id: give the 40 hex characters that git rev-parse prints, since a branch, a tag or HEAD can move');
    only(good({ commit: 'a'.repeat(41) }), 'commit', `"${'a'.repeat(41)}" is not a full commit id: give the 40 hex characters that git rev-parse prints, since a branch, a tag or HEAD can move`);
    only(good({ commit: 'g'.repeat(40) }), 'commit', `"${'g'.repeat(40)}" is not a full commit id: give the 40 hex characters that git rev-parse prints, since a branch, a tag or HEAD can move`);
  });

  test('"note" must be a string', () => {
    only(good({ note: 5 }), 'note', 'must be a string, not the number 5');
  });
});

describe('receipt: checks', () => {
  test('"checks" is a non-empty list of at most 100', () => {
    only(good({ checks: {} }), 'checks', 'must be a list of checks, not an object');
    only(good({ checks: [] }), 'checks', 'is empty: a receipt needs at least one check to rerun');
    const many = [];
    for (let n = 0; n < 101; n++) many.push({ id: `c${n}`, run: 'true' });
    only(good({ checks: many }), 'checks', 'has 101 checks; the limit is 100');
    assert.equal(valid(good({ checks: many.slice(0, 100) })).checks.length, 100);
  });

  test('each check is an object with an id and a run', () => {
    only(good({ checks: [1] }), 'checks[0]', 'each check is an object such as { "id": "tests", "run": "npm test" }, not the number 1');
    assert.deepEqual(problems(good({ checks: [{}] })), [['checks[0]', 'missing "id"'], ['checks[0]', 'missing "run"']]);
  });

  test('check ids are unique and usable', () => {
    only(good({ checks: [{ id: 't', run: 'a' }, { id: 't', run: 'b' }] }), 'checks[1].id', 'check id "t" is used twice (also at checks[0])');
    only(withCheck({ id: 5 }), 'checks[0].id', 'must be a string, not the number 5');
    only(withCheck({ id: '-x' }), 'checks[0].id', '"-x" is not a usable id: use up to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit');
    only(withCheck({ id: 'a b' }), 'checks[0].id', '"a b" is not a usable id: use up to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit');
  });

  test('"run" is a non-empty shell command without NUL', () => {
    only(withCheck({ run: 5 }), 'checks[0].run', 'must be a shell command as a string, not the number 5');
    only(withCheck({ run: '  ' }), 'checks[0].run', 'is empty: give the shell command to rerun');
    only(withCheck({ run: 'a\u0000b' }), 'checks[0].run', 'contains a NUL character');
  });

  test('"format" is tap, junit or exit-code', () => {
    assert.deepEqual(problems(withCheck({ format: 'TAP' })), [['checks[0].format', 'write "tap" in lowercase']]);
    only(withCheck({ format: 'xml' }), 'checks[0].format', 'must be "tap", "junit" or "exit-code", not a string ("xml")');
    only(withCheck({ format: 'tap' }), 'checks[0]', 'missing "counts": format "tap" compares the passed, failed and skipped numbers you claim with the ones the rerun reports');
    only(withCheck({ format: 'junit' }), 'checks[0]', 'missing "counts": format "junit" compares the passed, failed and skipped numbers you claim with the ones the rerun reports');
  });

  test('an unknown format does not also complain about its counts or file', () => {
    only(withCheck({ format: 'xml', file: 'r.xml', counts: { passed: 1, failed: 0, skipped: 0 } }), 'checks[0].format', 'must be "tap", "junit" or "exit-code", not a string ("xml")');
  });

  test('"file" is a clean relative path, read only for tap and junit', () => {
    only(withCheck({ file: 'r.xml' }), 'checks[0].file', '"file" is only read when "format" is "tap" or "junit"');
    only(withCheck({ format: 'junit', file: '/abs.xml', counts: { passed: 0, failed: 0, skipped: 0 } }), 'checks[0].file', '"/abs.xml" is absolute; write it relative to the repository root');
    only(withCheck({ format: 'tap', file: 7, counts: { passed: 0, failed: 0, skipped: 0 } }), 'checks[0].file', 'must be a path as a string, not the number 7');
  });

  test('"counts" are three whole numbers, and only for tap and junit', () => {
    const tap = (counts) => withCheck({ format: 'tap', counts });
    only(withCheck({ counts: { passed: 1, failed: 0, skipped: 0 } }), 'checks[0].counts', '"counts" need "format": "tap" or "junit"; with "exit-code" only the exit status is checked');
    only(tap([]), 'checks[0].counts', 'must be an object such as { "passed": 10, "failed": 0, "skipped": 0 }, not a list');
    assert.deepEqual(problems(tap({ passed: 1 })), [
      ['checks[0].counts', 'missing "failed": give passed, failed and skipped, even when one is 0'],
      ['checks[0].counts', 'missing "skipped": give passed, failed and skipped, even when one is 0'],
    ]);
    only(tap({ passed: -1, failed: 0, skipped: 0 }), 'checks[0].counts.passed', 'must be a whole number of 0 or more, not the number -1');
    only(tap({ passed: 1.5, failed: 0, skipped: 0 }), 'checks[0].counts.passed', 'must be a whole number of 0 or more, not the number 1.5');
    only(tap({ passed: 1, failed: 0, skipped: '3' }), 'checks[0].counts.skipped', 'must be a whole number of 0 or more, not a string ("3")');
    only(tap({ passed: 2 ** 53, failed: 0, skipped: 0 }), 'checks[0].counts.passed', `must be a whole number of 0 or more, not the number ${2 ** 53}`);
    only(tap({ passed: 1, failed: 0, skipped: 0, total: 1 }), 'checks[0].counts.total', 'unknown key "total"; did you mean "passed"?');
    assert.deepEqual(problems(tap({ pass: 1, failed: 0, skipped: 0 })), [
      ['checks[0].counts.pass', 'unknown key "pass"; did you mean "passed"?'],
      ['checks[0].counts', 'missing "passed": give passed, failed and skipped, even when one is 0'],
    ]);
  });

  test('a PASS receipt cannot claim failed tests', () => {
    only(withCheck({ format: 'tap', counts: { passed: 3, failed: 1, skipped: 0 } }), 'checks[0].counts.failed', "is 1, but a PASS receipt can't have failed tests");
    const notPass = { ...withCheck({ format: 'tap', counts: { passed: 3, failed: 1, skipped: 0 } }), status: 'FAIL' };
    assert.deepEqual(problems(notPass).map(([p]) => p), ['status']);
  });

  test('"timeout_seconds" is a whole number from 1 to 86400', () => {
    for (const bad of [0, 86401, 2.5, '10', null]) {
      only(withCheck({ timeout_seconds: bad }), 'checks[0].timeout_seconds', `must be a whole number of seconds from 1 to 86400, not ${kindOf(bad)}`);
    }
    assert.equal(valid(withCheck({ timeout_seconds: 1 })).checks[0].timeout_seconds, 1);
  });

  test('"env" is an object of usable names and string values', () => {
    only(withCheck({ env: [] }), 'checks[0].env', 'must be an object of NAME: "value" pairs, not a list');
    only(withCheck({ env: { '1X': 'a' } }), 'checks[0].env["1X"]', '"1X" is not a usable environment variable name');
    only(withCheck({ env: { 'A-B': 'a' } }), 'checks[0].env["A-B"]', '"A-B" is not a usable environment variable name');
    only(withCheck({ env: { A: 1 } }), 'checks[0].env.A', 'must be a string, not the number 1');
    only(withCheck({ env: { A: 'x\u0000' } }), 'checks[0].env.A', 'contains a NUL character');
  });

  test('unknown check keys suggest the right one', () => {
    for (const [alias, key] of [['command', 'run'], ['cmd', 'run'], ['script', 'run'], ['timeout', 'timeout_seconds'], ['reporter', 'format'], ['report', 'file'], ['name', 'id']]) {
      only(withCheck({ [alias]: 'x' }), `checks[0].${alias}`, `unknown key "${alias}"; did you mean "${key}"?`);
    }
  });
});

describe('receipt: delivered and done_when', () => {
  test('"delivered" is a list of clean relative paths, each once', () => {
    only(good({ delivered: {} }), 'delivered', 'must be a list of paths, not an object');
    only(good({ delivered: ['a', 'a'] }), 'delivered[1]', '"a" is listed twice');
    const cases = [
      [5, 'must be a path as a string, not the number 5'],
      ['', 'is empty'],
      ['a\tb', '"a\\tb" contains a control character'],
      ['a\u007fb', '"a\u007fb" contains a control character'],
      ['a\\b', '"a\\b" uses \\; write / between folders'],
      ['/etc/passwd', '"/etc/passwd" is absolute; write it relative to the repository root'],
      ['docs/', '"docs/" ends with /; drop it'],
      ['a//b', '"a//b" has an empty folder name (//)'],
      ['./a', '"./a" contains "."; write the plain path from the repository root'],
      ['a/../b', '"a/../b" contains ".."; write the plain path from the repository root'],
      ['..', '".." contains ".."; write the plain path from the repository root'],
    ];
    for (const [p, message] of cases) {
      only(good({ delivered: [p] }), 'delivered[0]', message);
      assert.equal(pathProblem(p), message);
    }
    assert.equal(pathProblem('src/a b/c.js'), null);
  });

  test('"done_when" items have an id, a text and a check that exists', () => {
    only(good({ done_when: {} }), 'done_when', 'must be a list of items, not an object');
    only(good({ done_when: [1] }), 'done_when[0]', 'each item is an object such as { "id": "r1", "text": "tests pass", "check": "tests" }, not the number 1');
    assert.deepEqual(problems(good({ done_when: [{}] })), [
      ['done_when[0]', 'missing "id"'],
      ['done_when[0]', 'missing "text"'],
      ['done_when[0]', 'missing "check"'],
    ]);
    const item = (fields) => good({ done_when: [{ id: 'r1', text: 'tests pass', check: 'tests', ...fields }] });
    only(item({ text: '  ' }), 'done_when[0].text', 'is empty: say what was promised');
    only(item({ text: 5 }), 'done_when[0].text', 'must be a string, not the number 5');
    only(item({ check: 5 }), 'done_when[0].check', 'must name a check id as a string, not the number 5');
    only(item({ check: 'nope' }), 'done_when[0].check', 'names check "nope", but no check has that id (checks: tests)');
    only(item({ id: 'bad id' }), 'done_when[0].id', '"bad id" is not a usable id: use up to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit');
    only(item({ description: 'x' }), 'done_when[0].description', 'unknown key "description"; did you mean "text"?');
    const twice = good({ done_when: [{ id: 'r1', text: 'a', check: 'tests' }, { id: 'r1', text: 'b', check: 'tests' }] });
    only(twice, 'done_when[1].id', 'done-when id "r1" is used twice');
    const dupes = good({ checks: [{ id: 't', run: 'a' }, { id: 't', run: 'b' }], done_when: [{ id: 'r1', text: 'a', check: 'nope' }] });
    assert.deepEqual(problems(dupes), [
      ['checks[1].id', 'check id "t" is used twice (also at checks[0])'],
      ['done_when[0].check', 'names check "nope", but no check has that id (checks: t)'],
    ]);
  });
});

describe('receipt: every problem at once, with line and column', () => {
  test('each problem points at its value, or at the key for an unknown key', () => {
    const text = [
      '{',
      '  "receipt": "receipt-check/1",',
      '  "status": "pass",',
      '  "commit": "abc1234",',
      '  "checks": [',
      '    { "id": "unit", "run": "node --test", "format": "tap",',
      '      "counts": { "passed": -1, "failed": 0, "skipped": 0 } },',
      '    { "id": "lint", "cmd": "make" }',
      '  ],',
      '  "delivered": ["/abs"],',
      '  "done_when": [{ "id": "r1", "text": "", "check": "nope" }]',
      '}',
    ].join('\n');
    const r = readReceipt(text);
    const at = (needle, from) => positionOf(text, needle, from);
    const second = text.indexOf('{ "id": "lint", "cmd"');
    assert.deepEqual(r.errors, [
      { path: 'status', ...at('"pass"'), message: 'write "PASS" in capitals' },
      { path: 'commit', ...at('"abc1234"'), message: '"abc1234" is a short id; give all 40 characters (git rev-parse abc1234)' },
      { path: 'checks[0].counts.passed', ...at('-1'), message: 'must be a whole number of 0 or more, not the number -1' },
      { path: 'checks[1].cmd', ...at('"cmd"'), message: 'unknown key "cmd"; did you mean "run"?' },
      { path: 'checks[1]', ...at('{', second), message: 'missing "run"' },
      { path: 'delivered[0]', ...at('"/abs"'), message: '"/abs" is absolute; write it relative to the repository root' },
      { path: 'done_when[0].text', ...at('""'), message: 'is empty: say what was promised' },
      { path: 'done_when[0].check', ...at('"nope"'), message: 'names check "nope", but no check has that id (checks: unit, lint)' },
    ]);
    assert.deepEqual(at('"pass"'), { line: 3, column: 13 });
    assert.deepEqual(at('"cmd"'), { line: 8, column: 21 });
  });

  test('at most 50 problems are listed', () => {
    const extra = {};
    for (let n = 0; n < 60; n++) extra[`zz${n}`] = n;
    assert.equal(problems({ ...good(), ...extra }).length, 50);
  });
});

describe('receipt: helpers', () => {
  test('isList and isObject tell the two JSON containers apart', () => {
    assert.equal(isList([]), true);
    assert.equal(isList({}), false);
    assert.equal(isList('ab'), false);
    assert.equal(isList(null), false);
    assert.equal(isObject({}), true);
    assert.equal(isObject(Object.create(null)), true);
    assert.equal(isObject([]), false);
    assert.equal(isObject(null), false);
  });

  test('kindOf describes a value for a message, shortening long strings', () => {
    assert.equal(kindOf(null), 'null');
    assert.equal(kindOf([1]), 'a list');
    assert.equal(kindOf({}), 'an object');
    assert.equal(kindOf(false), 'false');
    assert.equal(kindOf(2), 'the number 2');
    assert.equal(kindOf('x'.repeat(40)), `a string ("${'x'.repeat(40)}")`);
    assert.equal(kindOf('x'.repeat(41)), `a string ("${'x'.repeat(40)}…")`);
  });
});
