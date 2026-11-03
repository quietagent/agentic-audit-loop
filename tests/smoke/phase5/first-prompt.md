# Round 1

Read GOAL.md first. In this round, build only these parts:

1. `package.json` with `"test": "node --test"` and no dependencies.
2. `todo.js` with two commands: `add "<text>"` and `list` (with `--all`). Tasks are saved in `data/todos.json`.
3. For these two commands: a missing text for `add` prints a clear error and exits with code 1.
4. Tests in `test/` for each of the above, and a test that a task is still there on the next run. The tests use a temporary data file, never `data/todos.json`. Give `todo.js` a way to use another data file for the tests, for example an environment variable.

Not in this round: `done`, `delete` and README.md. They come later.

Run `npm test` after each part, and fix what fails before you go on.
