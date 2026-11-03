# HANDOFF

## What was done
- Implemented `add(a, b)` in `calc.js`. It returns `a + b`.
- Implemented `divide(a, b)` in `calc.js`. It returns `a / b` and throws an Error on division by zero.
- Added `calc.test.js` with tests for `add`, for `divide`, and for the division-by-zero error.
- Both definition-of-done items in GOAL.md are complete.

## Files changed
- `calc.js`: added `add` and `divide` and exported both.
- `calc.test.js`: new file with tests for `add`, `divide` and division by zero.

## How it was verified
Command: `npm test`

Output:
```
> calc@1.0.0 test
> node --test

✔ add returns the sum (0.7183ms)
✔ divide returns a / b (0.1042ms)
✔ divide throws on division by zero (0.2311ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 95.4410
```

## Problems and open questions
None.

## What's left
Nothing. Both definition-of-done items are done and all tests pass.
