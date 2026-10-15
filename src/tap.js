// TAP (versions 13 and 14, including the indented subtests that Node's test
// runner prints) reduced to three numbers: passed, failed and skipped.
//
// The reader is strict on purpose. A stream it cannot account for line by
// line gives a problem, never a count: no plan, a plan that disagrees with
// the tests that ran, numbers out of order, or output that stops inside a
// subtest or a YAML block all mean tests may be missing.
//
// Counting rules:
// - Only leaf tests count. A test line that closes a block of subtests is a
//   group (a describe() block, a file, a test with t.test() children); its
//   leaves are counted instead. JUnit reports count the same way.
// - A group that failed with no failing test inside it (a hook that threw,
//   say) counts as one failure, so a failure is never lost.
// - A SKIP or TODO directive makes a test skipped, whether it says ok or
//   not ok: the runner did not hold it to a verdict.
// - Lines inside YAML diagnostic blocks are skipped, so text there that looks
//   like "ok 7" is never counted.

const TEST_LINE = /^(not )?ok(?: +([0-9]+))?(?: +(.*))?$/;
const PLAN_LINE = /^1\.\.([0-9]+)(?: *#.*)?$/;
const BAIL_LINE = /^Bail out!(.*)$/;
const VERSION_LINE = /^TAP version ([0-9]+)$/;
const DIRECTIVE = /^#\s*(skip|todo)\S*(?:\s|$)/i;

export function parseTap(text) {
  const lines = text.split(/\r?\n/);
  const root = block(0);
  const stack = [root];
  let yaml = null; // the indentation of the open YAML block's --- line
  let lastTestIndent = null; // set on the line right after a test line
  let sawTap = false;
  let bailOut = null;

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const at = `line ${n + 1}`;
    if (yaml !== null) {
      if (line.trimEnd() === `${' '.repeat(yaml)}...`) yaml = null;
      continue;
    }
    const indent = /^ */.exec(line)[0].length;
    const body = line.slice(indent).trimEnd();
    const afterTest = lastTestIndent;
    lastTestIndent = null;
    if (body === '' || body.startsWith('#')) continue;
    if (body === '---' && afterTest !== null && indent === afterTest + 2) {
      yaml = indent;
      continue;
    }

    const bail = BAIL_LINE.exec(body);
    if (bail) {
      bailOut = bail[1].trim() || 'no reason given';
      break;
    }
    const version = VERSION_LINE.exec(body);
    if (version && indent === 0) {
      if (sawTap) return problem(`${at}: a second "TAP version" line; two TAP streams in one output? Give each its own check`);
      if (version[1] !== '13' && version[1] !== '14') return problem(`${at}: TAP version ${version[1]} is not supported (13 and 14 are)`);
      sawTap = true;
      continue;
    }
    const test = TEST_LINE.exec(body);
    const plan = test ? null : PLAN_LINE.exec(body);
    if (!test && !plan) continue; // not TAP; TAP consumers ignore such lines
    sawTap = true;

    if (indent % 4 !== 0) return problem(`${at}: a ${test ? 'test' : 'plan'} line indented by ${indent} spaces; subtests are indented in steps of 4`);
    const depth = indent / 4;
    let top = stack[stack.length - 1];
    if (depth > top.depth) {
      if (depth > top.depth + 1) return problem(`${at}: indented ${depth - top.depth} levels deeper than the block it is in`);
      top = block(depth);
      stack.push(top);
    }
    let children = null;
    while (top.depth > depth) {
      const closed = stack.pop();
      const issue = planIssue(closed);
      if (issue) return problem(`${at}: ${issue}`);
      if (children) return problem(`${at}: a block of subtests ended without its own test line`);
      children = closed;
      top = stack[stack.length - 1];
    }

    if (plan) {
      if (children) return problem(`${at}: a block of subtests is followed by a plan instead of its test line`);
      if (top.plan !== null) {
        return problem(`${at}: a second plan line${depth === 0 ? '; two TAP streams in one output? Give each its own check' : ''}`);
      }
      top.plan = Number(plan[1]);
      top.planFirst = top.tests.length === 0;
      continue;
    }

    if (top.plan !== null && !top.planFirst) return problem(`${at}: a test line after the closing plan`);
    const number = test[2] === undefined ? null : Number(test[2]);
    if (number !== null && number !== top.tests.length + 1) {
      return problem(`${at}: test number ${number} where ${top.tests.length + 1} was expected`);
    }
    top.tests.push({ ok: !test[1], directive: directive(test[3] ?? ''), children });
    lastTestIndent = indent;
  }

  if (bailOut !== null) {
    // The run stopped; count what it reported, open blocks included.
    const counts = zero();
    for (const open of stack) tally(open.tests, counts);
    return { counts, bailOut };
  }
  if (yaml !== null) return problem('the output ends inside a YAML block; was it cut short?');
  if (stack.length > 1) return problem('the output ends inside a block of subtests; was it cut short?');
  const issue = planIssue(root);
  if (issue) return problem(issue);
  return { counts: tally(root.tests, zero()), bailOut: null };
}

const block = (depth) => ({ depth, tests: [], plan: null, planFirst: false });
const zero = () => ({ passed: 0, failed: 0, skipped: 0 });
const problem = (message) => ({ problem: message });

function planIssue(b) {
  const where = b.depth === 0 ? '' : 'a block of subtests: ';
  if (b.plan === null) {
    return b.depth === 0
      ? 'no plan line (1..N); the output may have been cut short, or it is not TAP'
      : `${where}no plan line (1..N)`;
  }
  if (b.plan !== b.tests.length) return `${where}the plan says ${b.plan} tests, but ${b.tests.length} reported`;
  return null;
}

// The first "#" not escaped as "\#" that starts SKIP or TODO is the directive.
function directive(rest) {
  for (let n = 0; n < rest.length; n++) {
    if (rest[n] === '\\') {
      n++;
      continue;
    }
    if (rest[n] !== '#') continue;
    const match = DIRECTIVE.exec(rest.slice(n));
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function tally(tests, counts) {
  for (const t of tests) {
    if (t.children) {
      const before = counts.failed;
      tally(t.children.tests, counts);
      if (!t.ok && !t.directive && counts.failed === before) counts.failed++;
    } else if (t.directive) counts.skipped++;
    else if (t.ok) counts.passed++;
    else counts.failed++;
  }
  return counts;
}
