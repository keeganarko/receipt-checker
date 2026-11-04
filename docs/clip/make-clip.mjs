#!/usr/bin/env node
// Builds docs/clip/refuted.svg: a short terminal clip of receipt-check refusing
// a PASS that only held because of a file that was never committed.
//
// The repository in the clip is a throwaway sample made here, in a temporary
// folder. Every line of output in the clip comes from running the commands
// below with this checkout's bin/receipt-check.js. One thing is trimmed: the
// stack trace receipt-check quotes from the failing check, which names a
// temporary path, is cut to its last lines.
//
//   node docs/clip/make-clip.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const bin = join(root, 'bin', 'receipt-check.js');
const work = mkdtempSync(join(tmpdir(), 'receipt-clip-'));

const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=Sample', '-c', 'user.email=sample@example.com', ...args], {
    cwd: work,
    encoding: 'utf8',
  });

let transcript;
try {
  git('init', '-q', '-b', 'main');
  writeFileSync(
    join(work, 'config.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import { readFileSync } from 'node:fs';",
      "test('reads the config', () => JSON.parse(readFileSync('config.json', 'utf8')));",
      '',
    ].join('\n'),
  );
  writeFileSync(join(work, 'config.json'), '{}\n');
  git('add', 'config.test.mjs');
  git('commit', '-q', '-m', 'Add a config test');
  const commit = git('rev-parse', 'HEAD').trim();

  const local = spawnSync('node', ['--test', 'config.test.mjs'], { cwd: work, encoding: 'utf8' });
  if (local.status !== 0) throw new Error('the sample test should pass in its own checkout');

  const receipt =
    `{ "receipt": "receipt-check/1", "status": "PASS", "commit": "${commit}",\n` +
    `  "checks": [{ "id": "config", "run": "node --test config.test.mjs" }] }\n`;
  writeFileSync(join(work, 'receipt.json'), receipt);

  const verify = spawnSync('node', [bin, 'verify', 'receipt.json'], { cwd: work, encoding: 'utf8' });
  if (verify.status !== 1) throw new Error(`expected REFUTED (exit 1), got exit ${verify.status}`);

  const status = git('status', '--short', 'config.json');

  transcript = {
    receipt: receipt.trimEnd().split('\n'),
    verify: trimTrace([...lines(verify.stderr), ...lines(verify.stdout)]),
    status: lines(status),
  };
} finally {
  rmSync(work, { recursive: true, force: true });
}

const all = [...transcript.receipt, ...transcript.verify, ...transcript.status].join('\n');
for (const leak of ['/Users/', '/home/', '/private/', '/var/folders/', '/tmp/', tmpdir()]) {
  if (all.includes(leak)) throw new Error(`the clip would show a local path (${leak})`);
}

// The script: [delay before the line appears, in seconds, kind, text].
const script = [
  [0.6, 'comment', '# An agent wrote a test, ran it, and it passed.'],
  [1.2, 'cmd', 'node --test config.test.mjs > /dev/null && echo "passes on my machine"'],
  [1.4, 'out', 'passes on my machine'],
  [1.8, 'comment', '# So it hands over a receipt that says PASS:'],
  [1.2, 'cmd', 'cat receipt.json'],
  ...transcript.receipt.map((t, i) => [i ? 0.1 : 0.5, 'out', t]),
  [2.4, 'cmd', 'receipt-check verify receipt.json'],
  ...transcript.verify.map((t, i) => [delayFor(t, i), kindOf(t), t]),
  [3.0, 'comment', '# Why it failed: the config file was never committed.'],
  [1.2, 'cmd', 'git status --short config.json'],
  ...transcript.status.map((t) => [0.5, 'untracked', t]),
];

writeFileSync(join(here, 'refuted.svg'), render(script));
const total = script.reduce((s, [d]) => s + d, 0);
console.log(`wrote docs/clip/refuted.svg: ${script.length} lines, ${total.toFixed(1)} s`);

function lines(text) {
  return text.replace(/\s+$/, '').split('\n');
}

// Keep the last lines receipt-check quotes from the failing check: the error's
// code, call and path. The stack frames above them name a temporary folder.
function trimTrace(out) {
  const keep = /^\s+\|\s+(code:|syscall:|path:|\}$)/;
  const result = [];
  let cut = false;
  for (const line of out) {
    if (/^\s+\|/.test(line) && !keep.test(line)) {
      if (!cut) result.push('    | …');
      cut = true;
      continue;
    }
    result.push(line);
  }
  return result;
}

function kindOf(t) {
  if (/^REFUTED/.test(t)) return 'refuted';
  if (/^\s+✗/.test(t)) return 'bad';
  if (/^\s+✓/.test(t)) return 'ok';
  if (/^\s+\|/.test(t)) return 'quote';
  return 'dim';
}

function delayFor(t, i) {
  if (i === 0) return 0.6;
  if (/^receipt-check: running/.test(t)) return 0.9;
  if (/^REFUTED/.test(t)) return 1.6;
  if (/^\s+\|/.test(t)) return 0.08;
  return 0.35;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render(rows) {
  const W = 920;
  const lineH = 19;
  const top = 58;
  const left = 22;
  const footH = 40;
  // A little air above each comment, so the clip reads in steps.
  const gap = 9;
  const gaps = rows.filter(([, kind], i) => i > 0 && kind === 'comment').length;
  const H = top + rows.length * lineH + gaps * gap + footH;
  let t = 0;
  let y = top - lineH;
  const body = rows
    .map(([delay, kind, text], i) => {
      t += delay;
      y += lineH + (i > 0 && kind === 'comment' ? gap : 0);
      const style = `animation-delay:${t.toFixed(2)}s`;
      let inner;
      if (kind === 'cmd') inner = `<tspan class="prompt">$ </tspan><tspan class="cmd">${esc(text)}</tspan>`;
      else if (kind === 'ok' || kind === 'bad') {
        const m = text.match(/^(\s+)([✓✗])(.*)$/);
        inner = `${esc(m[1])}<tspan class="${kind}">${m[2]}</tspan>${esc(m[3])}`;
      } else inner = esc(text);
      const cls = kind === 'ok' || kind === 'bad' ? 'mark' : kind;
      return `  <text class="l ${cls}" x="${left}" y="${y}" style="${style}" xml:space="preserve">${inner}</text>`;
    })
    .join('\n');
  const total = t.toFixed(1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">receipt-check refusing a PASS that only held because of an uncommitted file</title>
  <desc id="desc">A sample terminal session, about ${Math.round(Number(total))} seconds long. An agent's test passes in its own checkout and it hands over a receipt that says PASS. receipt-check reruns the check from the exact commit in a clean copy and answers REFUTED: the check exits with 1 because config.json was never committed. git status confirms config.json is untracked.</desc>
  <style>
    text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 13.5px; fill: #c9d1d9; white-space: pre; }
    .l { opacity: 0; animation: show 0.01s linear forwards; }
    @keyframes show { to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .l { animation: none; opacity: 1; } }
    .prompt { fill: #79c0ff; font-weight: 600; }
    .cmd { fill: #f0f6fc; font-weight: 600; }
    .comment { fill: #8b949e; font-style: italic; }
    .dim, .quote { fill: #8b949e; }
    .refuted { fill: #ff7b72; font-weight: 700; }
    .bad { fill: #ff7b72; font-weight: 700; }
    .ok { fill: #7ee787; font-weight: 700; }
    .untracked { fill: #ffa657; }
    .title, .foot { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 12.5px; fill: #8b949e; }
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="#0d1117" stroke="#30363d"/>
  <circle cx="22" cy="20" r="6" fill="#ff5f57"/>
  <circle cx="42" cy="20" r="6" fill="#febc2e"/>
  <circle cx="62" cy="20" r="6" fill="#28c840"/>
  <text class="title" x="${W / 2}" y="24" text-anchor="middle">receipt-check 0.1.0 · sample repository</text>
  <line x1="0" y1="38" x2="${W}" y2="38" stroke="#30363d"/>
${body}
  <line x1="0" y1="${H - footH + 6}" x2="${W}" y2="${H - footH + 6}" stroke="#30363d"/>
  <text class="foot" x="${left}" y="${H - 14}">Sample repository made by docs/clip/make-clip.mjs. Output is from a real run; a long stack trace is trimmed to its last lines (…).</text>
</svg>
`;
}
