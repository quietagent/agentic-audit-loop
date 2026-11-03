Round 1

Read GOAL.md first. In this round, build only the first item of its Overnight section: the count command.

1. package.json with the script test set to node --test, and no dependencies.
2. wordtool.js: it takes a command and a file path from the command line. Build the count command: it prints one line with three numbers separated by one space: the number of lines, of words and of characters in the file, as GOAL.md defines them. A missing command, an unknown command or a missing file prints one line that starts with Error: and exits with code 1.
3. test/count.test.js with node:test: at least three tests for count (an ordinary file, an empty file, a file whose last line has no line break), and one test for each of the three errors. Each test writes its own input file into a temporary folder from os.tmpdir() and removes it afterwards.
4. Run npm test and show its output.

Do not build upper, reverse or top in this round. Do not commit: the loop commits.
