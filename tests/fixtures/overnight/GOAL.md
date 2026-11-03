# GOAL

## What to build
A tiny Node.js calculator module, `calc.js`, that exports three functions: `add`, `divide` and `multiply`, and a README.md that documents them.

## Definition of done
- [ ] `add(a, b)` returns the sum and has a passing test.
- [ ] `divide(a, b)` returns `a / b`, handles division by zero the way the owner decides, and has passing tests for both.
- [ ] `multiply(a, b)` returns the product and has a passing test.
- [ ] README.md documents each function with one example, in wording the owner reviews.

## Overnight
- [ ] `add(a, b)` returns the sum and has a passing test.
- [ ] `divide(a, b)` returns `a / b`, handles division by zero the way the owner decides, and has passing tests for both.
- [ ] `multiply(a, b)` returns the product and has a passing test.

## Not decided yet
How `divide()` handles division by zero is the owner's choice and has not been made: throw an Error, return null, or return Infinity.

## Constraints
Plain Node.js (CommonJS) with built-in modules only: no npm dependencies. Tests use `node:test` and run with `npm test`. Work only inside this folder.

## Out of scope
Any operation other than `add`, `divide` and `multiply`, a command-line interface, and publishing the package.
