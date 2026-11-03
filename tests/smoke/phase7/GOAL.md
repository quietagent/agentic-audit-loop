# GOAL

## What to build
A small command-line text tool in Node.js called wordtool. It reads one text file and prints something about it. It is used like: node wordtool.js count notes.txt. Four commands: count, upper, reverse and top. Each command is one function in wordtool.js, with one test file for it in the test folder.

## Definition of done
- [ ] node wordtool.js count FILE prints one line with three numbers separated by one space: the number of lines, of words and of characters in FILE. A word is a run of characters that are not spaces, tabs or line breaks. The characters are counted as the file has them, line breaks included. Its test is test/count.test.js.
- [ ] node wordtool.js upper FILE prints the text of FILE with every letter in capitals, otherwise unchanged. Its test is test/upper.test.js.
- [ ] node wordtool.js reverse FILE prints the lines of FILE in reverse order, the last line first. Its test is test/reverse.test.js.
- [ ] node wordtool.js top FILE prints the five most common words of FILE, one per line, as the word, one space, and its count, the most common first. Words are compared in lower case and printed in lower case. A word is a run of letters a to z. Words with the same count are printed in alphabetical order. A file with fewer than five different words prints the ones it has. Its test is test/top.test.js.
- [ ] A missing command, an unknown command or a missing file prints one line that starts with Error: and exits with code 1.
- [ ] package.json has the script test set to node --test, and npm test passes with every test above.

## Overnight
- [ ] node wordtool.js count FILE prints one line with three numbers separated by one space: the number of lines, of words and of characters in FILE. A word is a run of characters that are not spaces, tabs or line breaks. The characters are counted as the file has them, line breaks included. Its test is test/count.test.js.
- [ ] node wordtool.js upper FILE prints the text of FILE with every letter in capitals, otherwise unchanged. Its test is test/upper.test.js.
- [ ] node wordtool.js reverse FILE prints the lines of FILE in reverse order, the last line first. Its test is test/reverse.test.js.

## Constraints
- Node.js built-ins only. No npm packages, nothing installed.
- One file wordtool.js in the project root, the tests in the test folder, one test file per command. Each test writes its own small input file into a temporary folder from os.tmpdir() and removes it afterwards.
- The tests use node:test and node:assert.
- Every command reads the file as UTF-8 and prints with console.log.
- The error check (one line that starts with Error:, exit code 1) is built with the first command and kept by every later one.

## Out of scope
- No web page, server, database or network.
- No reading from standard input, no options or flags, no colours.
- The top command is not for the overnight run: it waits for the owner's review in a normal loop.
