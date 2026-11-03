# HANDOFF

## What was done
- Implemented `divide(a, b)` in `calc.js` and exported it next to `add` and `multiply`: it returns `a / b`, and throws `new Error('division by zero')` when `b` is 0, as the prompt said the owner decided.
- Added two tests to `calc.test.js`: `divide(6, 3)` is 2 (and `divide(1, 4)` is 0.25), and `divide(1, 0)` throws an Error whose message matches `division by zero`.
- Did not write README.md: the prompt says it is not an overnight item.

## Files changed
- `calc.js`: the `divide` function and the export.
- `calc.test.js`: two new tests.

## How it was verified
Command: `npm test`

Output:
```
> calc@1.0.0 test
> node --test

✔ add returns the sum (0.7244ms)
✔ multiply returns the product (0.1096ms)
✔ divide returns a / b (0.0958ms)
✔ divide throws on division by zero (0.2201ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 66.0210
```

## Problems and open questions
None.

## What's left
- README.md, which the owner reviews.
