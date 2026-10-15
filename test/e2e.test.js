// End to end: the real CLI, run as its own process, against real temporary
// git repositories.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { exportCommit } from '../src/git.js';
import { offlineSupport } from '../src/run.js';
import {
  FORMAT, VERSION, alive, commit, findingCodes, fixture, git, leftovers, makeRepo, readPid, reasonCodes, receiptFor,
  sandbox, sha256, strictBash, waitFor, withTemp,
} from './helpers.js';

const short = (id) => id.slice(0, 12);
const messageOf = (report, code) => report.findings.find((f) => f.code === code)?.message;
const PASSING = { 'check.sh': 'echo "all good"\n' };
const passingCheck = { id: 'tests', run: 'bash check.sh' };

// Extracts `git archive` of a commit into a new folder, to compare with.
function archive(repo, commitId, dest) {
  fs.mkdirSync(dest);
  const tarball = git(repo, ['archive', '--format=tar', commitId], { raw: true });
  const r = spawnSync('tar', ['-xf', '-', '-C', dest], { input: tarball });
  assert.equal(r.status, 0, `tar: ${r.stderr}`);
  return dest;
}

describe('e2e: verdicts', () => {
  test('a true receipt is VERIFIED', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, PASSING);
      const receipt = receiptFor(head, [passingCheck], {
        delivered: ['check.sh'],
        done_when: [{ id: 'r1', text: 'the check passes', check: 'tests' }],
      });
      const r = await box.verify(receipt, { json: false });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const s = short(head);
      const lines = r.stdout.split('\n');
      assert.equal(lines[0], `VERIFIED: every claim in ${r.file} held at ${s}`);
      for (const line of [
        `  ✓ commit ${s} exists`,
        `  ✓ the 1 delivered path exists at ${s}`,
        `  ✓ exported 1 file from ${s} into a clean copy: no .git, nothing uncommitted or untracked`,
        `  ✓ done-when "r1" (the check passes) is met: check "tests" passed`,
        '  network: on (on Linux, --offline runs the checks without it)',
      ]) assert.ok(lines.includes(line), `missing line: ${line}\n${r.stdout}`);
      assert.ok(lines.some((l) => /^ {2}✓ check "tests" passed: exit 0 in [0-9]+\.[0-9] s$/.test(l)), r.stdout);
      assert.ok(r.stderr.includes(`receipt-check: exporting ${s} into a clean copy\n`), r.stderr);
      assert.ok(r.stderr.includes('receipt-check: running check "tests" (limit 600 s): bash check.sh\n'), r.stderr);
    });
  });

  test('the messages count files and paths in the right number', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, { ...PASSING, 'docs/a.md': 'a\n' });
      const r = await box.verify(receiptFor(head, [passingCheck], { delivered: ['check.sh', 'docs'] }));
      assert.equal(r.code, 0);
      assert.equal(messageOf(r.json, 'delivered-present'), `all 2 delivered paths exist at ${short(head)}`);
      assert.equal(messageOf(r.json, 'copy-made'), `exported 2 files from ${short(head)} into a clean copy: no .git, nothing uncommitted or untracked`);
      assert.match(messageOf(r.json, 'check-passed'), /^check "tests" passed: exit 0 in [0-9]+\.[0-9] s$/);
    });
  });

  test('a check that fails at the commit is REFUTED, and its output is shown', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, { 'check.sh': 'echo "about to fail"\necho "boom" >&2\nexit 3\n' });
      const r = await box.verify(receiptFor(head, [passingCheck]), { json: false });
      assert.equal(r.code, 1);
      const lines = r.stdout.split('\n');
      assert.equal(lines[0], `REFUTED: 1 claim in ${r.file} did not hold at ${short(head)}`);
      assert.equal(lines[1], '  ✗ check "tests" exited with 3');
      for (const line of ['  last lines of stdout from check "tests":', '    | about to fail', '  last lines of stderr from check "tests":', '    | boom']) {
        assert.ok(lines.includes(line), `missing line: ${line}\n${r.stdout}`);
      }
    });
  });

  test('a commit that does not exist is REFUTED', async () => {
    await sandbox(async (box) => {
      makeRepo(box.repo, PASSING);
      const missing = 'f'.repeat(40);
      const r = await box.verify(receiptFor(missing, [passingCheck], { done_when: [{ id: 'r1', text: 'works', check: 'tests' }] }));
      assert.equal(r.code, 1);
      assert.equal(r.json.verdict, 'REFUTED');
      assert.deepEqual(r.json.reasons, [{ code: 'commit-missing', message: `commit ${short(missing)} does not exist in this repository (if it was pushed somewhere else, fetch it first)` }]);
      assert.equal(r.json.checks[0].outcome, 'not-run');
      assert.equal(r.json.copy, null);
      assert.equal(messageOf(r.json, 'done-when-unproven'), 'done-when "r1" (works) is unproven: check "tests" was not run');
    });
  });

  test('an id that names a tree or a blob is REFUTED', async () => {
    await sandbox(async (box) => {
      makeRepo(box.repo, PASSING);
      const tree = git(box.repo, ['rev-parse', 'HEAD^{tree}']);
      const blob = git(box.repo, ['rev-parse', 'HEAD:check.sh']);
      for (const [id, type] of [[tree, 'tree'], [blob, 'blob']]) {
        const r = await box.verify(receiptFor(id, [passingCheck]));
        assert.equal(r.code, 1);
        assert.deepEqual(r.json.reasons, [{ code: 'not-a-commit', message: `${short(id)} names a ${type}, not a commit` }]);
        assert.equal(r.json.checks[0].outcome, 'not-run');
      }
    });
  });

  test('checks run in order, all of them, in one shared clean copy', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, PASSING);
      const r = await box.verify(receiptFor(head, [
        { id: 'first', run: 'echo one > state.txt; exit 1' },
        { id: 'second', run: 'test "$(cat state.txt)" = one' },
        { id: 'third', run: 'rm state.txt' },
      ]));
      assert.equal(r.code, 1);
      assert.deepEqual(r.json.checks.map((c) => [c.id, c.outcome]), [['first', 'failed'], ['second', 'passed'], ['third', 'passed']]);
      assert.deepEqual(r.json.reasons, [{ code: 'check-failed', message: 'check "first" exited with 1' }]);
    });
  });

  test('checks run under bash -e -o pipefail: `false | cat` fails', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, PASSING);
      const r = await box.verify(receiptFor(head, [
        { id: 'pipe', run: 'false | cat' },
        { id: 'errexit', run: 'false; true' },
        { id: 'pipefail-on', run: '! (false | cat)' },
        { id: 'signal', run: 'kill -KILL $$' },
      ]));
      assert.equal(r.code, 1);
      assert.deepEqual(r.json.checks.map((c) => c.outcome), ['failed', 'failed', 'passed', 'failed']);
      assert.deepEqual(r.json.reasons.map((x) => x.message), [
        'check "pipe" exited with 1',
        'check "errexit" exited with 1',
        'check "signal" was killed by SIGKILL',
      ]);
    });
  });
});

describe('e2e: what the clean copy holds', () => {
  test('a check that passes only because of an untracked file is REFUTED', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, { 'check.sh': 'test -f helper.txt\n' });
      fs.writeFileSync(path.join(box.repo, 'helper.txt'), 'untracked\n');
      assert.equal(git(box.repo, ['status', '--porcelain']), '?? helper.txt');
      assert.equal(strictBash(box.repo, 'bash check.sh'), 0, 'the check passes in the working tree');
      const r = await box.verify(receiptFor(head, [passingCheck]));
      assert.equal(r.code, 1);
      assert.deepEqual(r.json.reasons, [{ code: 'check-failed', message: 'check "tests" exited with 1' }]);
    });
  });

  test('an uncommitted edit, staged or not, is not what gets checked', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, { 'check.sh': 'exit 1\n' });
      fs.writeFileSync(path.join(box.repo, 'check.sh'), 'exit 0\n');
      assert.equal(git(box.repo, ['status', '--porcelain']), 'M check.sh');
      assert.equal(strictBash(box.repo, 'bash check.sh'), 0, 'the check passes in the working tree');
      const unstaged = await box.verify(receiptFor(head, [passingCheck]));
      assert.equal(unstaged.code, 1);
      assert.deepEqual(reasonCodes(unstaged.json), ['check-failed']);
      git(box.repo, ['add', 'check.sh']);
      const staged = await box.verify(receiptFor(head, [passingCheck]));
      assert.equal(staged.code, 1);
      assert.deepEqual(reasonCodes(staged.json), ['check-failed']);
    });
  });

  test('export-ignore cannot hide a failing test', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, {
        '.gitattributes': 'tests/b.sh export-ignore\n',
        'tests/a.sh': 'exit 0\n',
        'tests/b.sh': 'echo "b fails" >&2\nexit 1\n',
      });
      const run = 'for f in tests/*.sh; do bash "$f"; done';
      const archived = archive(box.repo, head, path.join(box.dir, 'archived'));
      assert.equal(fs.existsSync(path.join(archived, 'tests', 'a.sh')), true);
      assert.equal(fs.existsSync(path.join(archived, 'tests', 'b.sh')), false, 'git archive drops the failing test');
      assert.equal(strictBash(archived, run), 0, 'so the check would pass in an archive');
      const r = await box.verify(receiptFor(head, [{ id: 'tests', run }]));
      assert.equal(r.code, 1);
      assert.deepEqual(r.json.reasons, [{ code: 'check-failed', message: 'check "tests" exited with 1' }]);
      assert.match(r.json.checks[0].stderr_tail, /b fails/);
    });
  });

  test('the copy is byte-exact: no attribute conversions, modes and links kept, no .git', async () => {
    await sandbox(async (box) => {
      const data = Buffer.from([0, 1, 2, 13, 10, 255, 254, 10, 27]);
      const exact = {
        'a.txt': Buffer.from('one\ntwo\n'),
        'subst.txt': Buffer.from('commit $Format:%H$\n'),
        'data.bin': data,
        'deep/er/file.txt': Buffer.from('x\ny\n'),
      };
      const want = Object.fromEntries(Object.entries(exact).map(([name, bytes]) => [name, bytes.toString('hex')]));
      const script = [
        "import fs from 'node:fs';",
        `const want = ${JSON.stringify(want)};`,
        'const fail = (why) => { console.error(why); process.exit(1); };',
        "for (const [name, hex] of Object.entries(want)) if (fs.readFileSync(name).toString('hex') !== hex) fail(`bytes differ: ${name}`);",
        'const exec = (name) => (fs.statSync(name).mode & 0o111) !== 0;',
        "if (!exec('run.sh')) fail('run.sh lost its executable bit');",
        "if (exec('plain.sh')) fail('plain.sh became executable');",
        "if (!fs.lstatSync('link').isSymbolicLink() || fs.readlinkSync('link') !== 'a.txt') fail('link is not a link to a.txt');",
        "if (fs.existsSync('.git')) fail('the copy has a .git');",
        '',
      ].join('\n');
      const head = makeRepo(box.repo, {
        '.gitattributes': '*.txt text eol=crlf\nsubst.txt export-subst\ndata.bin -text\n',
        ...exact,
        'run.sh': { content: '#!/bin/sh\necho ran\n', mode: 0o755 },
        'plain.sh': { content: '#!/bin/sh\nexit 0\n', mode: 0o644 },
        link: { link: 'a.txt' },
        'check-bytes.mjs': script,
      });
      for (const [name, bytes] of Object.entries(exact)) {
        assert.deepEqual(git(box.repo, ['cat-file', 'blob', `HEAD:${name}`], { raw: true }), bytes, `git stored ${name} as written`);
      }
      const archived = archive(box.repo, head, path.join(box.dir, 'archived'));
      assert.equal(fs.readFileSync(path.join(archived, 'a.txt'), 'utf8'), 'one\r\ntwo\r\n', 'git archive converts line ends');
      assert.equal(fs.readFileSync(path.join(archived, 'subst.txt'), 'utf8'), `commit ${head}\r\n`, 'git archive rewrites export-subst files');

      const r = await box.verify(receiptFor(head, [
        { id: 'bytes', run: 'node check-bytes.mjs' },
        { id: 'exec', run: './run.sh' },
        { id: 'no-history', run: '! git rev-parse --git-dir 2>/dev/null' },
      ]));
      assert.equal(r.code, 0, JSON.stringify(r.json.checks.map((c) => [c.id, c.stderr_tail])));
      assert.deepEqual(r.json.copy, { files: 9 });
      assert.equal(r.json.checks[1].stdout_tail, 'ran\n');
    });
  });

  test('a commit with a submodule entry is INCOMPLETE', async () => {
    await sandbox(async (box) => {
      const first = makeRepo(box.repo, PASSING);
      git(box.repo, ['update-index', '--add', '--cacheinfo', `160000,${first},vendor/lib`]);
      git(box.repo, ['commit', '-q', '-m', 'add a submodule entry']);
      const head = git(box.repo, ['rev-parse', 'HEAD']);
      const r = await box.verify(receiptFor(head, [passingCheck]));
      assert.equal(r.code, 2);
      assert.deepEqual(r.json.reasons, [{
        code: 'copy-failed',
        message: `could not export ${short(head)}: the commit has submodules (vendor/lib), and this version does not copy their contents`,
      }]);
      assert.equal(r.json.checks[0].outcome, 'not-run');
    });
  });

  test('paths that are unsafe to write are refused before anything is written', async () => {
    await withTemp(async (dir) => {
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      git(repo, ['init', '-q', '-b', 'main']);
      const blob = git(repo, ['hash-object', '-w', '--stdin'], { input: 'x\n' });
      // Hand-made trees: git's own commands would refuse these names.
      const tree = (entries) => git(repo, ['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'], {
        input: Buffer.concat(entries.map(([mode, name, oid]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]))),
      });
      const cases = [
        [tree([['100644', '.git', blob]]), '".git" (contains .git)'],
        [tree([['40000', '.GIT', tree([['100644', 'config', blob]])]]), '".GIT/config" (contains .git)'],
        [tree([['40000', '..', tree([['100644', 'evil', blob]])]]), '"../evil" (contains "..")'],
        [tree([['100644', '/abs', blob]]), '"/abs" (absolute)'],
      ];
      for (const [t, what] of cases) {
        const id = git(repo, ['commit-tree', t, '-m', 'unsafe']);
        const dest = path.join(dir, 'out', 'copy');
        await assert.rejects(exportCommit(repo, id, dest), { message: `the commit holds a path that is unsafe to write, ${what}` });
        assert.equal(fs.existsSync(path.join(dir, 'out')), false, 'nothing was written');
      }
    });
  });

  test('an unsafe path makes the verdict INCOMPLETE', async () => {
    await sandbox(async (box) => {
      makeRepo(box.repo, PASSING);
      const blob = git(box.repo, ['hash-object', '-w', '--stdin'], { input: 'x\n' });
      const sub = git(box.repo, ['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'], { input: Buffer.concat([Buffer.from('100644 evil\0'), Buffer.from(blob, 'hex')]) });
      const top = git(box.repo, ['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'], { input: Buffer.concat([Buffer.from('40000 ..\0'), Buffer.from(sub, 'hex')]) });
      const id = git(box.repo, ['commit-tree', top, '-m', 'unsafe']);
      const r = await box.verify(receiptFor(id, [passingCheck]));
      assert.equal(r.code, 2);
      assert.deepEqual(reasonCodes(r.json), ['copy-failed']);
      assert.equal(fs.readdirSync(box.tmp).length, 0);
    });
  });
});

describe('e2e: time limits and leftover processes', () => {
  test('a check past its time limit is INCOMPLETE quickly, background child included', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, { 'slow.sh': 'sleep 30 &\necho $! > "$PIDFILE"\nsleep 30\n' });
      const pidfile = path.join(box.dir, 'grandchild.pid');
      const r = await box.verify(receiptFor(head, [{ id: 'slow', run: 'bash slow.sh', timeout_seconds: 1, env: { PIDFILE: pidfile } }], {
        done_when: [{ id: 'r1', text: 'fast', check: 'slow' }],
      }));
      assert.equal(r.code, 2);
      assert.ok(r.ms < 10000, `took ${r.ms} ms`);
      assert.deepEqual(r.json.reasons, [
        { code: 'check-timed-out', message: 'check "slow" was still running after 1 s and was stopped' },
        { code: 'done-when-unproven', message: 'done-when "r1" (fast) is unproven: check "slow" did not finish' },
      ]);
      assert.equal(r.json.checks[0].timed_out, true);
      assert.equal(r.json.checks[0].outcome, 'incomplete');
      const pid = await readPid(pidfile);
      await waitFor(() => !alive(pid), 5000, 'the background sleep to be stopped');
    });
  });

  test('a check that ignores SIGTERM is killed 2 s later', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, PASSING);
      const r = await box.verify(receiptFor(head, [{ id: 'stubborn', run: 'trap "" TERM; sleep 30', timeout_seconds: 1 }]));
      assert.equal(r.code, 2);
      assert.deepEqual(reasonCodes(r.json), ['check-timed-out']);
      assert.ok(r.ms >= 2500 && r.ms < 12000, `took ${r.ms} ms`);
    });
  });

  test('a check that exits 0 leaving `sleep 30 &` returns quickly and the sleep is stopped', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, { 'bg.sh': 'sleep 30 &\necho $! > "$PIDFILE"\necho started\n' });
      const pidfile = path.join(box.dir, 'background.pid');
      const r = await box.verify(receiptFor(head, [{ id: 'bg', run: 'bash bg.sh', env: { PIDFILE: pidfile } }]));
      assert.equal(r.code, 0);
      assert.ok(r.ms < 8000, `took ${r.ms} ms`);
      assert.equal(r.json.checks[0].stdout_tail, 'started\n');
      const pid = await readPid(pidfile);
      await waitFor(() => !alive(pid), 5000, 'the background sleep to be stopped');
    });
  });

  test('SIGINT and SIGTERM stop the running check, remove the clean copy and exit 130 and 143', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, { 'wait.sh': 'sleep 30 &\necho $! > "$PIDFILE"\nwait\n' });
      for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
        const pidfile = path.join(box.dir, `${signal}.pid`);
        const file = box.writeReceipt(receiptFor(head, [{ id: 'wait', run: 'bash wait.sh', env: { PIDFILE: pidfile } }]), `${signal}.json`);
        const { child, done } = box.start(['verify', file, '--repo', box.repo]);
        const pid = await readPid(pidfile);
        child.kill(signal);
        const r = await done;
        assert.deepEqual([r.code, r.signal], [code, null], r.stderr);
        await waitFor(() => !alive(pid), 5000, `the check's sleep to be stopped after ${signal}`);
        assert.deepEqual(leftovers(box.tmp), [], `the clean copy was removed after ${signal}`);
      }
    });
  });
});

describe('e2e: evidence', () => {
  test('inflated counts are REFUTED; honest ones are VERIFIED', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, { 'results.tap': 'TAP version 13\nok 1 - a\nok 2 - b\nok 3 - c # SKIP\n1..3\n' });
      const check = (counts) => ({ id: 'unit', run: 'cat results.tap', format: 'tap', counts });
      const inflated = await box.verify(receiptFor(head, [check({ passed: 5, failed: 0, skipped: 0 })]));
      assert.equal(inflated.code, 1);
      assert.deepEqual(inflated.json.reasons, [{ code: 'counts-differ', message: 'check "unit" claimed 5 passed, 0 failed, 0 skipped; its TAP output shows 2 passed, 0 failed, 1 skipped' }]);
      assert.deepEqual(inflated.json.checks[0].counts, { passed: 2, failed: 0, skipped: 1 });
      assert.deepEqual(inflated.json.checks[0].claimed, { passed: 5, failed: 0, skipped: 0 });
      const honest = await box.verify(receiptFor(head, [check({ passed: 2, failed: 0, skipped: 1 })]));
      assert.equal(honest.code, 0);
      assert.match(messageOf(honest.json, 'check-passed'), /; TAP output shows 2 passed, 0 failed, 1 skipped, as claimed$/);
    });
  });

  test('failures behind exit 0, and a bail-out, are REFUTED', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, {
        'fail.tap': 'TAP version 13\nok 1 - a\nnot ok 2 - b\n1..2\n',
        'bail.tap': 'TAP version 13\nok 1 - a\nBail out! no database\n',
      });
      const r = await box.verify(receiptFor(head, [
        { id: 'quiet', run: 'cat fail.tap', format: 'tap', counts: { passed: 2, failed: 0, skipped: 0 } },
        { id: 'bail', run: 'cat bail.tap', format: 'tap', counts: { passed: 1, failed: 0, skipped: 0 } },
      ]));
      assert.equal(r.code, 1);
      assert.deepEqual(r.json.reasons, [
        { code: 'failures-reported', message: 'check "quiet" exited 0, but its TAP output reports 1 failed' },
        { code: 'counts-differ', message: 'check "quiet" claimed 2 passed, 0 failed, 0 skipped; its TAP output shows 1 passed, 1 failed, 0 skipped' },
        { code: 'tests-bailed-out', message: 'check "bail": the tests bailed out (no database)' },
      ]);
    });
  });

  test('a JUnit file that was never written is INCOMPLETE', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, PASSING);
      const r = await box.verify(receiptFor(head, [{ id: 'xml', run: 'true', format: 'junit', file: 'out/report.xml', counts: { passed: 1, failed: 0, skipped: 0 } }]));
      assert.equal(r.code, 2);
      assert.deepEqual(r.json.reasons, [{ code: 'evidence-missing', message: 'check "xml" did not write out/report.xml, so there are no counts to compare' }]);
    });
  });

  test('TAP without a plan is INCOMPLETE', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, PASSING);
      const r = await box.verify(receiptFor(head, [{ id: 'unit', run: "printf 'ok 1 - a\\n'", format: 'tap', counts: { passed: 1, failed: 0, skipped: 0 } }]));
      assert.equal(r.code, 2);
      assert.deepEqual(r.json.reasons, [{
        code: 'evidence-unreadable',
        message: "check \"unit\": can't read its TAP output (stdout): no plan line (1..N); the output may have been cut short, or it is not TAP",
      }]);
    });
  });

  test('a real node --test run with describe, it and skip is VERIFIED at 2/0/1', async () => {
    await sandbox(async (box) => {
      const sample = [
        "import { describe, it } from 'node:test';",
        '',
        "describe('sample', () => {",
        "  it('passes', () => {});",
        "  it('passes too', () => {});",
        "  it.skip('is skipped', () => {});",
        '});',
        '',
      ].join('\n');
      const head = makeRepo(box.repo, { 'sample.test.mjs': sample });
      const r = await box.verify(receiptFor(head, [{
        id: 'node', run: 'node --test --test-reporter=tap sample.test.mjs', format: 'tap', counts: { passed: 2, failed: 0, skipped: 1 },
      }]));
      assert.equal(r.code, 0, JSON.stringify(r.json.findings));
      assert.deepEqual(r.json.checks[0].counts, { passed: 2, failed: 0, skipped: 1 });
    });
  });

  test('TAP and JUnit agree on a live Node run: 4 passed, 0 failed, 2 skipped', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, { 'sample.test.mjs': fixture('sample.test.mjs.txt') });
      const counts = { passed: 4, failed: 0, skipped: 2 };
      const r = await box.verify(receiptFor(head, [
        { id: 'tap', run: 'node --test --test-reporter=tap sample.test.mjs', format: 'tap', counts },
        { id: 'junit', run: 'node --test --test-reporter=junit --test-reporter-destination=report.xml sample.test.mjs', format: 'junit', file: 'report.xml', counts },
      ]));
      assert.equal(r.code, 0, JSON.stringify(r.json.findings));
      assert.deepEqual(r.json.checks.map((c) => c.counts), [counts, counts]);
    });
  });

  test('a JUnit report committed as a fixture is VERIFIED', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, { 'reports/junit.xml': fixture('node-junit.xml') });
      const r = await box.verify(receiptFor(head, [{ id: 'xml', run: 'true', format: 'junit', file: 'reports/junit.xml', counts: { passed: 4, failed: 0, skipped: 2 } }]));
      assert.equal(r.code, 0);
      assert.match(messageOf(r.json, 'check-passed'), /; JUnit report shows 4 passed, 0 failed, 2 skipped, as claimed$/);
    });
  });
});

describe('e2e: environment and network', () => {
  test('a check sees a scrubbed environment plus the receipt\'s env', async () => {
    await sandbox(async (box) => {
      const script = [
        'test -z "${RECEIPT_TEST_CALLER:-}"',
        'test "$HOME" != "$CALLER_HOME"',
        'test -d "$HOME" && test -z "$(ls -A "$HOME")"',
        'test "$TMPDIR" != "$CALLER_TMP" && test -d "$TMPDIR"',
        'test "$FROM_RECEIPT" = "yes, with spaces"',
        'test "$(printenv __proto__)" = own',
        'test "$LANG" = C.UTF-8 && test "$TZ" = UTC && test "$TERM" = dumb && test "$NO_COLOR" = 1',
        'test "$GIT_CONFIG_NOSYSTEM" = 1 && test -n "$GIT_CEILING_DIRECTORIES"',
        'case ":$PATH:" in *:.:*|*:relative/bin:*) echo "a relative PATH entry was kept" >&2; exit 1;; esac',
        'case ":$PATH:" in *":$NODE_DIR:"*) ;; *) echo "an absolute PATH entry was lost" >&2; exit 1;; esac',
        'env | cut -d= -f1 | sort',
        '',
      ].join('\n');
      const head = makeRepo(box.repo, { 'env.sh': script });
      const nodeDir = path.dirname(process.execPath);
      const receiptEnv = { FROM_RECEIPT: 'yes, with spaces', CALLER_HOME: box.home, CALLER_TMP: box.tmp, NODE_DIR: nodeDir, ['__proto__']: 'own' };
      const r = await box.verify(receiptFor(head, [{ id: 'env', run: 'bash env.sh', env: receiptEnv }]), {
        env: { RECEIPT_TEST_CALLER: 'leak', PATH: ['.', 'relative/bin', nodeDir, process.env.PATH ?? ''].join(path.delimiter) },
      });
      assert.equal(r.code, 0, r.json.checks[0].stderr_tail);
      const names = r.json.checks[0].stdout_tail.trim().split('\n');
      const expected = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'TERM', 'NO_COLOR', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_NOSYSTEM', ...Object.keys(receiptEnv)];
      for (const name of expected) assert.ok(names.includes(name), `${name} is set`);
      const bashOwn = ['PWD', 'OLDPWD', 'SHLVL', '_'];
      assert.deepEqual(names.filter((n) => !expected.includes(n) && !bashOwn.includes(n)), [], 'nothing else reaches the check');
    });
  });

  test('--offline runs checks without a network where the system allows it, and is INCOMPLETE where not', async (t) => {
    const support = offlineSupport();
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, PASSING);
      const r = await box.verify(receiptFor(head, [
        { id: 'no-network', run: 'test "$(grep -c : /proc/net/dev)" -eq 1' },
        { id: 'pipefail', run: '! (false | cat)' },
      ]), { args: ['--offline'] });
      assert.equal(r.json.network, 'off');
      if (support.ok) {
        t.diagnostic('offline: network namespace available, checks ran without network');
        assert.equal(r.code, 0, JSON.stringify(r.json.findings));
        assert.deepEqual(r.json.checks.map((c) => c.outcome), ['passed', 'passed']);
      } else {
        t.diagnostic(`offline: not available here (${support.why}), verdict INCOMPLETE as designed`);
        assert.equal(r.code, 2);
        assert.deepEqual(r.json.reasons, [{ code: 'offline-unavailable', message: `--offline was asked for, but ${support.why}; no check was run` }]);
        assert.deepEqual(r.json.checks.map((c) => c.outcome), ['not-run', 'not-run']);
        assert.equal(r.json.copy, null);
      }
    });
  });
});

describe('e2e: the command line', () => {
  test('--json prints the whole result in a fixed shape', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, PASSING);
      const r = await box.verify(receiptFor(head, [passingCheck], { delivered: ['check.sh'], done_when: [{ id: 'r1', text: 'passes', check: 'tests' }] }));
      assert.equal(r.code, 0);
      const report = r.json;
      assert.deepEqual(Object.keys(report), ['tool', 'version', 'verdict', 'exit_code', 'receipt', 'commit', 'network', 'reasons', 'findings', 'checks', 'delivered', 'done_when', 'copy', 'ledger']);
      assert.equal(report.tool, 'receipt-check');
      assert.equal(report.version, VERSION);
      assert.equal(report.verdict, 'VERIFIED');
      assert.equal(report.exit_code, 0);
      assert.deepEqual(report.receipt, { path: r.file, sha256: sha256(fs.readFileSync(r.file)) });
      assert.equal(report.commit, head);
      assert.equal(report.network, 'on');
      assert.deepEqual(findingCodes(report), ['commit-found', 'delivered-present', 'copy-made', 'check-passed', 'done-when-met']);
      assert.deepEqual(report.reasons, report.findings.map(({ code, message }) => ({ code, message })));
      for (const f of report.findings) assert.equal(f.effect, 'ok');
      assert.equal(report.findings.find((f) => f.code === 'check-passed').check, 'tests');
      assert.deepEqual(Object.keys(report.checks[0]), ['id', 'run', 'format', 'exit_code', 'signal', 'timed_out', 'seconds', 'counts', 'claimed', 'outcome', 'stdout_tail', 'stderr_tail']);
      const { seconds, ...check } = report.checks[0];
      assert.equal(typeof seconds, 'number');
      assert.deepEqual(check, {
        id: 'tests', run: 'bash check.sh', format: 'exit-code', exit_code: 0, signal: null, timed_out: false,
        counts: null, claimed: null, outcome: 'passed', stdout_tail: 'all good\n', stderr_tail: '',
      });
      assert.deepEqual(report.delivered, [{ path: 'check.sh', present: true }]);
      assert.deepEqual(report.done_when, [{ id: 'r1', check: 'tests', met: true }]);
      assert.deepEqual(report.copy, { files: 1 });
      assert.equal(report.ledger, null);
      assert.equal(r.stderr, '', '--json prints no progress');
    });
  });

  test('--keep leaves the clean copy and says where it is', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, PASSING);
      const r = await box.verify(receiptFor(head, [passingCheck]), { args: ['--keep'] });
      assert.equal(r.code, 0);
      const kept = r.json.copy.kept;
      assert.equal(path.dirname(kept), box.tmp);
      assert.match(path.basename(kept), /^receipt-check-/);
      assert.equal(fs.readFileSync(path.join(kept, 'copy', 'check.sh'), 'utf8'), PASSING['check.sh']);
    });
  });

  test('a delivered path missing at the commit is REFUTED', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, { ...PASSING, 'src/a.js': 'a\n' });
      fs.writeFileSync(path.join(box.repo, 'notes.md'), 'untracked\n');
      const r = await box.verify(receiptFor(head, [passingCheck], { delivered: ['check.sh', 'src', 'notes.md', 'docs/missing.md'] }));
      assert.equal(r.code, 1);
      assert.deepEqual(r.json.reasons, [
        { code: 'delivered-missing', message: `delivered path notes.md does not exist at ${short(head)}` },
        { code: 'delivered-missing', message: `delivered path docs/missing.md does not exist at ${short(head)}` },
      ]);
      assert.deepEqual(r.json.delivered.map((d) => d.present), [true, true, false, false]);
    });
  });

  test('a done-when item whose check failed is unmet', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, PASSING);
      const r = await box.verify(receiptFor(head, [{ id: 'good', run: 'true' }, { id: 'bad', run: 'exit 2' }], {
        done_when: [{ id: 'r1', text: 'good works', check: 'good' }, { id: 'r2', text: 'bad works', check: 'bad' }],
      }));
      assert.equal(r.code, 1);
      assert.deepEqual(r.json.reasons, [
        { code: 'check-failed', message: 'check "bad" exited with 2' },
        { code: 'done-when-unmet', message: 'done-when "r2" (bad works) is not met: check "bad" failed' },
      ]);
      assert.deepEqual(r.json.done_when, [{ id: 'r1', check: 'good', met: true }, { id: 'r2', check: 'bad', met: false }]);
    });
  });

  test('a commit missing from a shallow clone is INCOMPLETE, not REFUTED', async () => {
    await sandbox(async (box) => {
      const first = makeRepo(box.repo, PASSING);
      const second = commit(box.repo, { 'more.txt': 'more\n' });
      const shallow = path.join(box.dir, 'shallow');
      git(box.dir, ['clone', '-q', '--depth', '1', `file://${box.repo}`, shallow]);
      assert.equal(git(shallow, ['rev-parse', '--is-shallow-repository']), 'true');
      const old = await box.verify(receiptFor(first, [passingCheck]), { repo: shallow });
      assert.equal(old.code, 2);
      assert.deepEqual(old.json.reasons, [{
        code: 'commit-not-fetched',
        message: `commit ${short(first)} is not in this shallow clone; fetch the full history (git fetch --unshallow) and check again`,
      }]);
      const latest = await box.verify(receiptFor(second, [passingCheck]), { repo: shallow });
      assert.equal(latest.code, 0);
    });
  });

  test('an invalid receipt exits 3 and points at line and column', async () => {
    await sandbox(async (box) => {
      const text = `{\n  "receipt": "${FORMAT}",\n  "status": "FAIL",\n  "commit": "${'a'.repeat(40)}",\n  "checks": [{ "id": "t", "run": "true" }]\n}\n`;
      const file = box.writeReceipt(text);
      const r = await box.cli(['verify', file, '--repo', path.join(box.dir, 'nowhere')]);
      assert.equal(r.code, 3);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, `${file}:3:13: status: must be "PASS", not a string ("FAIL"): a receipt claims that work is done, and a failure needs no proof\n${file}: 1 problem; nothing was run\n`);

      const json = await box.cli(['verify', file, '--json']);
      assert.equal(json.code, 3);
      assert.deepEqual(JSON.parse(json.stdout), {
        tool: 'receipt-check', version: VERSION, verdict: null, exit_code: 3, receipt: { path: file },
        errors: [{ path: 'status', line: 3, column: 13, message: 'must be "PASS", not a string ("FAIL"): a receipt claims that work is done, and a failure needs no proof' }],
      });

      const syntax = box.writeReceipt('{\n  "receipt": ,\n}\n', 'syntax.json');
      const s = await box.cli(['verify', syntax]);
      assert.equal(s.code, 3);
      assert.equal(s.stderr, `${syntax}:2:14: expected a value, found ","\n${syntax}: 1 problem; nothing was run\n`);

      const twice = box.writeReceipt('{}', 'empty.json');
      assert.match((await box.cli(['verify', twice])).stderr, /: 4 problems; nothing was run\n$/);

      const binary = path.join(box.dir, 'binary.json');
      fs.writeFileSync(binary, Buffer.from([0x7b, 0xff, 0x7d]));
      const b = await box.cli(['verify', binary]);
      assert.deepEqual([b.code, b.stderr], [3, `${binary}: is not valid UTF-8 text\n${binary}: 1 problem; nothing was run\n`]);

      const huge = box.writeReceipt(`{"note": "${'x'.repeat(1024 * 1024)}"}`, 'huge.json');
      const h = await box.cli(['verify', huge]);
      assert.deepEqual([h.code, h.stderr], [3, `${huge}: is ${1024 * 1024 + 12} bytes; a receipt can be at most ${1024 * 1024}\n${huge}: 1 problem; nothing was run\n`]);
    });
  });

  test('lint checks a receipt without running anything', async () => {
    await sandbox(async (box) => {
      const marker = path.join(box.dir, 'ran');
      const receipt = receiptFor('a'.repeat(40), [{ id: 't', run: `touch '${marker}'` }], { delivered: ['a', 'b'], done_when: [{ id: 'r1', text: 'x', check: 't' }] });
      const file = box.writeReceipt(receipt);
      const r = await box.cli(['lint', file]);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, `${file}: a valid ${FORMAT} receipt for commit aaaaaaaaaaaa (1 check, 2 delivered paths, 1 done-when item)\n`);
      const json = await box.cli(['lint', file, '--json']);
      assert.equal(json.code, 0);
      const parsed = JSON.parse(json.stdout);
      assert.deepEqual([parsed.tool, parsed.version, parsed.valid, parsed.receipt.checks[0].format], ['receipt-check', VERSION, true, 'exit-code']);
      const bad = await box.cli(['lint', box.writeReceipt({ ...receipt, status: 'pass' }, 'bad.json')]);
      assert.equal(bad.code, 3);
      assert.match(bad.stderr, /bad\.json:3:13: status: write "PASS" in capitals\n.*bad\.json: 1 problem; not a valid receipt-check\/1 receipt\n$/s);
      assert.equal(fs.existsSync(marker), false);
    });
  });

  test('a receipt can be read from stdin with -', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, PASSING);
      const input = JSON.stringify(receiptFor(head, [passingCheck]));
      const r = await box.cli(['verify', '-', '--repo', box.repo], { input });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.equal(r.stdout.split('\n')[0], `VERIFIED: every claim in stdin held at ${short(head)}`);
      const json = await box.cli(['verify', '-', '--repo', box.repo, '--json'], { input });
      assert.deepEqual(JSON.parse(json.stdout).receipt, { path: 'stdin', sha256: sha256(input) });
      const lint = await box.cli(['lint', '-'], { input: '{"receipt": 1}' });
      assert.equal(lint.code, 3);
      assert.match(lint.stderr, /\nstdin:1:13: receipt: must be "receipt-check\/1", not the number 1\nstdin: 4 problems; not a valid receipt-check\/1 receipt\n$/);
    });
  });

  test('usage and setup errors exit 4', async () => {
    await sandbox(async (box) => {
      const help = 'Run receipt-check --help for usage.\n';
      const missing = path.join(box.dir, 'missing.json');
      const nowhere = path.join(box.dir, 'nowhere');
      const ok = box.writeReceipt(receiptFor('a'.repeat(40), [passingCheck]));
      const cases = [
        [[], `receipt-check: no command given\n${help}`],
        [['frobnicate'], `receipt-check: unknown command "frobnicate"\n${help}`],
        [['verify'], `receipt-check: verify takes one receipt file, or - to read it from stdin\n${help}`],
        [['verify', 'a.json', 'b.json'], `receipt-check: verify takes one receipt file, or - to read it from stdin\n${help}`],
        [['lint'], `receipt-check: lint takes one receipt file, or - to read it from stdin\n${help}`],
        [['ledger'], `receipt-check: ledger takes one ledger file\n${help}`],
        [['verify', 'a.json', '--bogus'], /^receipt-check: .*--bogus.*\nRun receipt-check --help for usage\.\n$/s],
        [['verify', 'a.json', '--repo'], /^receipt-check: .*--repo.*\nRun receipt-check --help for usage\.\n$/s],
        [['verify', missing], `receipt-check: can't read ${missing}: no such file\n`],
        [['lint', missing], `receipt-check: can't read ${missing}: no such file\n`],
        [['ledger', missing], `receipt-check: can't read ${missing}: no such file\n`],
        [['verify', ok, '--repo', nowhere], `receipt-check: ${nowhere} is not inside a git repository (point --repo at the one the receipt is about)\n`],
      ];
      for (const [args, stderr] of cases) {
        const r = await box.cli(args);
        assert.equal(r.code, 4, `${args.join(' ')}: ${r.stderr}`);
        assert.equal(r.stdout, '');
        if (typeof stderr === 'string') assert.equal(r.stderr, stderr);
        else assert.match(r.stderr, stderr);
      }
    });
  });

  test('--help and --version', async () => {
    await sandbox(async (box) => {
      for (const flag of ['--help', '-h', 'help']) {
        const r = await box.cli([flag]);
        assert.equal(r.code, 0);
        assert.ok(r.stdout.startsWith(`receipt-check ${VERSION}: checks an AI agent's "done" receipt by rerunning it\n`));
        assert.ok(r.stdout.includes('\nExit codes:\n'));
      }
      for (const flag of ['--version', 'version']) assert.deepEqual(await box.cli([flag]).then((r) => [r.code, r.stdout]), [0, `${VERSION}\n`]);
    });
  });

  test('the ledger end to end: append twice, edit, detect, refuse', async () => {
    await sandbox(async (box) => {
      const head = makeRepo(box.repo, PASSING);
      const ledger = path.join(box.dir, 'verdicts.jsonl');
      const good = await box.verify(receiptFor(head, [passingCheck]), { args: ['--ledger', ledger], name: 'good.json' });
      assert.equal(good.code, 0);
      const bad = await box.verify(receiptFor(head, [{ id: 'tests', run: 'false' }]), { args: ['--ledger', ledger], name: 'bad.json', json: false });
      assert.equal(bad.code, 1);

      const lines = fs.readFileSync(ledger, 'utf8').split('\n');
      assert.equal(lines.pop(), '');
      const [first, second] = lines.map((line) => JSON.parse(line));
      assert.deepEqual(good.json.ledger, { file: ledger, seq: 1, hash: first.hash });
      assert.ok(bad.stdout.includes(`  ledger: entry 2 in ${ledger}, hash ${second.hash}\n`), bad.stdout);
      const { time: t1, hash: h1, ...rest1 } = first;
      assert.deepEqual(rest1, {
        checker: `receipt-check ${VERSION}`, commit: head, prev: '0'.repeat(64), reasons: good.json.reasons.map((x) => x.message),
        receipt_sha256: sha256(fs.readFileSync(good.file)), seq: 1, v: 1, verdict: 'VERIFIED',
      });
      assert.equal(typeof t1, 'string');
      assert.equal(h1.length, 64);
      assert.deepEqual([second.seq, second.verdict, second.prev, second.reasons, second.receipt_sha256], [2, 'REFUTED', first.hash, ['check "tests" exited with 1'], sha256(fs.readFileSync(bad.file))]);

      const intact = await box.cli(['ledger', ledger]);
      assert.deepEqual([intact.code, intact.stdout], [0, `${ledger}: 2 entries, hash chain intact; newest hash ${second.hash}\n`]);
      const intactJson = await box.cli(['ledger', ledger, '--json']);
      assert.deepEqual(JSON.parse(intactJson.stdout), { tool: 'receipt-check', version: VERSION, ledger, intact: true, entries: 2, head: second.hash });

      const text = fs.readFileSync(ledger, 'utf8');
      fs.writeFileSync(ledger, text.replace('"verdict":"VERIFIED"', '"verdict":"REFUTED"'));
      const edited = fs.readFileSync(ledger);
      const broken = await box.cli(['ledger', ledger]);
      assert.deepEqual([broken.code, broken.stdout], [1, `${ledger}: broken at line 1: that entry does not match its own hash (this entry was edited)\n`]);
      const brokenJson = await box.cli(['ledger', ledger, '--json']);
      assert.equal(brokenJson.code, 1);
      assert.deepEqual(JSON.parse(brokenJson.stdout), { tool: 'receipt-check', version: VERSION, ledger, intact: false, line: 1, problem: 'does not match its own hash (this entry was edited)' });

      const third = await box.verify(receiptFor(head, [passingCheck]), { args: ['--ledger', ledger], name: 'third.json', json: false });
      assert.equal(third.code, 4);
      assert.ok(third.stdout.startsWith('VERIFIED: '), 'the verdict is still printed');
      assert.ok(third.stderr.includes(`receipt-check: the verdict was not recorded: ${ledger} is broken at line 1: does not match its own hash (this entry was edited); nothing was added\n`), third.stderr);
      assert.deepEqual(fs.readFileSync(ledger), edited, 'nothing was appended');

      const empty = path.join(box.dir, 'empty.jsonl');
      fs.writeFileSync(empty, '');
      assert.deepEqual(await box.cli(['ledger', empty]).then((r) => [r.code, r.stdout]), [0, `${empty}: 0 entries, hash chain intact\n`]);
    });
  });
});
