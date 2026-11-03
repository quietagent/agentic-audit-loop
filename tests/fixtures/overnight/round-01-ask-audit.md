VERDICT: ASK_HUMAN
REASON: The round's work is done and checked. The next overnight item, divide(a, b), needs the owner's choice on division by zero, which GOAL.md leaves open.
FINDINGS:
- I ran npm test myself: it passes, as HANDOFF.md says.
- calc.js exports what HANDOFF.md says, and calc.test.js tests it.
- Not done yet: divide(a, b), whose behaviour on division by zero GOAL.md leaves to the owner.
QUESTIONS:
1. [MUST] How should divide(a, b) handle division by zero (b is 0)?
   options: Throw an Error | Return null | Return Infinity
   recommended: Throw an Error
NEXT_PROMPT:
Once the owner has chosen, build divide(a, b) with that behaviour and tests for both cases.
