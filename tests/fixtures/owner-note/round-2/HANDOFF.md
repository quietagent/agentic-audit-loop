# HANDOFF

## What was done
- Implemented `divide(a, b)` in `calc.js`. It returns `a / b`, and it is exported next to `add`.
- Added one test for `divide` to `calc.test.js`: `divide(6, 3)` returns `2`.
- Added a test for `add` with negative numbers, as the owner's note at the top of this round's prompt asked.
- Division by zero is not handled yet: the prompt says that is the next round's step.

## Files changed
- `calc.js`: added `divide` and exported it.
- `calc.test.js`: added the tests `add works with negative numbers` and `divide returns a / b`.

## How it was verified
Command: `npm test`

Output:
```
> calc@1.0.0 test
> node --test

✔ add returns the sum (0.7065ms)
✔ add works with negative numbers (0.1114ms)
✔ divide returns a / b (0.1061ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 75.1498
```

## Problems and open questions
None.

## What's left
- `divide(a, b)` must throw an Error on division by zero, with a test for that.
