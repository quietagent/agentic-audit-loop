# Round 1

Read GOAL.md first. Then build the whole project in this round: it is small.

1. Write `tokyo-date.js`. It exports `tokyoDate(date)`, which returns the date in the time zone `Asia/Tokyo` as `YYYY-MM-DD`. Run as a script, it prints `tokyoDate(new Date())`.
2. Write `tokyo-date.test.js` with one `node:test` test: `tokyoDate(new Date('2026-01-01T21:30:00Z'))` is `2026-01-02`.
3. Run `node --test` and `node tokyo-date.js`.
4. Write `HANDOFF.md` with these sections: What was done, Files changed, How it was verified (the commands and their real output), Problems and open questions, What's left.

Do not commit: the loop commits.
