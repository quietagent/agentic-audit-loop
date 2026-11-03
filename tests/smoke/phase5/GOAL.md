# GOAL

## What to build
A small command-line to-do app in Node.js. Tasks are saved in a JSON file in the project folder, and the app is used like `node todo.js add "Buy milk"`.

## Definition of done
- [ ] `node todo.js add "<text>"` saves a task with an id, the text, `done: false` and the date it was added, and prints the new id.
- [ ] `node todo.js list` prints open tasks, one per line with id and text. `list --all` also shows done tasks.
- [ ] `node todo.js done <id>` marks a task done.
- [ ] `node todo.js delete <id>` deletes a task, the way DECISIONS.md says.
- [ ] An unknown id or a missing argument prints a clear error and exits with code 1.
- [ ] Tasks are saved in `data/todos.json` and are still there on the next run.
- [ ] Every item above has a passing test, and `npm test` passes.
- [ ] README.md shows every command with an example.

## Constraints
- Node.js built-ins only. No npm packages, nothing installed.
- All code and data stay inside the project folder.
- Tests use a temporary data file, never `data/todos.json`.
- `package.json` has `"test": "node --test"`.

## Out of scope
- No web page, server, database, accounts or network.
- No editing task text, priorities, tags or due dates.

## Not decided yet
- The order `list` shows tasks in: newest first or oldest first. Easy to change later.
- Whether `delete` removes a task for good, or moves it to a trash list it can be restored from. This is the owner's choice.
