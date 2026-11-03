'use strict';

function add(a, b) {
  return a + b;
}

function divide(a, b) {
  if (b === 0) throw new Error('division by zero');
  return a / b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, divide, multiply };
