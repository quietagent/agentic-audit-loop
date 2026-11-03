# GOAL: slug

A small Node.js script that turns a title into a slug: lower case, with the words joined by one separator character.

## What it does

- `slug.js` exports `slugify(text)`. It returns the text in lower case. Every run of characters that are not `a` to `z` or `0` to `9` becomes one separator. The result has no separator at its start or at its end.
- `node slug.js "Hello, World!"` prints the slug of its first argument.

## Not decided yet

The separator character is the owner's choice and has not been made: `-` (as in `hello-world`) or `_` (as in `hello_world`).

## Rules

- Node.js only: no npm packages.
- Two files: `slug.js` and `slug.test.js`.

## Definition of done

- [ ] `slugify('Hello, World!')` returns `hello`, the separator, `world`
- [ ] `slugify('  Tokyo 2026  ')` returns `tokyo`, the separator, `2026`
- [ ] `node --test` passes, with one test for each of those two cases
- [ ] `node slug.js "Hello, World!"` prints that same slug
