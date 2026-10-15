import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseJunit } from '../src/junit.js';
import { fixture } from './helpers.js';

function counts(xml) {
  const r = parseJunit(xml);
  assert.equal(r.problem, undefined, r.problem);
  return r.counts;
}
function problemOf(xml) {
  const r = parseJunit(xml);
  assert.equal(r.counts, undefined, `expected a problem, got ${JSON.stringify(r.counts)}`);
  return r.problem;
}
const c = (passed, failed, skipped) => ({ passed, failed, skipped });
const suite = (body) => `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${body}\n</testsuites>\n`;

describe('junit: real Node output', () => {
  test('a Node JUnit report counts its testcases: 4 passed, 0 failed, 2 skipped', () => {
    assert.deepEqual(parseJunit(fixture('node-junit.xml')), { counts: c(4, 0, 2) });
  });

  test('with a byte order mark and CRLF line ends it counts the same', () => {
    assert.deepEqual(counts(`﻿${fixture('node-junit.xml').replace(/\n/g, '\r\n')}`), c(4, 0, 2));
  });

  test('the report cut short anywhere inside the root is a problem', () => {
    const text = fixture('node-junit.xml');
    const end = text.lastIndexOf('</testsuites>');
    for (let n = text.indexOf('<testsuites>') + 1; n < end; n += 7) {
      assert.ok(parseJunit(text.slice(0, n)).problem, `cut at ${n}`);
    }
  });
});

describe('junit: classifying testcases', () => {
  test('failure and error fail a testcase; skipped beats both', () => {
    const xml = suite([
      '<testcase name="a"/>',
      '<testcase name="b"></testcase>',
      '<testcase name="c"><failure message="boom">stack</failure></testcase>',
      '<testcase name="d"><error/></testcase>',
      '<testcase name="e"><skipped/></testcase>',
      '<testcase name="f"><failure/><skipped type="todo"/></testcase>',
      '<testcase name="g"><skipped/><error/></testcase>',
      '<testcase name="h"><system-out>log</system-out><system-err/></testcase>',
    ].join('\n'));
    assert.deepEqual(counts(xml), c(3, 2, 3));
  });

  test('only a testcase\'s own children classify it', () => {
    assert.deepEqual(counts(suite('<testcase name="a"><system-out><failure/></system-out></testcase>')), c(1, 0, 0));
  });

  test('the summary attributes are ignored, whatever they say', () => {
    const xml = '<testsuites tests="99" failures="0" skipped="0">\n<testsuite name="s" tests="50" failures="7" errors="3" skipped="12">\n<testcase name="a"><failure/></testcase>\n</testsuite>\n</testsuites>';
    assert.deepEqual(counts(xml), c(0, 1, 0));
    assert.deepEqual(counts('<testsuite tests="0" failures="0"><testcase name="a"/><testcase name="b"/></testsuite>'), c(2, 0, 0));
  });

  test('suites nest to any depth; every testcase counts', () => {
    const xml = suite('<testsuite name="a"><testsuite name="b"><testsuite name="c"><testcase name="x"/></testsuite><testcase name="y"><skipped/></testcase></testsuite></testsuite><testcase name="z"/>');
    assert.deepEqual(counts(xml), c(2, 0, 1));
  });

  test('a root with no testcases counts nothing', () => {
    assert.deepEqual(counts('<testsuites/>'), c(0, 0, 0));
    assert.deepEqual(counts('<?xml version="1.0"?><testsuite name="empty"></testsuite>'), c(0, 0, 0));
  });
});

describe('junit: text that only looks like a testcase', () => {
  test('a testcase inside CDATA is not counted', () => {
    const xml = suite('<testcase name="a"><failure><![CDATA[expected <testcase name="fake"/> and <testcase> ]]></failure></testcase>');
    assert.deepEqual(counts(xml), c(0, 1, 0));
  });

  test('a testcase inside a comment is not counted', () => {
    const xml = `<!-- <testcase name="before"/> -->\n${suite('<!-- <testcase name="x"><failure/></testcase> -->\n<testcase name="a"/>')}<!-- <testcase/> -->`;
    assert.deepEqual(counts(xml), c(1, 0, 0));
  });

  test('quoted attributes may hold > and escaped <', () => {
    const xml = suite('<testcase name=\'a > b\' classname="x &lt;testcase&gt;"/>');
    assert.deepEqual(counts(xml), c(1, 0, 0));
  });

  test('a processing instruction is skipped', () => {
    assert.deepEqual(counts('<?xml version="1.0"?>\n<?style x?>\n<testsuite><?pi <testcase/> ?><testcase/></testsuite>'), c(1, 0, 0));
  });
});

describe('junit: what is refused', () => {
  test('a report cut short', () => {
    assert.equal(problemOf('<testsuites><testsuite name="a"><testcase name="x"/>'), 'the file ends inside <testsuite>; was it cut short?');
    assert.equal(problemOf('<testsuites>\n<testcase name="x'), 'line 2: attribute name of <testcase> is never closed');
    assert.equal(problemOf('<testsuites>\n<testcase name="x" '), 'line 2: the file ends inside <testcase>');
    assert.equal(problemOf('<testsuites><!-- note'), 'line 1: a comment is never closed');
    assert.equal(problemOf('<testsuites><testcase><failure><![CDATA[ boom'), 'line 1: a CDATA section is never closed');
    assert.equal(problemOf('<?xml version="1.0"'), 'line 1: a processing instruction is never closed');
  });

  test('mismatched and stray closing tags', () => {
    assert.equal(problemOf('<testsuites>\n<testsuite>\n<testcase>\n</testsuite>\n</testsuites>'), 'line 4: </testsuite> closes <testcase>');
    assert.equal(problemOf('<testsuite></testsuite></testsuite>'), 'line 1: </testsuite> has no opening tag');
    assert.equal(problemOf('<testsuite></>'), 'line 1: a closing tag without a name');
    assert.equal(problemOf('<testsuite></testsuite x>'), 'line 1: </testsuite is not closed with >');
  });

  test('a DOCTYPE is refused, since it can expand entities', () => {
    const xml = '<?xml version="1.0"?>\n<!DOCTYPE t [<!ENTITY a "<testcase/>">]>\n<testsuites>&a;</testsuites>';
    assert.equal(problemOf(xml), 'line 2: a DOCTYPE or other declaration; these are refused because they can expand entities');
    assert.equal(problemOf('<testsuites><!ELEMENT x ANY></testsuites>'), 'line 1: a DOCTYPE or other declaration; these are refused because they can expand entities');
  });

  test('the root must be testsuites or testsuite, and only one', () => {
    assert.equal(problemOf('<results><testcase/></results>'), 'line 1: the root element is <results>, not <testsuites> or <testsuite>');
    assert.equal(problemOf('<testcase name="a"/>'), 'line 1: the root element is <testcase>, not <testsuites> or <testsuite>');
    assert.equal(problemOf('<testsuite/>\n<testsuite><testcase/></testsuite>'), 'line 2: a second root element, <testsuite>');
    assert.equal(problemOf('hello <testsuite/>'), 'line 1: text outside the root element');
    assert.equal(problemOf('<testsuite/>\ntrailing'), 'line 1: text outside the root element');
    assert.equal(problemOf('<![CDATA[x]]><testsuite/>'), 'line 1: CDATA outside the root element');
    assert.equal(problemOf(''), 'no XML elements; is this a JUnit report?');
    assert.equal(problemOf('<?xml version="1.0"?>\n<!-- nothing -->\n'), 'no XML elements; is this a JUnit report?');
    assert.equal(problemOf('not xml at all'), 'line 1: text outside the root element');
  });

  test('a testcase inside another testcase', () => {
    assert.equal(problemOf('<testsuite>\n<testcase name="a">\n<testcase name="b"/>\n</testcase>\n</testsuite>'), 'line 3: a <testcase> inside another <testcase>');
  });

  test('malformed tags and attributes', () => {
    assert.equal(problemOf('<testsuite>< testcase/></testsuite>'), 'line 1: a "<" that does not start a tag (text must write it as &lt;)');
    assert.equal(problemOf('<testsuite><testcase name=a/></testsuite>'), 'line 1: attribute name of <testcase> is not quoted');
    assert.equal(problemOf('<testsuite><testcase disabled/></testsuite>'), 'line 1: attribute disabled of <testcase> has no value');
    assert.equal(problemOf('<testsuite><testcase name="a<b"/></testsuite>'), 'line 1: attribute name of <testcase> contains "<"');
    assert.equal(problemOf('<testsuite a="1"b="2"/>'), 'line 1: <testsuite> has malformed attributes');
    assert.equal(problemOf('<testsuite =""/>'), 'line 1: <testsuite> has a malformed attribute');
  });
});
