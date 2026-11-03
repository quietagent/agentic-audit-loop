'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { add, divide, multiply } = require('./calc');

test('add returns the sum', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});

test('multiply returns the product', () => {
  assert.equal(multiply(2, 3), 6);
  assert.equal(multiply(-4, 2), -8);
  assert.equal(multiply(7, 0), 0);
});

test('divide returns a / b', () => {
  assert.equal(divide(6, 3), 2);
  assert.equal(divide(1, 4), 0.25);
});

test('divide throws on division by zero', () => {
  assert.throws(() => divide(1, 0), /division by zero/);
});
