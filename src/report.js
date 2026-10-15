// Turning a result into text for a person or JSON for a program.

import { DECIDING_EFFECT } from './verify.js';

const MARK = { ok: '✓', refutes: '✗', incomplete: '?' };
const TAIL_LINES = 10;

export function textReport(result, label) {
  const short = result.commit.slice(0, 12);
  const deciding = result.findings.filter((f) => f.effect === DECIDING_EFFECT[result.verdict]);
  const others = result.findings.filter((f) => f.effect !== DECIDING_EFFECT[result.verdict]);
  const headline = {
    VERIFIED: `every claim in ${label} held at ${short}`,
    REFUTED: `${deciding.length} ${deciding.length === 1 ? 'claim' : 'claims'} in ${label} did not hold at ${short}`,
    INCOMPLETE: `${label} could not be fully checked at ${short}`,
  }[result.verdict];

  const lines = [`${result.verdict}: ${headline}`];
  for (const f of [...deciding, ...others]) lines.push(`  ${MARK[f.effect]} ${f.message}`);
  for (const check of result.checks) {
    if (check.outcome !== 'failed' && check.outcome !== 'incomplete') continue;
    for (const [stream, text] of [['stdout', check.stdout_tail], ['stderr', check.stderr_tail]]) {
      const end = lastLines(text, TAIL_LINES);
      if (end.length) lines.push(`  last lines of ${stream} from check "${check.id}":`, ...end.map((l) => `    | ${l}`));
    }
  }
  lines.push(result.network === 'off' ? '  network: off (--offline)' : '  network: on (on Linux, --offline runs the checks without it)');
  if (result.copy?.kept) lines.push(`  clean copy kept at ${result.copy.kept}`);
  return `${lines.join('\n')}\n`;
}

export function jsonReport(result, meta) {
  const report = {
    tool: 'receipt-check',
    version: meta.version,
    verdict: result.verdict,
    exit_code: meta.exitCode,
    receipt: meta.receipt,
    commit: result.commit,
    network: result.network,
    reasons: result.reasons.map(({ code, message }) => ({ code, message })),
    findings: result.findings,
    checks: result.checks,
    delivered: result.delivered,
    done_when: result.done_when,
    copy: result.copy,
    ledger: meta.ledger ?? null,
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

function lastLines(text, n) {
  const lines = (text ?? '').replace(/\s+$/, '').split('\n');
  return lines.length === 1 && lines[0] === '' ? [] : lines.slice(-n);
}
