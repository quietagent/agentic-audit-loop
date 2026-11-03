// calc.js: a tiny calculator module that exports add() and divide().
'use strict';

function add(a, b) {
  return a + b;
}

function divide(a, b) {
  return a / b;
}

module.exports = { add, divide };
