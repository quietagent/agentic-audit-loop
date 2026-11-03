# GOAL: textstats

A small Node.js library and command line that reports simple statistics about a text.

## What it does

`stats.js` exports eight functions. Each takes a text (a string) and never throws on an empty one. A word is a run of letters, digits and apostrophes.

- `countLines(text)`: the number of lines. An empty text has 0 lines. A last line without a line break counts as a line.
- `countWords(text)`: the number of words.
- `countSentences(text)`: the number of sentences. A sentence ends with `.`, `!` or `?`. A text with words and none of those marks is 1 sentence, and an empty text has 0.
- `longestWord(text)`: the longest word. When several words have that length, the first of them. An empty text gives `''`.
- `averageWordLength(text)`: the mean length of the words, rounded to one decimal. An empty text gives 0.
- `uniqueWords(text)`: how many different words there are. Letter case does not matter: `The` and `the` are one word.
- `wordFrequency(text, n)`: the `n` most frequent words, in lower case, as `[word, count]` pairs. The most frequent comes first, and words with the same count are in alphabetical order.
- `readingMinutes(text)`: the reading time in whole minutes, rounded up, at the reading speed below. An empty text takes 0 minutes.

`cli.js` is the command line:

- `node cli.js <file>` reads the file and prints six lines: `Lines: N`, `Words: N`, `Sentences: N`, `Unique words: N`, `Longest word: W` and `Reading time: N min`.
- `node cli.js` without a file prints one line that says how to use it, and ends with exit code 1.

## Not decided yet

The reading speed is the owner's choice and has not been made: 200 words per minute or 250 words per minute.

## Rules

- Node.js only: no npm packages.
- One test file per function, in the folder `test/`, written with `node:test`, with at least two tests each.
- `sample.txt` in the project root is a text of about ten lines for trying the command line.

## Definition of done

- [ ] `stats.js` exports the eight functions above, and each does what is described
- [ ] `test/` has one test file per function with at least two tests each, and `node --test` passes
- [ ] `node cli.js sample.txt` prints the six lines for `sample.txt`, with the right numbers
- [ ] `node cli.js` without a file prints one line on how to use it, and ends with exit code 1
