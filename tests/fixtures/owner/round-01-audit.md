VERDICT: CONTINUE
REASON: add(a, b) is built and tested: npm test passes 1 of 1. divide(a, b) is still open.
FINDINGS:
- I ran npm test myself: 1 test, 1 pass, 0 fail, as HANDOFF.md says.
- calc.js exports add, which returns a + b, and calc.test.js tests it.
- Not done yet: divide(a, b), with the error on division by zero and tests for both.
NEXT_PROMPT:
Implement divide(a, b) in calc.js. It returns a / b. Export it next to add.

Add one test for divide in calc.test.js: divide(6, 3) returns 2. Run npm test and show its output.

Division by zero is the next round's step: do not handle it in this round.

Final task: overwrite HANDOFF.md in the project root with these sections: What was done, Files changed, How it was verified (exact commands and their real output), Problems and open questions, What's left. Report only what you actually did and saw.
