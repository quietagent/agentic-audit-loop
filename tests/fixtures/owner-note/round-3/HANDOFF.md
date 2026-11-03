# HANDOFF

## What was done
- Added two tests for `divide(a, b)` to `calc.test.js`: `divide(-6, 3)` returns `-2`, and `divide(1, 4)` returns `0.25`.
- Put a one-line comment at the top of `calc.js` that says what the file does, as the owner's note at the top of this round's prompt asked: `// calc.js: a tiny calculator module that exports add() and divide().`
- Division by zero is not handled yet: the prompt says it is not this round's step.

## Files changed
- `calc.js`: the comment on line 1. The code did not change.
- `calc.test.js`: added the tests `divide works with negative numbers` and `divide can return a fraction`.

## How it was verified
Command: `npm test`

Output:
```
> calc@1.0.0 test
> node --test

✔ add returns the sum (0.7294ms)
✔ add works with negative numbers (0.1054ms)
✔ divide returns a / b (0.1036ms)
✔ divide works with negative numbers (0.1014ms)
✔ divide can return a fraction (0.0989ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 77.3678
```

## Problems and open questions
None.

## What's left
- `divide(a, b)` must throw an Error on division by zero, with a test for that.
