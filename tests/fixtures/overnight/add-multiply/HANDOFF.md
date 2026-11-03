# HANDOFF

## What was done
- Implemented `add(a, b)` and `multiply(a, b)` in `calc.js`: `a + b` and `a * b`, both exported.
- Added `calc.test.js` with one test for each: `add(2, 3)` is 5 and `add(-1, 1)` is 0; `multiply(2, 3)` is 6, `multiply(-4, 2)` is -8 and `multiply(7, 0)` is 0.

## Files changed
- `calc.js`: the two functions and the export.
- `calc.test.js`: new, two tests.

## How it was verified
Command: `npm test`

Output:
```
> calc@1.0.0 test
> node --test

✔ add returns the sum (0.7021ms)
✔ multiply returns the product (0.1130ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 64.5570
```

## Problems and open questions
None.

## What's left
- `divide(a, b)` with its tests. GOAL.md leaves the division by zero to the owner.
- README.md.
