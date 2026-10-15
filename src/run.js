// Running one check: strict bash, a clean environment, a time limit that
// stops everything the check started, and optionally no network.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const STDOUT_LIMIT = 32 * 1024 * 1024; // TAP is read from stdout, so keep it whole, up to this
const STDERR_LIMIT = 256 * 1024; // only the end is shown
const GRACE_MS = 2000;
const running = new Set();

// Each check runs as `bash -e -o pipefail -c <run>`: a failing command fails
// the check, inside a pipeline too, so `false | cat` fails.
const STRICT_BASH = ['bash', '-e', '-o', 'pipefail', '-c'];
const UNSHARE = ['--user', '--map-root-user', '--net', '--'];
// Inside the new network namespace: bring loopback up (best effort; needs
// `ip`), then become the check.
const OFFLINE_SHELL = 'ip link set lo up 2>/dev/null; exec bash -e -o pipefail -c "$1"';

// What a check sees of the environment: PATH, without relative entries (they
// would let a file in the copy stand in for a real tool), and nothing else
// from the caller. HOME and TMPDIR are empty folders made for this run, so
// dotfiles, caches and tokens in the real home stay out of reach.
export function checkEnvironment({ home, tmp, ceiling, extra = {} }) {
  const PATH = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir)).join(path.delimiter);
  return {
    PATH,
    HOME: home,
    TMPDIR: tmp,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    TERM: 'dumb',
    NO_COLOR: '1',
    GIT_CEILING_DIRECTORIES: ceiling, // the copy has no .git; don't let git find one above it
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

let offline = null;
// Whether checks can run without a network here: Linux, with unprivileged
// user namespaces allowed. Probed once, with the command the checks use.
export function offlineSupport() {
  if (offline) return offline;
  if (process.platform !== 'linux') {
    offline = { ok: false, why: `running without a network needs Linux network namespaces, and this system is ${process.platform}` };
    return offline;
  }
  const probe = spawnSync('unshare', [...UNSHARE, 'true'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 });
  if (probe.error) offline = { ok: false, why: `unshare could not run (${probe.error.code})` };
  else if (probe.status !== 0) {
    const said = probe.stderr.toString().trim().split('\n').pop();
    offline = { ok: false, why: `this system does not allow unprivileged network namespaces (unshare: ${said || `exit ${probe.status}`})` };
  } else offline = { ok: true };
  return offline;
}

// Resolves with { exitCode, signal, timedOut, startError, seconds, stdout,
// stderr, stdoutTruncated }. Never rejects.
export function runCheck({ run, cwd, env, timeoutSeconds, offline: noNetwork = false }) {
  const argv = noNetwork
    ? ['unshare', ...UNSHARE, 'bash', '-c', OFFLINE_SHELL, 'receipt-check', run]
    : [...STRICT_BASH, run];
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let timer = null;
    let settled = false;
    let timedOut = false;
    // detached: the check leads a process group of its own, so stopping it
    // stops everything it started, not only the shell.
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = collect(child.stdout, STDOUT_LIMIT, 'head');
    const stderr = collect(child.stderr, STDERR_LIMIT, 'tail');
    const finish = (fields) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(child.pid);
      resolve({
        exitCode: null,
        signal: null,
        timedOut,
        startError: null,
        ...fields,
        seconds: Number(process.hrtime.bigint() - started) / 1e9,
        stdout: stdout.bytes(),
        stderr: stderr.bytes(),
        stdoutTruncated: stdout.truncated(),
      });
    };

    if (child.pid) running.add(child.pid);
    timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child.pid, 'SIGTERM');
      setTimeout(() => signalGroup(child.pid, 'SIGKILL'), GRACE_MS).unref();
    }, timeoutSeconds * 1000);

    child.on('error', (error) => {
      finish({ startError: error.code === 'ENOENT' ? `${argv[0]} was not found on PATH` : error.message });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      // Nothing the check started may outlive it, or hold its output open.
      signalGroup(child.pid, 'SIGKILL');
      const drained = Promise.all([stdout.closed, stderr.closed]);
      const giveUp = new Promise((done) => setTimeout(done, GRACE_MS).unref());
      Promise.race([drained, giveUp]).then(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ exitCode: code, signal });
      });
    });
  });
}

// On Ctrl-C: stop every check that is still running.
export function stopAllChecks() {
  for (const pid of running) signalGroup(pid, 'SIGKILL');
}

function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // the group has already gone
  }
}

function collect(stream, limit, keep) {
  let chunks = [];
  let size = 0;
  let truncated = false;
  stream.on('data', (chunk) => {
    if (keep === 'head') {
      if (size >= limit) {
        truncated = true;
        return;
      }
      if (size + chunk.length > limit) {
        chunk = chunk.subarray(0, limit - size);
        truncated = true;
      }
      chunks.push(chunk);
      size += chunk.length;
    } else {
      chunks.push(chunk);
      size += chunk.length;
      while (chunks.length > 1 && size - chunks[0].length >= limit) {
        size -= chunks.shift().length;
        truncated = true;
      }
    }
  });
  const closed = new Promise((done) => stream.once('close', done));
  return { closed, bytes: () => Buffer.concat(chunks), truncated: () => truncated };
}
