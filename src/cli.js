// The command line: verify, lint and ledger.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { appendToLedger, checkLedger } from './ledger.js';
import { RECEIPT_FORMAT, readReceipt } from './receipt.js';
import { jsonReport, textReport } from './report.js';
import { SetupError, verifyReceipt } from './verify.js';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const EXIT = { VERIFIED: 0, REFUTED: 1, INCOMPLETE: 2, INVALID: 3, ERROR: 4 };
const RECEIPT_LIMIT = 1024 * 1024;

const HELP = `receipt-check ${VERSION}: checks an AI agent's "done" receipt by rerunning it

Usage:
  receipt-check verify <receipt.json | -> [--repo DIR] [--offline] [--json]
                                          [--ledger FILE] [--keep]
  receipt-check lint <receipt.json | -> [--json]
  receipt-check ledger <FILE> [--json]

verify   Export the receipt's commit into a clean copy, rerun its checks
         there, and compare what happened with what the receipt claims.
lint     Check a receipt's format without running anything.
ledger   Check that a ledger's hash chain is intact.

Options:
  --repo DIR     the git repository the receipt is about (default: .)
  --offline      run the checks with no network (Linux only; elsewhere the
                 verdict is INCOMPLETE rather than a silent run with network)
  --json         print the result as JSON
  --ledger FILE  append the verdict to a hash-chained ledger
  --keep         keep the clean copy and print where it is

Exit codes:
  0  VERIFIED (lint: the receipt is valid; ledger: the chain is intact)
  1  REFUTED (ledger: the chain is broken)
  2  INCOMPLETE
  3  the receipt is not valid ${RECEIPT_FORMAT}
  4  usage or setup error, or the ledger could not be written

verify runs the commands in the receipt: read a receipt before you run it.
Receipt format: https://github.com/keeganarko/receipt-checker#the-receipt
`;

class UsageError extends Error {}

export async function main(argv, io) {
  const [command, ...args] = argv;
  try {
    if (command === 'verify') return await verifyCommand(args, io);
    if (command === 'lint') return await lintCommand(args, io);
    if (command === 'ledger') return ledgerCommand(args, io);
    if (command === 'help' || command === '--help' || command === '-h') {
      io.stdout.write(HELP);
      return 0;
    }
    if (command === 'version' || command === '--version') {
      io.stdout.write(`${VERSION}\n`);
      return 0;
    }
    throw new UsageError(command === undefined ? 'no command given' : `unknown command "${command}"`);
  } catch (error) {
    const usage = error instanceof UsageError || String(error.code).startsWith('ERR_PARSE_ARGS');
    io.stderr.write(`receipt-check: ${error.message}\n${usage ? 'Run receipt-check --help for usage.\n' : ''}`);
    return EXIT.ERROR;
  }
}

async function verifyCommand(args, io) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: 'string', default: '.' },
      offline: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      ledger: { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 1) throw new UsageError('verify takes one receipt file, or - to read it from stdin');
  if (process.platform === 'win32') throw new SetupError('verify needs Linux or macOS: it runs each check with bash in a process group of its own');
  const { bytes, label } = await readInput(positionals[0], io);
  const loaded = loadReceipt(bytes);
  if (loaded.errors) return invalid(loaded.errors, label, values.json, 'nothing was run', io);

  const progress = values.json ? () => {} : (message) => io.stderr.write(`receipt-check: ${message}\n`);
  const result = await verifyReceipt(loaded.receipt, { repo: values.repo, offline: values.offline, keep: values.keep, progress });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let exitCode = EXIT[result.verdict];
  let ledger = null;
  if (values.ledger) {
    try {
      const entry = await appendToLedger(values.ledger, {
        verdict: result.verdict,
        commit: result.commit,
        receipt_sha256: sha256,
        reasons: result.reasons.map((r) => r.message),
        checker: `receipt-check ${VERSION}`,
      });
      ledger = { file: values.ledger, seq: entry.seq, hash: entry.hash };
    } catch (error) {
      ledger = { file: values.ledger, error: error.message };
      exitCode = EXIT.ERROR;
    }
  }

  if (values.json) {
    io.stdout.write(jsonReport(result, { version: VERSION, exitCode, receipt: { path: label, sha256 }, ledger }));
  } else {
    io.stdout.write(textReport(result, label));
    if (ledger?.error) io.stderr.write(`receipt-check: the verdict was not recorded: ${ledger.error}\n`);
    else if (ledger) io.stdout.write(`  ledger: entry ${ledger.seq} in ${ledger.file}, hash ${ledger.hash}\n`);
  }
  return exitCode;
}

async function lintCommand(args, io) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean', default: false } } });
  if (positionals.length !== 1) throw new UsageError('lint takes one receipt file, or - to read it from stdin');
  const { bytes, label } = await readInput(positionals[0], io);
  const loaded = loadReceipt(bytes);
  if (loaded.errors) return invalid(loaded.errors, label, values.json, `not a valid ${RECEIPT_FORMAT} receipt`, io);
  const r = loaded.receipt;
  if (values.json) {
    io.stdout.write(`${JSON.stringify({ tool: 'receipt-check', version: VERSION, valid: true, receipt: r }, null, 2)}\n`);
  } else {
    const parts = [count(r.checks.length, 'check'), count(r.delivered.length, 'delivered path'), count(r.done_when.length, 'done-when item')];
    io.stdout.write(`${label}: a valid ${RECEIPT_FORMAT} receipt for commit ${r.commit.slice(0, 12)} (${parts.join(', ')})\n`);
  }
  return 0;
}

function ledgerCommand(args, io) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean', default: false } } });
  if (positionals.length !== 1) throw new UsageError('ledger takes one ledger file');
  const file = positionals[0];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new SetupError(`can't read ${file}: ${error.code === 'ENOENT' ? 'no such file' : error.message}`);
  }
  const state = checkLedger(text);
  if (values.json) {
    const report = state.problem
      ? { intact: false, line: state.problem.line, problem: state.problem.message }
      : { intact: true, entries: state.entries, head: state.head };
    io.stdout.write(`${JSON.stringify({ tool: 'receipt-check', version: VERSION, ledger: file, ...report }, null, 2)}\n`);
  } else if (state.problem) {
    io.stdout.write(`${file}: broken at line ${state.problem.line}: that entry ${state.problem.message}\n`);
  } else {
    io.stdout.write(`${file}: ${count(state.entries, 'entry', 'entries')}, hash chain intact${state.head ? `; newest hash ${state.head}` : ''}\n`);
  }
  return state.problem ? EXIT.REFUTED : 0;
}

async function readInput(name, io) {
  if (name === '-') {
    const chunks = [];
    for await (const chunk of io.stdin) chunks.push(chunk);
    return { bytes: Buffer.concat(chunks), label: 'stdin' };
  }
  try {
    return { bytes: fs.readFileSync(name), label: name };
  } catch (error) {
    throw new SetupError(`can't read ${name}: ${error.code === 'ENOENT' ? 'no such file' : error.message}`);
  }
}

function loadReceipt(bytes) {
  if (bytes.length > RECEIPT_LIMIT) return { errors: [{ path: null, message: `is ${bytes.length} bytes; a receipt can be at most ${RECEIPT_LIMIT}` }] };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { errors: [{ path: null, message: 'is not valid UTF-8 text' }] };
  }
  return readReceipt(text);
}

function invalid(errors, label, json, outcome, io) {
  if (json) {
    io.stdout.write(`${JSON.stringify({ tool: 'receipt-check', version: VERSION, verdict: null, exit_code: EXIT.INVALID, receipt: { path: label }, errors }, null, 2)}\n`);
  } else {
    for (const e of errors) {
      const where = e.line ? `${label}:${e.line}:${e.column}` : label;
      io.stderr.write(`${where}: ${e.path ? `${e.path}: ` : ''}${e.message}\n`);
    }
    io.stderr.write(`${label}: ${count(errors.length, 'problem')}; ${outcome}\n`);
  }
  return EXIT.INVALID;
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
