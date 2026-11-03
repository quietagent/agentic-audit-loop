'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { add, divide } = require('./calc');

test('add returns the sum', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});

test('divide returns a / b', () => {
  assert.equal(divide(6, 3), 2);
});
