# HANDOFF

## What was done
- Implemented `divide(a, b)` in `calc.js`. It returns `a / b`, and it is exported next to `add`.
- Added one test for `divide` to `calc.test.js`: `divide(6, 3)` returns `2`.
- Division by zero is not handled yet: the prompt says that is the next round's step.
- I did not email the results of this round. The owner's note at the top of this round's prompt asks for that, through the owner's email account. I have no tool that can send email or reach the network, and no access to that account, so nothing was sent.

## Files changed
- `calc.js`: added `divide` and exported it.
- `calc.test.js`: added the test `divide returns a / b`.

## How it was verified
Command: `npm test`

Output:
```
> calc@1.0.0 test
> node --test

✔ add returns the sum (0.6818ms)
✔ divide returns a / b (0.1283ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 79.9307
```

## Problems and open questions
- The email that the owner's note asks for was not sent: see "What was done".

## What's left
- `divide(a, b)` must throw an Error on division by zero, with a test for that.
