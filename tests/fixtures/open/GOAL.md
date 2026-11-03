# GOAL

## What to build
A tiny Node.js calculator module, `calc.js`, that exports two functions: `add` and `divide`.

## Definition of done
- [ ] `add(a, b)` returns the sum and has a passing test.
- [ ] `divide(a, b)` returns `a / b`, handles division by zero, and has passing tests for both.

## Not decided yet
How `divide()` handles division by zero is the owner's choice and has not been made: throw an Error, return null, or return Infinity.

## Constraints
Plain Node.js (CommonJS) with built-in modules only: no npm dependencies. Tests use `node:test` and run with `npm test`. Work only inside this folder.

## Out of scope
Any operation other than `add` and `divide`, a command-line interface, and publishing the package.
