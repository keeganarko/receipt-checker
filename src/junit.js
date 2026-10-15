// JUnit XML reduced to three numbers, counted from the <testcase> elements.
//
// The summary attributes (tests=, failures=, skipped=) are ignored: runners
// fill them in inconsistently (Node's reporter counts a failing to-do test in
// both failures= and skipped=), and they can say anything. Each testcase is
// classified by its own child elements:
// - <skipped> makes it skipped, even beside a <failure>: that pairing is how
//   runners mark an expected failure, such as a to-do test;
// - otherwise <failure> or <error> makes it failed;
// - otherwise it passed.
//
// The XML reader is small but honest. It understands comments, CDATA and
// quoted attributes, so a "<testcase" inside a failure message or a comment is
// never counted, and it refuses what it cannot follow: mismatched or unclosed
// tags, a file cut short, a second root, or a DOCTYPE (entity expansion).

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const SPACE = /[ \t\r\n]*/y;

export function parseJunit(text) {
  if (text.startsWith('﻿')) text = text.slice(1);
  const counts = { passed: 0, failed: 0, skipped: 0 };
  const stack = [];
  let roots = 0;
  let testcase = null; // the open <testcase>: its depth and what it holds
  let i = 0;

  const lineAt = (offset) => text.slice(0, offset).split('\n').length;
  const problem = (message, offset = i) => ({ problem: `line ${lineAt(offset)}: ${message}` });
  const skipSpace = (from) => {
    SPACE.lastIndex = from;
    SPACE.exec(text);
    return SPACE.lastIndex;
  };
  const classify = (t) => {
    if (t.skipped) counts.skipped++;
    else if (t.failed) counts.failed++;
    else counts.passed++;
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const between = text.slice(i, lt === -1 ? text.length : lt);
    if (stack.length === 0 && between.trim() !== '') return problem('text outside the root element', i);
    if (lt === -1) break;
    i = lt;

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) return problem('a comment is never closed');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      if (stack.length === 0) return problem('CDATA outside the root element');
      const end = text.indexOf(']]>', i + 9);
      if (end === -1) return problem('a CDATA section is never closed');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end === -1) return problem('a processing instruction is never closed');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', i)) return problem('a DOCTYPE or other declaration; these are refused because they can expand entities');

    if (text.startsWith('</', i)) {
      NAME.lastIndex = i + 2;
      const name = NAME.exec(text)?.[0];
      if (!name) return problem('a closing tag without a name');
      const end = skipSpace(NAME.lastIndex);
      if (text[end] !== '>') return problem(`</${name} is not closed with >`);
      const open = stack.pop();
      if (open !== name) return problem(open ? `</${name}> closes <${open}>` : `</${name}> has no opening tag`);
      if (testcase && stack.length === testcase.depth) {
        classify(testcase);
        testcase = null;
      }
      i = end + 1;
      continue;
    }

    NAME.lastIndex = i + 1;
    const name = NAME.exec(text)?.[0];
    if (!name) return problem('a "<" that does not start a tag (text must write it as &lt;)');
    let j = NAME.lastIndex;
    for (;;) {
      const afterSpace = skipSpace(j);
      if (afterSpace >= text.length) return problem(`the file ends inside <${name}>`);
      if (text[afterSpace] === '>' || text.startsWith('/>', afterSpace)) {
        j = afterSpace;
        break;
      }
      if (afterSpace === j) return problem(`<${name}> has malformed attributes`);
      NAME.lastIndex = afterSpace;
      const attribute = NAME.exec(text)?.[0];
      if (!attribute) return problem(afterSpace >= text.length ? `the file ends inside <${name}>` : `<${name}> has a malformed attribute`);
      j = skipSpace(NAME.lastIndex);
      if (text[j] !== '=') return problem(`attribute ${attribute} of <${name}> has no value`);
      j = skipSpace(j + 1);
      const quote = text[j];
      if (quote !== '"' && quote !== "'") return problem(`attribute ${attribute} of <${name}> is not quoted`);
      const close = text.indexOf(quote, j + 1);
      if (close === -1) return problem(`attribute ${attribute} of <${name}> is never closed`);
      if (text.slice(j + 1, close).includes('<')) return problem(`attribute ${attribute} of <${name}> contains "<"`);
      j = close + 1;
    }
    const selfClosing = text[j] === '/';
    i = j + (selfClosing ? 2 : 1);

    if (stack.length === 0) {
      if (roots++ > 0) return problem(`a second root element, <${name}>`, lt);
      if (name !== 'testsuites' && name !== 'testsuite') return problem(`the root element is <${name}>, not <testsuites> or <testsuite>`, lt);
    }
    if (name === 'testcase') {
      if (testcase) return problem('a <testcase> inside another <testcase>', lt);
      testcase = { depth: stack.length, failed: false, skipped: false };
      if (selfClosing) {
        classify(testcase);
        testcase = null;
      }
    } else if (testcase && stack.length === testcase.depth + 1) {
      if (name === 'failure' || name === 'error') testcase.failed = true;
      else if (name === 'skipped') testcase.skipped = true;
    }
    if (!selfClosing) stack.push(name);
  }

  if (roots === 0) return { problem: 'no XML elements; is this a JUnit report?' };
  if (stack.length) return { problem: `the file ends inside <${stack[stack.length - 1]}>; was it cut short?` };
  return { counts };
}
