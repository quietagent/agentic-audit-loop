'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { add, divide } = require('./calc');

test('add returns the sum', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});

test('add works with negative numbers', () => {
  assert.equal(add(-2, -3), -5);
  assert.equal(add(-7, 2), -5);
});

test('divide returns a / b', () => {
  assert.equal(divide(6, 3), 2);
});

test('divide works with negative numbers', () => {
  assert.equal(divide(-6, 3), -2);
});

test('divide can return a fraction', () => {
  assert.equal(divide(1, 4), 0.25);
});
