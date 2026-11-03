# GOAL: numkit

## What to build
A command-line number toolbox in Node.js with twelve small commands. It is used like `node numkit.js roman 1994`, and prints one line.

## The commands
An argument is a whole number written with the digits 0 to 9 only: no sign, no point, no spaces. `007` is 7. Each command prints its answer as one line on stdout and exits with code 0.

| # | Command | Prints | Allowed input | Example |
| --- | --- | --- | --- | --- |
| 1 | `roman <n>` | n as a Roman numeral | n from 1 to 3999 | `roman 1994` prints `MCMXCIV` |
| 2 | `unroman <text>` | the number of a Roman numeral | exactly what `roman` prints for 1 to 3999, in capital letters | `unroman MCMXCIV` prints `1994` |
| 3 | `prime <n>` | `yes` when n is a prime number, else `no` | n from 0 to 1000000000 | `prime 97` prints `yes` |
| 4 | `factors <n>` | the prime factors of n, smallest first, joined by ` x ` | n from 2 to 1000000000 | `factors 360` prints `2 x 2 x 2 x 3 x 3 x 5` |
| 5 | `gcd <a> <b>` | the greatest common divisor | a and b from 1 to 1000000000 | `gcd 84 36` prints `12` |
| 6 | `lcm <a> <b>` | the least common multiple | a and b from 1 to 1000000 | `lcm 4 6` prints `12` |
| 7 | `fib <n>` | the first n Fibonacci numbers, starting with 0 and 1, joined by one space | n from 1 to 50 | `fib 8` prints `0 1 1 2 3 5 8 13` |
| 8 | `base <n> <radix>` | n written in the radix, with lower-case letters | n from 0 to 1000000000, radix from 2 to 36 | `base 255 16` prints `ff` |
| 9 | `leap <year>` | `yes` when the year is a leap year in the Gregorian calendar, else `no` | year from 1 to 9999 | `leap 1900` prints `no` |
| 10 | `digits <n>` | the sum of the digits of n | n from 0 to 1000000000 | `digits 9875` prints `29` |
| 11 | `collatz <n>` | the number of steps until n reaches 1 in the Collatz sequence (halve an even number, turn an odd number into 3n + 1) | n from 1 to 1000000 | `collatz 27` prints `111` |
| 12 | `perfect <n>` | `perfect`, `abundant` or `deficient`, by the sum of the divisors of n that are smaller than n | n from 1 to 1000000 | `perfect 28` prints `perfect` |

Errors:
- An unknown command, a missing argument, one argument too many, an argument that is not written as the first paragraph says, or an input outside the allowed input of the table: one line on stderr that starts with `Error: `, nothing on stdout, and exit code 1.
- `node numkit.js` without a command: one line on stdout that starts with `Usage: `, and exit code 1.

## Definition of done
- [ ] `package.json` has `"test": "node --test"` and no dependencies, and `npm test` passes.
- [ ] `numkit.js` handles a missing command and an unknown command as "Errors" says, with a test for each in `test/numkit.test.js`.
- [ ] Command 1, `roman`: built as "How every command is built" says.
- [ ] Command 2, `unroman`: built as "How every command is built" says.
- [ ] Command 3, `prime`: built as "How every command is built" says.
- [ ] Command 4, `factors`: built as "How every command is built" says.
- [ ] Command 5, `gcd`: built as "How every command is built" says.
- [ ] Command 6, `lcm`: built as "How every command is built" says.
- [ ] Command 7, `fib`: built as "How every command is built" says.
- [ ] Command 8, `base`: built as "How every command is built" says.
- [ ] Command 9, `leap`: built as "How every command is built" says.
- [ ] Command 10, `digits`: built as "How every command is built" says.
- [ ] Command 11, `collatz`: built as "How every command is built" says.
- [ ] Command 12, `perfect`: built as "How every command is built" says.
- [ ] README.md starts with one paragraph on what numkit is and how to run its tests, and has one section per command.

## How every command is built
A round builds exactly one command: the next one in the table that is not done. Never more than one command in a round, also when it looks quick. For that command, in this order:

1. Write its tests in `test/<command>.test.js`: at least eight. Among them are the table's example, the smallest and the largest allowed input, and three inputs that must give an error.
2. Run `npm test`, and see the new tests fail.
3. Write the command in `lib/<command>.js`: a function that takes its arguments as strings and returns the line to print, or throws an Error. Add the command to `numkit.js`.
4. Run `npm test` until every test passes.
5. Run the command itself five times, each run as its own call: the table's example, two more allowed inputs, and two inputs that give an error.
6. Add its section to README.md: one line on what it does, and those five runs with what each printed.
7. Run `npm test` once more, and show its last lines in HANDOFF.md.

## Constraints
- Node.js built-ins only. No npm packages, nothing installed.
- All code stays inside the project folder. No network, and no file outside the project folder.
- The files are `numkit.js`, `lib/<command>.js`, `test/<command>.test.js`, `test/numkit.test.js`, `package.json` and `README.md`. Nothing is saved to disk when a command runs.
- The tests call the function in `lib/`. For the error cases they also run `numkit.js` as a child process and check stderr and the exit code.
- Ordinary JavaScript numbers are enough: with the allowed inputs no result needs BigInt.

## Out of scope
- No command besides the twelve, and no options or flags.
- No web page, server, database, accounts, email or network.

## Decisions
Every choice that changes what gets built is made above. What this file does not fix is the builder's own choice and easy to change later: the names of helper functions, the words after `Error: ` and after `Usage: `, and the layout of README.md.
