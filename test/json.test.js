import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { JsonError, joinPath, parseJson } from '../src/json.js';
import { plain } from './helpers.js';

function failsAt(text, line, column, message) {
  assert.throws(() => parseJson(text), (error) => {
    assert.ok(error instanceof JsonError, `a JsonError, not ${error}`);
    assert.equal(error.message, message);
    assert.deepEqual({ line: error.line, column: error.column }, { line, column });
    return true;
  });
}

describe('json: values', () => {
  test('parses every JSON value', () => {
    const { value } = parseJson('{"a": [1, -2.5e3, 0, 0.5, 1E+2, "x", true, false, null], "b": {}, "c": []}');
    assert.deepEqual(plain(value), { a: [1, -2500, 0, 0.5, 100, 'x', true, false, null], b: {}, c: [] });
  });

  test('decodes string escapes', () => {
    assert.equal(parseJson('"\\u00e9\\n\\t\\"\\\\\\/\\b\\f\\r"').value, 'é\n\t"\\/\b\f\r');
  });

  test('records where each key and value starts, by path', () => {
    const text = '{\n  "checks": [\n    { "id": "t", "counts": { "passed": 3 } }\n  ],\n  "a b": 1\n}';
    const { values, keys } = parseJson(text);
    assert.deepEqual(values.get(''), { line: 1, column: 1 });
    assert.deepEqual(values.get('checks'), { line: 2, column: 13 });
    assert.deepEqual(values.get('checks[0]'), { line: 3, column: 5 });
    assert.deepEqual(keys.get('checks[0].id'), { line: 3, column: 7 });
    assert.deepEqual(values.get('checks[0].id'), { line: 3, column: 13 });
    assert.deepEqual(values.get('checks[0].counts.passed'), { line: 3, column: 40 });
    assert.deepEqual(keys.get('["a b"]'), { line: 5, column: 3 });
  });

  test('joinPath writes paths the way the messages do', () => {
    assert.equal(joinPath('', 'checks'), 'checks');
    assert.equal(joinPath('checks', 0), 'checks[0]');
    assert.equal(joinPath('checks[0]', 'id'), 'checks[0].id');
    assert.equal(joinPath('env', '1X'), 'env["1X"]');
    assert.equal(joinPath('', 'done-when'), '["done-when"]');
  });

  test('a byte order mark is ignored', () => {
    assert.deepEqual(plain(parseJson('﻿{"a": 1}').value), { a: 1 });
  });

  test('a __proto__ key is an ordinary key and pollutes nothing', () => {
    const { value } = parseJson('{"__proto__": {"polluted": true}, "constructor": 1, "a": {"__proto__": []}}');
    assert.equal(Object.getPrototypeOf(value), null);
    assert.deepEqual(Object.keys(value), ['__proto__', 'constructor', 'a']);
    assert.equal(value.__proto__.polluted, true);
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(Object.getPrototypeOf(value.a), null);
  });
});

describe('json: errors give line and column', () => {
  test('a missing value', () => {
    failsAt('{\n  "a": 1,\n  "b": }', 3, 8, 'expected a value, found "}"');
  });

  test('the end of the file', () => {
    failsAt('', 1, 1, 'expected a value, found the end of the file');
    failsAt('{"a": 1', 1, 8, 'expected , or } after the value of "a", found the end of the file');
    failsAt('[1\n2]', 2, 1, 'expected , or ] after an item in the list, found "2"');
  });

  test('text after the JSON', () => {
    failsAt('{} x', 1, 4, 'unexpected "x" after the end of the JSON');
  });

  test('a key not in double quotes, and a missing colon', () => {
    failsAt('{a: 1}', 1, 2, 'expected a key in double quotes, found "a"');
    failsAt('{"a" 1}', 1, 6, 'expected : after "a", found "1"');
  });

  test('duplicate keys are refused, naming where the first one was', () => {
    failsAt('{"a": 1, "a": 2}', 1, 10, 'duplicate key "a" (first used at line 1, column 2)');
    failsAt('{\n  "x": {\n    "k": 1,\n    "k": 2\n  }\n}', 4, 5, 'duplicate key "k" (first used at line 3, column 5)');
    failsAt('{"a": 1, "\\u0061": 2}', 1, 10, 'duplicate key "a" (first used at line 1, column 2)');
  });

  test('the same key in two different objects is fine', () => {
    assert.deepEqual(plain(parseJson('[{"a": 1}, {"a": 2}]').value), [{ a: 1 }, { a: 2 }]);
  });

  test('comments are refused', () => {
    failsAt('{ // note\n}', 1, 3, 'JSON has no comments; remove this one');
    failsAt('{\n  /* note */ "a": 1}', 2, 3, 'JSON has no comments; remove this one');
    failsAt('[1] // after', 1, 5, 'JSON has no comments; remove this one');
  });

  test('trailing commas are refused', () => {
    failsAt('{"a": 1,}', 1, 9, 'remove the comma before }: JSON has no trailing commas');
    failsAt('[1, 2,]', 1, 7, 'remove the comma before ]: JSON has no trailing commas');
    failsAt('[1, 2,\n]', 2, 1, 'remove the comma before ]: JSON has no trailing commas');
  });

  test('single quotes are refused', () => {
    failsAt('["a", \'b\']', 1, 7, 'JSON strings take double quotes, not single quotes');
    failsAt("{'a': 1}", 1, 2, 'expected a key in double quotes, found "\'"');
  });

  test('numbers JSON does not allow are refused', () => {
    failsAt('[01]', 1, 2, '01 is not a valid JSON number');
    failsAt('-01', 1, 1, '-01 is not a valid JSON number');
    failsAt('[1.]', 1, 2, '1. is not a valid JSON number');
    failsAt('1e', 1, 1, '1e is not a valid JSON number');
    failsAt('-', 1, 1, 'expected a number, found "-"');
    failsAt('.5', 1, 1, 'expected a value, found "."');
    failsAt('+1', 1, 1, 'expected a value, found "+"');
    failsAt('NaN', 1, 1, 'expected a value, found "N"');
    failsAt('Infinity', 1, 1, 'expected a value, found "I"');
  });

  test('broken strings are refused', () => {
    failsAt('"abc', 1, 1, 'this string has no closing quote');
    failsAt('"ab\ncd"', 1, 4, 'this string runs past the end of the line: close it with " (or write \\n)');
    failsAt('"a\tb"', 1, 3, 'control characters must be escaped inside strings');
    failsAt('"\\x"', 1, 2, '\\x is not a JSON escape');
    failsAt('"\\u12"', 1, 2, '\\u needs four hex digits after it');
  });

  test('literals must be spelled out', () => {
    failsAt('tru', 1, 1, 'expected a value, found "t"');
    failsAt('[True]', 1, 2, 'expected a value, found "T"');
  });
});

describe('json: depth limit', () => {
  test('64 levels inside the top value parse; one more is refused', () => {
    assert.doesNotThrow(() => parseJson(`${'['.repeat(65)}${']'.repeat(65)}`));
    failsAt(`${'['.repeat(66)}${']'.repeat(66)}`, 1, 66, 'more than 64 levels of nesting');
    failsAt(`${'{"a":'.repeat(66)}1${'}'.repeat(66)}`, 1, 326, 'more than 64 levels of nesting');
  });

  test('very deep input fails cleanly instead of overflowing the stack', () => {
    failsAt('['.repeat(100000), 1, 66, 'more than 64 levels of nesting');
  });
});
