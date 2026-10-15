// Shared test helpers: temporary folders, real git repositories, and the CLI
// run as a separate process with a small, fixed environment.
//
// Everything here must work in a scrubbed environment (fresh HOME, no git
// config, minimal PATH) on Linux and macOS, because the suite is also run
// inside receipt-check itself.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BIN = path.join(ROOT, 'bin', 'receipt-check.js');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const FORMAT = 'receipt-check/1';

export const fixture = (name) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name), 'utf8');
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// A real path (macOS puts os.tmpdir() behind the /var -> /private/var link).
export function tempDir(prefix = 'rc-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export async function withTemp(fn) {
  const dir = tempDir();
  try {
    return await fn(dir);
  } finally {
    removeDir(dir);
  }
}

// Git as these tests run it: none of the caller's GIT_* variables, no system
// or global config, and an identity on every commit.
export function gitEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('GIT_') && name !== 'NODE_TEST_CONTEXT') env[name] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'receipt-test',
    GIT_AUTHOR_EMAIL: 'receipt-test',
    GIT_COMMITTER_NAME: 'receipt-test',
    GIT_COMMITTER_EMAIL: 'receipt-test',
  };
}

export function git(cwd, args, { input, raw = false } = {}) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr.toString().trim()}`);
  return raw ? r.stdout : r.stdout.toString().trim();
}

// files: { 'dir/name': text | Buffer | { content, mode } | { link: target } }
export function writeFiles(root, files) {
  for (const [name, spec] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { force: true });
    if (spec !== null && typeof spec === 'object' && 'link' in spec) fs.symlinkSync(spec.link, target);
    else if (spec !== null && typeof spec === 'object' && !Buffer.isBuffer(spec)) {
      fs.writeFileSync(target, spec.content);
      fs.chmodSync(target, spec.mode);
    } else fs.writeFileSync(target, spec);
  }
}

// Writes files, commits everything, and returns the new commit id.
export function commit(repo, files, message = 'change') {
  writeFiles(repo, files);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

export function makeRepo(repo, files, message = 'first') {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  return commit(repo, files, message);
}

export function receiptFor(commitId, checks, more = {}) {
  return { receipt: FORMAT, status: 'PASS', commit: commitId, checks, ...more };
}

// Runs a command the way a check runs, but in the given folder.
export function strictBash(cwd, run) {
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', run], { cwd, env: gitEnv(), stdio: 'ignore' }).status;
}

// The CLI's environment: this Node first on PATH (checks that run `node` get
// the same version), and HOME and TMPDIR inside the test's own folder.
export function cliEnv({ home, tmp, extra = {} }) {
  return {
    PATH: [path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter),
    HOME: home,
    TMPDIR: tmp,
    LANG: 'C.UTF-8',
    ...extra,
  };
}

// Starts bin/receipt-check.js. Returns { child, done }, where done resolves
// with { code, signal, stdout, stderr, ms }.
export function startCli(args, { home, tmp, env = {}, input = null, cwd = ROOT } = {}) {
  const started = Date.now();
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env: cliEnv({ home, tmp, extra: env }), stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [];
  const err = [];
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => err.push(chunk));
  child.stdin.on('error', () => {});
  child.stdin.end(input ?? '');
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(out).toString(),
      stderr: Buffer.concat(err).toString(),
      ms: Date.now() - started,
    }));
  });
  return { child, done };
}

// The receipt-check-* work folders the CLI left in a TMPDIR.
export const leftovers = (tmp) => fs.readdirSync(tmp).filter((name) => name.startsWith('receipt-check-'));

// One test's world: a temporary folder holding repo/, home/ and tmp/, removed
// afterwards. box.cli runs the CLI there; box.verify writes a receipt and
// runs `verify --json` on it, and checks that the clean copy was removed.
export async function sandbox(fn) {
  return withTemp(async (dir) => {
    const box = { dir, repo: path.join(dir, 'repo'), home: path.join(dir, 'home'), tmp: path.join(dir, 'tmp') };
    fs.mkdirSync(box.home);
    fs.mkdirSync(box.tmp);
    box.cli = (args, opts = {}) => startCli(args, { home: box.home, tmp: box.tmp, ...opts }).done;
    box.start = (args, opts = {}) => startCli(args, { home: box.home, tmp: box.tmp, ...opts });
    box.writeReceipt = (receipt, name = 'receipt.json') => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, typeof receipt === 'string' ? receipt : `${JSON.stringify(receipt, null, 2)}\n`);
      return file;
    };
    box.verify = async (receipt, { args = [], repo = box.repo, env = {}, json = true, name } = {}) => {
      const file = box.writeReceipt(receipt, name);
      const r = await box.cli(['verify', file, '--repo', repo, ...(json ? ['--json'] : []), ...args], { env });
      r.file = file;
      if (json) {
        assert.doesNotThrow(() => { r.json = JSON.parse(r.stdout); }, `verify --json printed JSON (stderr: ${r.stderr})`);
        assert.equal(r.json.exit_code, r.code, 'exit_code in the report matches the exit status');
      }
      if (!args.includes('--keep')) assert.deepEqual(leftovers(box.tmp), [], 'the clean copy was removed');
      return r;
    };
    return fn(box);
  });
}

export const reasonCodes = (report) => report.reasons.map((r) => r.code);
export const findingCodes = (report) => report.findings.map((f) => f.code);

// Whether a process is still running; a zombie (exited, not yet reaped by
// whoever adopted it) counts as gone.
export function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (fs.existsSync(`/proc/${pid}/stat`)) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
    } catch {
      return false;
    }
  }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const state = (ps.stdout ?? '').trim();
  return state !== '' && !state.startsWith('Z');
}

export async function waitFor(predicate, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) assert.fail(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

// The pid a check wrote to a file, once it is there.
export async function readPid(file) {
  await waitFor(() => fs.existsSync(file) && /^[0-9]+\n$/.test(fs.readFileSync(file, 'utf8')), 15000, `a pid in ${file}`);
  return Number(fs.readFileSync(file, 'utf8'));
}

// Where a piece of text starts, as { line, column }, counting from 1.
export function positionOf(text, needle, from = 0) {
  const offset = text.indexOf(needle, from);
  assert.notEqual(offset, -1, `${needle} is in the text`);
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: before[before.length - 1].length + 1 };
}

// A copy with ordinary prototypes, for deepEqual against plain literals.
export const plain = (value) => JSON.parse(JSON.stringify(value));
