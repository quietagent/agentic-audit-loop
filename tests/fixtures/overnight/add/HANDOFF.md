# HANDOFF

## What was done
- Implemented `add(a, b)` in `calc.js`: it returns `a + b`, and is exported.
- Added `calc.test.js` with one test for `add`: `add(2, 3)` is 5 and `add(-1, 1)` is 0.

## Files changed
- `calc.js`: the `add` function and the export.
- `calc.test.js`: new, one test.

## How it was verified
Command: `npm test`

Output:
```
> calc@1.0.0 test
> node --test

✔ add returns the sum (0.6912ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 62.1183
```

## Problems and open questions
None.

## What's left
- `divide(a, b)` and `multiply(a, b)`, with their tests. GOAL.md leaves the division by zero to the owner.
- README.md.
