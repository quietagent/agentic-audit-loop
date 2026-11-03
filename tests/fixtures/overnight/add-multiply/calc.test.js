'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { add, multiply } = require('./calc');

test('add returns the sum', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});

test('multiply returns the product', () => {
  assert.equal(multiply(2, 3), 6);
  assert.equal(multiply(-4, 2), -8);
  assert.equal(multiply(7, 0), 0);
});
