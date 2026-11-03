# HANDOFF

## What was done
- Implemented `add(a, b)` in `calc.js`. It returns `a + b`.
- Added `calc.test.js` with one test for `add`.
- `divide(a, b)` is not implemented yet.

## Files changed
- `calc.js`: added `add` and exported it.
- `calc.test.js`: new file with one test for `add`.

## How it was verified
Command: `npm test`

Output:
```
> calc@1.0.0 test
> node --test

✔ add returns the sum (0.7183ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 93.9972
```

## Problems and open questions
None.

## What's left
- Definition-of-done item 2: `divide(a, b)` that returns `a / b` and throws an Error on division by zero, with passing tests for both.
