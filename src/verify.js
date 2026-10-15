// Checking a receipt: compare each claim with evidence produced again, from
// the exact commit, in a clean copy.
//
// Every finding has an effect: 'ok' (a claim held), 'refutes' (the evidence
// contradicts the claim) or 'incomplete' (the claim could not be checked).
// Any refutation makes the verdict REFUTED. Otherwise anything left unchecked
// makes it INCOMPLETE. Only a receipt whose every claim held is VERIFIED.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportCommit, objectType, pathsExist, repositoryInfo } from './git.js';
import { parseJunit } from './junit.js';
import { checkEnvironment, offlineSupport, runCheck } from './run.js';
import { parseTap } from './tap.js';

const REPORT_LIMIT = 64 * 1024 * 1024;
const TAIL_BYTES = 4096;
const EVIDENCE = { tap: 'TAP output', junit: 'JUnit report' };

export class SetupError extends Error {}

export function verdictOf(findings) {
  if (findings.some((f) => f.effect === 'refutes')) return 'REFUTED';
  if (findings.some((f) => f.effect === 'incomplete')) return 'INCOMPLETE';
  return 'VERIFIED';
}

export const DECIDING_EFFECT = { VERIFIED: 'ok', REFUTED: 'refutes', INCOMPLETE: 'incomplete' };

export async function verifyReceipt(receipt, { repo, offline = false, keep = false, progress = () => {} }) {
  const findings = [];
  const note = (effect, code, message, extra = {}) => findings.push({ effect, code, message, ...extra });
  const short = receipt.commit.slice(0, 12);
  const result = { commit: receipt.commit, network: offline ? 'off' : 'on', copy: null, checks: [], delivered: [], done_when: [] };

  const info = await repositoryInfo(repo);
  if (!info) throw new SetupError(`${repo} is not inside a git repository (point --repo at the one the receipt is about)`);

  let canRun = true;
  if (offline) {
    const support = offlineSupport();
    if (!support.ok) {
      note('incomplete', 'offline-unavailable', `--offline was asked for, but ${support.why}; no check was run`);
      canRun = false;
    }
  }

  const type = await objectType(repo, receipt.commit);
  if (type === 'commit') note('ok', 'commit-found', `commit ${short} exists`);
  else if (type) note('refutes', 'not-a-commit', `${short} names a ${type}, not a commit`);
  else if (info.shallow) {
    note('incomplete', 'commit-not-fetched', `commit ${short} is not in this shallow clone; fetch the full history (git fetch --unshallow) and check again`);
  } else {
    note('refutes', 'commit-missing', `commit ${short} does not exist in this repository (if it was pushed somewhere else, fetch it first)`);
  }

  if (type === 'commit') {
    if (receipt.delivered.length) {
      const present = await pathsExist(repo, receipt.commit, receipt.delivered);
      receipt.delivered.forEach((p, n) => {
        result.delivered.push({ path: p, present: present[n] });
        if (!present[n]) note('refutes', 'delivered-missing', `delivered path ${p} does not exist at ${short}`, { path: p });
      });
      if (present.every(Boolean)) note('ok', 'delivered-present', `all ${present.length} delivered paths exist at ${short}`);
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-check-'));
    const copy = path.join(work, 'copy');
    const home = path.join(work, 'home');
    const tmp = path.join(work, 'tmp');
    try {
      if (canRun) {
        try {
          progress(`exporting ${short} into a clean copy`);
          const files = await exportCommit(repo, receipt.commit, copy);
          fs.mkdirSync(home);
          fs.mkdirSync(tmp);
          result.copy = { files };
          note('ok', 'copy-made', `exported ${files} files from ${short} into a clean copy: no .git, nothing uncommitted or untracked`);
        } catch (error) {
          note('incomplete', 'copy-failed', `could not export ${short}: ${error.message}`);
          canRun = false;
        }
      }
      if (canRun) {
        for (const check of receipt.checks) {
          progress(`running check "${check.id}" (limit ${check.timeout_seconds} s): ${check.run}`);
          const env = checkEnvironment({ home, tmp, ceiling: work, extra: check.env });
          const run = await runCheck({ run: check.run, cwd: copy, env, timeoutSeconds: check.timeout_seconds, offline });
          result.checks.push(judgeCheck(check, run, copy, note));
        }
      }
    } finally {
      if (keep) result.copy = { ...result.copy, kept: work };
      else removeTree(work);
    }
  }

  for (const check of receipt.checks) {
    if (!result.checks.some((c) => c.id === check.id)) result.checks.push(notRun(check));
  }

  for (const item of receipt.done_when) {
    const check = result.checks.find((c) => c.id === item.check);
    const label = `done-when "${item.id}" (${item.text})`;
    let met = null;
    if (check.outcome === 'passed') {
      met = true;
      note('ok', 'done-when-met', `${label} is met: check "${item.check}" passed`);
    } else if (check.outcome === 'failed') {
      met = false;
      note('refutes', 'done-when-unmet', `${label} is not met: check "${item.check}" failed`);
    } else {
      note('incomplete', 'done-when-unproven', `${label} is unproven: check "${item.check}" ${check.outcome === 'not-run' ? 'was not run' : 'did not finish'}`);
    }
    result.done_when.push({ id: item.id, check: item.check, met });
  }

  const verdict = verdictOf(findings);
  const reasons = findings.filter((f) => f.effect === DECIDING_EFFECT[verdict]);
  return { verdict, reasons, findings, ...result };
}

// Compares one check's rerun with what the receipt claims for it.
function judgeCheck(check, run, copy, note) {
  const out = {
    id: check.id,
    run: check.run,
    format: check.format,
    exit_code: run.exitCode,
    signal: run.signal,
    timed_out: run.timedOut,
    seconds: Math.round(run.seconds * 10) / 10,
    counts: null,
    claimed: check.counts,
    outcome: null,
    stdout_tail: tail(run.stdout),
    stderr_tail: tail(run.stderr),
  };
  const effects = [];
  const add = (effect, code, message) => {
    effects.push(effect);
    note(effect, code, message, { check: check.id });
  };
  const name = `check "${check.id}"`;

  if (run.startError) add('incomplete', 'check-not-started', `${name} could not start: ${run.startError}`);
  else if (run.timedOut) add('incomplete', 'check-timed-out', `${name} was still running after ${check.timeout_seconds} s and was stopped`);
  else {
    if (run.exitCode !== 0) {
      add('refutes', 'check-failed', run.signal ? `${name} was killed by ${run.signal}` : `${name} exited with ${run.exitCode}`);
    }
    if (check.format !== 'exit-code') judgeEvidence(check, run, copy, out, add);
  }

  out.outcome = effects.includes('refutes') ? 'failed' : effects.includes('incomplete') ? 'incomplete' : 'passed';
  if (out.outcome === 'passed') {
    const counted = out.counts ? `; ${EVIDENCE[check.format]} shows ${describeCounts(out.counts)}, as claimed` : '';
    note('ok', 'check-passed', `${name} passed: exit 0 in ${out.seconds} s${counted}`, { check: check.id });
  }
  return out;
}

function judgeEvidence(check, run, copy, out, add) {
  const name = `check "${check.id}"`;
  const kind = EVIDENCE[check.format];
  let text;
  if (check.file) {
    const file = path.join(copy, check.file);
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      add('incomplete', 'evidence-missing', `${name} did not write ${check.file}, so there are no counts to compare`);
      return;
    }
    if (size > REPORT_LIMIT) {
      add('incomplete', 'evidence-too-large', `${name} wrote ${check.file} of ${size} bytes, more than the ${REPORT_LIMIT} this reads`);
      return;
    }
    text = fs.readFileSync(file, 'utf8');
  } else {
    if (run.stdoutTruncated) {
      add('incomplete', 'evidence-too-large', `${name} printed more output than receipt-check keeps, so its ${kind} can't be read whole`);
      return;
    }
    text = run.stdout.toString('utf8');
  }

  const parsed = check.format === 'tap' ? parseTap(text) : parseJunit(text);
  const source = check.file ?? 'stdout';
  if (parsed.problem) {
    add('incomplete', 'evidence-unreadable', `${name}: can't read its ${kind} (${source}): ${parsed.problem}`);
    return;
  }
  out.counts = parsed.counts;
  if (parsed.bailOut) add('refutes', 'tests-bailed-out', `${name}: the tests bailed out (${parsed.bailOut})`);
  const seen = parsed.counts;
  const claimed = check.counts;
  if (seen.failed > 0 && run.exitCode === 0) {
    add('refutes', 'failures-reported', `${name} exited 0, but its ${kind} reports ${seen.failed} failed`);
  }
  if (seen.passed !== claimed.passed || seen.failed !== claimed.failed || seen.skipped !== claimed.skipped) {
    add('refutes', 'counts-differ', `${name} claimed ${describeCounts(claimed)}; its ${kind} shows ${describeCounts(seen)}`);
  }
}

function notRun(check) {
  return {
    id: check.id, run: check.run, format: check.format, exit_code: null, signal: null, timed_out: false,
    seconds: null, counts: null, claimed: check.counts, outcome: 'not-run', stdout_tail: '', stderr_tail: '',
  };
}

export const describeCounts = (c) => `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped`;

function tail(bytes) {
  const text = bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)).toString('utf8');
  return text;
}

// Some tools leave read-only folders behind (module caches); make them
// writable so the copy can always be removed.
function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    const open = (p) => {
      try {
        fs.chmodSync(p, 0o700);
        for (const entry of fs.readdirSync(p, { withFileTypes: true })) if (entry.isDirectory()) open(path.join(p, entry.name));
      } catch {
        // keep going; rmSync reports what is left
      }
    };
    open(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
