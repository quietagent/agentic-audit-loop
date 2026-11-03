# GOAL: Tokyo date

A small Node.js script that prints today's date in Tokyo.

## What it does

- `node tokyo-date.js` prints one line: today's date in the time zone `Asia/Tokyo`, as `YYYY-MM-DD`.
- The date comes from a function `tokyoDate(date)` that the script exports. It takes a `Date` and returns the string.

## Rules

- Node.js only: no npm packages.
- Two files: `tokyo-date.js` and `tokyo-date.test.js`.

## Definition of done

- [ ] `node tokyo-date.js` prints today's date in Tokyo as `YYYY-MM-DD`
- [ ] `tokyoDate(new Date('2026-01-01T21:30:00Z'))` returns `2026-01-02`
- [ ] `node --test` passes, with one test for that case
