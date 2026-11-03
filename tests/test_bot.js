'use strict';

// Tests scripts/bot.js end to end: each test runs real ticks (`node scripts/bot.js tick`)
// against a fake Telegram server on 127.0.0.1, with a fake token, its own secrets
// and runtime folders, and a projects root under tests/tmp/ (tests/helpers/bot_sandbox.js).
// No real Telegram call, no real Claude call. The loop has its own file: tests/test_loop.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { botSandbox, filesUnder, ROOT } = require('./helpers/bot_sandbox');
const { createProject } = require('../scripts/lib/projects');

const GOAL = '# GOAL: say hello\n\nA script that prints hello.\n\n## Definition of done\n- [ ] hello.js prints hello\n';
const PROMPT = 'Create hello.js that prints hello, and write HANDOFF.md.\n';
const SESSION = '11111111-2222-4333-8444-555555555555';

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();
// The Save and Cancel buttons of the last summary the bot sent.
const buttons = (fake) => fake.sent.filter((s) => s.replyMarkup).pop().replyMarkup.inline_keyboard[0];

test('the first tick skips what was already waiting, and logs how many', async (t) => {
  const s = await botSandbox(t);
  s.fake.message(s.owner, '/new Old_Project');
  s.fake.message(s.owner, '/ping');
  const first = await s.tick();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, 'idle\n');
  assert.deepEqual(s.fake.sent, [], 'nothing was answered');
  assert.deepEqual(s.logTexts(), ['first tick: skipped 2 updates that were already waiting']);
  assert.equal(s.state().offset, 1002);

  // Without anything waiting, the first tick still marks the start.
  const empty = await botSandbox(t);
  await empty.tick();
  assert.equal(empty.state().offset, 0);
  assert.deepEqual(empty.logTexts(), ['first tick: skipped 0 updates that were already waiting']);
  empty.fake.message(empty.owner, '/ping');
  await empty.tick();
  assert.equal(empty.fake.sentTexts().length, 1);
});

test('/ping, /help and anything else: one answer each, one short line on stdout, exit 0', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  s.fake.message(s.owner, '/ping');
  s.fake.message(s.owner, '/help');
  s.fake.message(s.owner, '/HELP@SomeLoopBot');
  s.fake.message(s.owner, 'hello there');
  s.fake.message(s.owner, '/start');
  const r = await s.tick();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ok: 5 updates, 5 sent\n');
  assert.equal(r.stderr, '');
  const [pong, help, helpAgain, other, unknown] = s.fake.sentTexts();
  assert.match(pong, /^pong \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d$/);
  for (const command of ['/help', '/ping', '/new <name>', '/loop <name>', '/stop', '/cancel', '/testmode [on|off|set <key> <value>]']) assert.ok(help.includes(command), command);
  assert.equal(help.split('\n').length, 15, 'the heading and 14 commands');
  assert.equal(help.includes('/build'), false, '/build is gone');
  assert.equal(helpAgain, help);
  assert.equal(other, 'I did not understand that. Send /help for the list of commands.');
  assert.equal(unknown, 'I do not know /start. Send /help for the list of commands.');
  assert.ok(s.fake.sent.every((m) => m.chatId === s.owner && m.parseMode === null));
  assert.equal((await s.tick()).stdout, 'idle\n');
});

test('only the owner in the private chat is answered; anyone else gets nothing and one log line', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  const stranger = 777000111;
  s.fake.message(stranger, 'SECRET_TEXT /ping', { username: 'stranger' });
  s.fake.message(stranger, '/new Stolen', { username: null });
  // The owner writes in a group: the sender matches, the chat does not.
  s.fake.message(-1001234, '/ping', { from: s.owner, chatType: 'group' });
  // Someone else in a chat that carries the owner's ID.
  s.fake.message(s.owner, '/ping', { from: stranger, username: 'pretender' });
  // The right IDs, but not a private chat.
  s.fake.message(s.owner, '/ping', { chatType: 'group' });
  s.fake.press(stranger, 'new:save:abc', { username: 'stranger' });
  s.fake.press(-1001234, 'new:save:abc', { from: s.owner, chatType: 'group' });
  s.fake.message(s.owner, '/ping');
  const r = await s.tick();
  assert.equal(r.status, 0, r.stderr);

  assert.equal(s.fake.sent.length, 1, 'only the owner\'s /ping was answered');
  assert.equal(s.fake.sent[0].chatId, s.owner);
  assert.equal(s.fake.callsOf('answerCallbackQuery').length, 0, 'a stranger\'s button press is not answered either');
  assert.deepEqual(s.logTexts().slice(1), [
    `not the owner: chat ${stranger}, username @stranger`,
    `not the owner: chat ${stranger}, username (none)`,
    'not the owner: chat -1001234, username @owner_name',
    `not the owner: chat ${s.owner}, username @pretender`,
    `not the owner: chat ${s.owner}, username @owner_name`,
    `not the owner: chat ${stranger}, username @stranger`,
    'not the owner: chat -1001234, username @owner_name',
  ]);
  assert.equal(s.readLog().join('\n').includes('SECRET_TEXT'), false, 'nothing of the message is logged');
  assert.equal(fs.readdirSync(s.projectsRoot).length, 0);
});

test('without owner-chat-id.txt or bot-token.txt the tick logs one line and asks Telegram nothing', async (t) => {
  const noOwner = await botSandbox(t, { withOwner: false });
  noOwner.fake.message(noOwner.owner, '/ping');
  const r = await noOwner.tick();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'not set up: owner-chat-id.txt is missing\n');
  assert.deepEqual(noOwner.fake.requests, [], 'no request reached Telegram');
  assert.equal(noOwner.logTexts().length, 1);
  assert.match(noOwner.logTexts()[0], /^not set up: owner-chat-id\.txt was not found in .*secrets\. Run "node scripts\\bot\.js whoami"/);
  assert.equal(fs.existsSync(path.join(noOwner.runtimeDir, 'state.json')), false, 'no state was written');

  const noToken = await botSandbox(t, { withToken: false });
  const r2 = await noToken.tick();
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.stdout, 'not set up: bot-token.txt is missing\n');
  assert.deepEqual(noToken.fake.requests, []);

  const badToken = await botSandbox(t);
  fs.writeFileSync(path.join(badToken.secretsDir, 'bot-token.txt'), 'NOT_A_TOKEN_SECRETMARK\r\n');
  const r3 = await badToken.tick();
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(r3.stdout, 'not set up: bot-token.txt is not valid\n');
  assert.equal(badToken.readLog().join('\n').includes('SECRETMARK'), false, 'the content of the file is never shown');
  assert.deepEqual(badToken.fake.requests, []);
});

test('/new with two text messages: summary, Save, and the project is created only then', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  s.fake.message(s.owner, '/new Hello_1');
  await s.tick();
  assert.match(s.fake.sentTexts().pop(), /^New project Hello_1, step 1 of 2: send GOAL\.md, as a text message, or as a \.md or \.txt file \(up to 100 KB\)\.\n\/cancel stops this\.$/);
  s.fake.message(s.owner, GOAL);
  await s.tick();
  assert.match(s.fake.sentTexts().pop(), /^GOAL\.md received: \d+ bytes\.\nStep 2 of 2: send the first prompt/);
  s.fake.message(s.owner, PROMPT);
  await s.tick();

  const summary = s.fake.sent.pop();
  const folder = path.join(s.projectsRoot, 'Hello_1');
  assert.equal(summary.text, [
    'Ready to create the project. Nothing exists yet.',
    'Name: Hello_1',
    `Folder: ${folder}`,
    `GOAL.md: ${Buffer.byteLength(GOAL)} bytes, 7 lines. It starts:`,
    '  # GOAL: say hello',
    '  A script that prints hello.',
    '  ## Definition of done',
    '  - [ ] hello.js prints hello',
    // Phase 7: whether /overnight can run on it.
    'Overnight: GOAL.md has no "## Overnight" section, so /overnight cannot run on it; /loop can.',
    `First prompt: ${Buffer.byteLength(PROMPT)} bytes`,
  ].join('\n'));
  const [save, cancel] = summary.replyMarkup.inline_keyboard[0];
  assert.deepEqual([save.text, cancel.text], ['Save', 'Cancel']);
  assert.equal(fs.existsSync(folder), false, 'nothing is created before Save');

  s.fake.message(s.owner, 'and now?');
  await s.tick();
  assert.equal(s.fake.sentTexts().pop(), 'Press Save or Cancel on the summary above, or send /cancel.');

  s.fake.press(s.owner, save.callback_data);
  await s.tick();
  const commit = git(folder, 'rev-parse', '--short', 'HEAD');
  assert.equal(s.fake.sentTexts().pop(), [
    `Created ${folder}`,
    `Commit ${commit} "Loop: GOAL.md" (.gitignore and GOAL.md)`,
    'The first prompt is saved as .audit\\round-01-prompt.md',
    'Next: /loop Hello_1',
  ].join('\n'));
  assert.deepEqual(s.fake.sent.filter((m) => m.method === 'answerCallbackQuery').map((m) => m.text), ['Saved']);
  assert.equal(git(folder, 'log', '--format=%s'), 'Loop: GOAL.md');
  assert.deepEqual(git(folder, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.gitignore', 'GOAL.md']);
  assert.equal(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8'), '.audit/\n.env\n');
  assert.equal(fs.readFileSync(path.join(folder, 'GOAL.md'), 'utf8'), GOAL);
  assert.equal(fs.readFileSync(path.join(folder, '.audit', 'round-01-prompt.md'), 'utf8'), PROMPT);
  assert.equal(git(folder, 'status', '--porcelain'), '');
  assert.deepEqual(s.state().conversations, {});

  // The same button once more: it only answers that it has expired.
  const before = s.fake.sent.length;
  s.fake.press(s.owner, save.callback_data);
  await s.tick();
  assert.deepEqual(s.fake.sent.slice(before), [{ method: 'answerCallbackQuery', id: s.fake.sent[before].id, text: 'This button has expired.' }]);
});

test('/new with two files, a GOAL.md without "Definition of done", and Cancel creates nothing', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  s.fake.message(s.owner, '/new From_Files');
  s.fake.document(s.owner, 'GOAL.md', '\uFEFF# GOAL\r\nNo list of what done means. Ünïcödé and العربية stay as they are.\r\n');
  s.fake.document(s.owner, 'first-prompt.TXT', 'Do the first step.\n');
  await s.tick();
  const summary = s.fake.sent.pop();
  assert.ok(summary.text.includes('WARNING: GOAL.md has no "Definition of done". The auditor needs one to know when the project is finished.'));
  assert.ok(summary.text.includes('  No list of what done means. Ünïcödé and العربية stay as they are.'));
  assert.equal(s.state().conversations[s.owner].goal.startsWith('# GOAL'), true, 'the byte order mark is dropped');

  const [, cancel] = summary.replyMarkup.inline_keyboard[0];
  s.fake.press(s.owner, cancel.callback_data);
  await s.tick();
  assert.equal(s.fake.sentTexts().pop(), 'Cancelled: From_Files was not created.');
  assert.deepEqual(fs.readdirSync(s.projectsRoot), [], 'nothing was created, so nothing had to be deleted');
  assert.deepEqual(s.state().conversations, {});

  // Save on that cancelled summary has expired too.
  const [save] = summary.replyMarkup.inline_keyboard[0];
  s.fake.press(s.owner, save.callback_data);
  await s.tick();
  assert.equal(s.fake.sent.pop().text, 'This button has expired.');
  assert.deepEqual(fs.readdirSync(s.projectsRoot), []);
});

test('/new refuses a bad name, a Windows device name and a name that exists in another letter case', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  fs.mkdirSync(path.join(s.projectsRoot, 'Taken_Name'));
  const cases = [
    ['/new', /^A project needs a name\./],
    ['/new two words', /may only have letters/],
    ['/new dot.name', /may only have letters/],
    ['/new ..', /may only have letters/],
    [`/new ${'x'.repeat(41)}`, /The name is 41 characters long\. The limit is 40\./],
    ['/new -rf', /must start with a letter or a digit/],
    ['/new CON', /"CON" is a name that Windows keeps for itself\./],
    ['/new lpt1', /Windows keeps for itself/],
    ['/new taken_name', /^"Taken_Name" already exists in .*projects\. Pick another name\.$/],
  ];
  for (const [text] of cases) s.fake.message(s.owner, text);
  await s.tick();
  const answers = s.fake.sentTexts();
  cases.forEach(([text, pattern], i) => assert.match(answers[i], pattern, text));
  assert.deepEqual(s.state().conversations, {}, 'no conversation was started');
  assert.deepEqual(fs.readdirSync(s.projectsRoot), ['Taken_Name']);
});

test('/cancel drops the conversation, and a new /new replaces one in progress', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  s.fake.message(s.owner, '/cancel');
  s.fake.message(s.owner, '/new First');
  s.fake.message(s.owner, GOAL);
  s.fake.message(s.owner, '/new Second');
  await s.tick();
  assert.equal(s.fake.sentTexts()[0], 'There is nothing to cancel.');
  assert.deepEqual(s.state().conversations[s.owner], { kind: 'new', step: 'goal', name: 'Second' });
  s.fake.message(s.owner, '/cancel');
  s.fake.message(s.owner, GOAL);
  await s.tick();
  const texts = s.fake.sentTexts();
  assert.equal(texts[texts.length - 2], 'Cancelled: Second was not created.');
  assert.equal(texts[texts.length - 1], 'I did not understand that. Send /help for the list of commands.');
  assert.deepEqual(fs.readdirSync(s.projectsRoot), []);
});

test('a file must be .md or .txt, UTF-8 and at most 100 KB; a long text must come as a file', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  s.fake.message(s.owner, '/new Picky');
  s.fake.document(s.owner, 'GOAL.pdf', 'x');
  s.fake.document(s.owner, 'GOAL.md', 'x'.repeat(100 * 1024 + 1));
  // The message says 10 bytes, the download is larger: the real size counts.
  s.fake.document(s.owner, 'GOAL.md', 'y'.repeat(100 * 1024 + 1), { declaredSize: 10 });
  s.fake.document(s.owner, 'GOAL.md', Buffer.from([0x47, 0x4f, 0xff, 0xfe, 0x41]));
  s.fake.document(s.owner, 'GOAL.md', '   \n');
  s.fake.message(s.owner, 'z'.repeat(4000));
  await s.tick();
  const answers = s.fake.sentTexts().slice(1);
  const ask = '\nSend GOAL.md as a text message, or as a .md or .txt file (up to 100 KB), or /cancel.';
  assert.deepEqual(answers, [
    `That file is not a .md or .txt file.${ask}`,
    `That file has 102401 bytes. The limit is 100 KB.${ask}`,
    'That did not work and was skipped: Telegram file download: the file is larger than 102400 bytes',
    `That file is not UTF-8 text. Save it as UTF-8 and send it again.${ask}`,
    `That file is empty.${ask}`,
    `That text is long enough for Telegram to have cut it into several messages. Send it as a .md or .txt file instead.${ask}`,
  ]);
  assert.deepEqual(s.state().conversations[s.owner], { kind: 'new', step: 'goal', name: 'Picky' }, 'still waiting for GOAL.md');

  // A file of exactly 100 KB is taken.
  s.fake.document(s.owner, 'GOAL.md', 'g'.repeat(100 * 1024));
  await s.tick();
  assert.match(s.fake.sentTexts().pop(), /^GOAL\.md received: 102400 bytes\./);
});

test('an update whose handling throws is logged, answered and skipped: the ones after it are handled', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  s.fake.message(s.owner, '/new Sturdy');
  const broken = s.fake.document(s.owner, 'GOAL.md', GOAL);
  s.fake.files.delete(broken.message.document.file_id); // getFile will fail for this one
  s.fake.message(s.owner, '/ping');
  s.fake.document(s.owner, 'GOAL.md', GOAL);
  const r = await s.tick();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ok: 4 updates, 4 sent\n');
  const texts = s.fake.sentTexts();
  assert.equal(texts[1], 'That did not work and was skipped: Telegram getFile: 400 Bad Request: file not found');
  assert.match(texts[2], /^pong /);
  assert.match(texts[3], /^GOAL\.md received/);
  assert.deepEqual(s.logTexts().slice(1), [`update ${broken.update_id} failed and was skipped: Telegram getFile: 400 Bad Request: file not found`]);
  assert.equal(s.state().offset, broken.update_id + 3, 'the offset moved past all four');
});

test('the offset is saved after each update, and the next tick asks from there', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  const last = [s.fake.message(s.owner, '/ping'), s.fake.message(s.owner, '/ping'), s.fake.message(s.owner, '/ping')].pop();
  await s.tick();
  assert.equal(s.state().offset, last.update_id + 1);
  await s.tick();
  assert.equal(s.fake.callsOf('getUpdates').pop().params.offset, last.update_id + 1);
  assert.equal(s.fake.sentTexts().length, 3, 'no update was handled twice');
  assert.deepEqual(fs.readdirSync(s.runtimeDir).sort(), ['last-tick.txt', 'logs', 'state.json', 'state.json.bak'], 'no temp file and no lock is left');
});

test('a tick that finds another tick running exits at once; a stale lock is taken over', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  s.fake.message(s.owner, '/ping');
  const lock = path.join(s.runtimeDir, 'tick.lock');

  // Held by a living process: this test.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const before = s.fake.requests.length;
  const busy = await s.tick();
  assert.equal(busy.status, 0, busy.stderr);
  assert.equal(busy.stdout, 'busy: another tick is running\n');
  assert.equal(s.fake.requests.length, before, 'it asked Telegram nothing');
  assert.equal(s.fake.sentTexts().length, 0);

  // The same lock, three minutes old: stale.
  const old = new Date(Date.now() - 3 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  const took = await s.tick();
  assert.equal(took.stdout, 'ok: 1 update, 1 sent\n');
  assert.match(s.logTexts().pop(), /^took over a stale lock \(pid \d+, 1\d\d s old\)$/);
  assert.equal(fs.existsSync(lock), false);
});

test('a tick without network ends quietly: one log line, exit 0, and the message waits for the next tick', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  const server = net.createServer();
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const dead = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => { server.close(resolve); });
  const offline = s.writeConfig({ telegramBaseUrl: dead });

  s.fake.message(s.owner, '/ping');
  const lines = s.readLog().length;
  const r = await s.tick({ configFile: offline });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'no network\n');
  assert.equal(r.stderr, '');
  // Phase 7b: the line of an outage's start (it was "no network: ..." on every failing tick).
  assert.deepEqual(s.logTexts().slice(lines), ['Telegram unreachable: Telegram getUpdates: no answer (ECONNREFUSED); the loop goes on, and what it sends waits in the outbox']);
  assert.ok(r.ms < 10000, `the tick took ${r.ms} ms`);

  // With the network back, nothing was lost.
  const back = await s.tick();
  assert.equal(back.stdout, 'ok: 1 update, 1 sent\n');
});

test('a message that cannot be sent stays in the outbox and goes out once, on a later tick', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  s.fake.modeFor.sendMessage = 'error500';
  s.fake.message(s.owner, '/ping');
  s.fake.message(s.owner, '/help');
  const r = await s.tick();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ok: 2 updates, 2 waiting to be sent\n');
  assert.equal(s.state().outbox.length, 2);
  assert.deepEqual(s.logTexts().slice(1), ['not sent: Telegram sendMessage: 500 Internal Server Error; 2 waiting to be sent']);

  delete s.fake.modeFor.sendMessage;
  const later = await s.tick();
  assert.equal(later.stdout, 'ok: 2 sent\n');
  const texts = s.fake.sentTexts();
  assert.equal(texts.length, 2);
  assert.match(texts[0], /^pong /);
  assert.match(texts[1], /^Commands:/);
  assert.deepEqual(s.state().outbox, []);
  assert.equal((await s.tick()).stdout, 'idle\n');
});

test('a wrong token: Telegram says 401, the tick logs it and still exits 0', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  s.fake.mode = 'unauthorized';
  const r = await s.tick();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Telegram refused getUpdates: see the log\n');
  assert.equal(s.logTexts().pop(), 'no updates: Telegram getUpdates: 401 Unauthorized');
});

test('whoami lists who wrote to the bot and moves nothing', async (t) => {
  const s = await botSandbox(t, { withOwner: false });
  const none = await s.bot('whoami');
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /^No message is waiting\. Send any message to your bot in Telegram, then run this again\./);

  s.fake.message(s.owner, 'hi', { username: 'the_owner' });
  s.fake.message(s.owner, 'hi again', { username: 'the_owner' });
  s.fake.message(31337, 'hello', { username: null });
  const r = await s.bot('whoami');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [
    '3 waiting update(s), from:',
    `chat ID ${s.owner} (private chat), name: Test User, username: @the_owner`,
    'chat ID 31337 (private chat), name: Test User, username: (none)',
    '',
    'Put your chat ID, the number only, in owner-chat-id.txt next to bot-token.txt.',
    '',
  ].join('\n'));
  assert.equal(s.fake.updates.length, 3, 'the updates are still waiting');
  assert.equal(s.fake.sent.length, 0, 'nothing was answered');
  assert.equal(fs.existsSync(path.join(s.runtimeDir, 'state.json')), false, 'no state was written');
  assert.ok(s.fake.callsOf('getUpdates').every((c) => !('offset' in c.params)), 'no offset was sent');
  assert.equal((await s.bot('whoami')).stdout, r.stdout, 'a second run shows the same');

  const noToken = await botSandbox(t, { withToken: false });
  const missing = await noToken.bot('whoami');
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /^bot-token\.txt was not found in /);
});

test('netcheck makes one request without the token', async (t) => {
  const s = await botSandbox(t, { withToken: false, withOwner: false });
  const r = await s.bot('netcheck');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${s.fake.baseUrl}/ answered with HTTP 302\n`);
  assert.deepEqual(s.fake.requests, ['GET /']);
});

test('the DNS fix can be loaded twice: a tick started the way n8n starts it works the same', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  s.fake.message(s.owner, '/ping');
  const fix = path.join(ROOT, 'n8n-loop', 'dns-fallback.cjs');
  const r = await s.tick({ extraEnv: { NODE_OPTIONS: `--require=${fix}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ok: 1 update, 1 sent\n');
  assert.equal(r.stderr, '');

  // Loaded by NODE_OPTIONS and then again by require: dns.lookup is patched once.
  const probe = spawnSync(process.execPath, ['-e', `
    const dns = require('node:dns');
    const once = dns.lookup;
    require(${JSON.stringify(fix)});
    require(${JSON.stringify(fix.toUpperCase())});
    console.log(dns.lookup === once, Boolean(dns[Symbol.for('n8n.dns-fallback.installed')]));
  `], { env: { ...process.env, NODE_OPTIONS: `--require=${fix}` }, encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), 'true true', probe.stderr);
});

test('bad arguments and a bad config exit with code 2', async (t) => {
  const s = await botSandbox(t);
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bot.js'), ...args], { encoding: 'utf8' });
  for (const args of [[], ['nonsense'], ['tick', '--bogus'], ['tick', '--config']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /Usage: node scripts\/bot\.js tick\|whoami\|netcheck/);
  }
  const missing = run('tick', '--config', path.join(s.dir, 'nope.json'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read config/);
  // A fake Telegram server together with the real secrets folder is refused.
  const unsafe = run('tick', '--config', s.writeConfig({ secretsDir: undefined }));
  assert.equal(unsafe.status, 2);
  assert.match(unsafe.stderr, /the real token is never sent to another server/);
});

test('the token shows up nowhere: not in any output, not in any file of the runtime folder', async (t) => {
  const s = await botSandbox(t);
  const key = s.token.slice(s.token.indexOf(':') + 1);
  await s.firstTick();

  // The ordinary paths.
  s.fake.message(s.owner, '/ping');
  s.fake.message(s.owner, '/new Canary_Project');
  s.fake.message(s.owner, GOAL);
  s.fake.message(s.owner, PROMPT);
  await s.tick();
  s.fake.press(s.owner, buttons(s.fake)[0].callback_data);
  await s.tick();
  // A stranger, and a handler that fails.
  s.fake.message(999, 'hello', { username: 'stranger' });
  s.fake.message(s.owner, '/new Canary_Two');
  const broken = s.fake.document(s.owner, 'GOAL.md', GOAL);
  s.fake.files.delete(broken.message.document.file_id);
  await s.tick();
  // A server that repeats the request path, token included, in its error: on one
  // method while the update is handled, then on every call.
  s.fake.modeFor.getFile = 'echo';
  s.fake.document(s.owner, 'GOAL.md', GOAL);
  await s.tick();
  s.fake.modeFor = {};
  s.fake.mode = 'echo';
  await s.tick();
  // 401, 500, a dropped connection, a closed port, and a message stuck in the outbox.
  for (const mode of ['unauthorized', 'error500', 'hangup']) {
    s.fake.mode = mode;
    await s.tick();
    await s.bot('whoami');
  }
  s.fake.mode = 'ok';
  s.fake.modeFor.sendMessage = 'echo';
  s.fake.message(s.owner, '/help');
  await s.tick();
  s.fake.modeFor.sendMessage = 'hangup';
  s.fake.message(s.owner, '/help');
  await s.tick();
  s.fake.modeFor = {};
  const server = net.createServer();
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const offline = s.writeConfig({ telegramBaseUrl: `http://127.0.0.1:${server.address().port}` });
  await new Promise((resolve) => { server.close(resolve); });
  await s.tick({ configFile: offline });
  await s.bot('whoami', { configFile: offline });
  await s.bot('netcheck', { configFile: offline });
  await s.bot('whoami');
  await s.tick();

  // The filter was at work: the echoed paths are in the log, with the placeholder.
  const log = s.readLog().join('\n');
  assert.ok(log.includes('no method at /bot<bot-token>/getUpdates'), 'the echoed getUpdates path is in the log, redacted');
  assert.ok(log.includes('/bot<bot-token>/getFile'), 'the echoed getFile path is in the log, redacted');
  assert.ok(s.fake.sentTexts().some((text) => text.includes('/bot<bot-token>/getFile')), 'and in the answer to the owner, redacted');

  const needles = [s.token, key, encodeURIComponent(s.token)];
  const hits = [];
  s.outputs.forEach((text, i) => needles.forEach((needle) => { if (text.includes(needle)) hits.push(`output ${i}`); }));
  const files = filesUnder(s.runtimeDir);
  files.forEach(({ file, text }) => needles.forEach((needle) => { if (text.includes(needle)) hits.push(file); }));
  assert.ok(s.outputs.length >= 30, `${s.outputs.length} outputs were searched`);
  assert.ok(files.length >= 2, `${files.length} runtime files were searched`);
  assert.deepEqual(hits, [], 'the token was found');
  t.diagnostic(`canary search: ${s.outputs.length} outputs and ${files.length} runtime files searched for 3 forms of the token, ${hits.length} hits`);
});

// ---- a state file written by Phase 3a ----

// A job entry as Phase 3a's /build wrote it: kind "build", and its record is the builder's summary.
function oldBuildJob(s, id, name, project, extra = {}) {
  return {
    id,
    kind: 'build',
    name,
    project,
    round: 1,
    startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    summaryFile: path.join(project, '.audit', 'round-01-builder.json'),
    logFile: path.join(s.runtimeDir, 'logs', `job-${id}.log`),
    sessionReported: false,
    ended: false,
    ...extra,
  };
}

test('a state.json from Phase 3a loads as it is: the offset is kept, it is no first tick, and its old build jobs are fine', async (t) => {
  const s = await botSandbox(t);
  const { dir: project } = createProject({ root: s.projectsRoot, name: 'Old_Build', goal: GOAL, prompt: PROMPT });
  // The builder of that job finished while the bot was being updated.
  const at = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(project, '.audit', 'round-01-builder.json'), JSON.stringify({
    round: 1, project, status: 'completed', runner_pid: 1, session_id: SESSION, started_at: at, heartbeat_at: at, finished_at: at, duration_s: 35.2,
    exit_code: 0, turns: 9, cost_usd: 0.1466, context: { window: 1000000, peak_tokens: 11000, peak_percent: 1.1, final_tokens: 11000, final_percent: 1.1 },
    compacted: false, compactions: [], handoff_written: true, permission_denials: [{ tool: 'Bash', input: 'node --test; echo done' }],
  }));
  fs.writeFileSync(path.join(project, '.audit', 'round-01-builder.log'), 'the old log\n');
  // The file exactly as Phase 3a wrote it: no "loop" key.
  const old = {
    offset: 734002911,
    conversations: {},
    outbox: [],
    jobs: [
      oldBuildJob(s, 1, 'Gone_Project', path.join(s.projectsRoot, 'Gone_Project'), { sessionReported: true, ended: true }),
      oldBuildJob(s, 2, 'Old_Build', project),
    ],
    nextId: 3,
  };
  fs.mkdirSync(s.runtimeDir, { recursive: true });
  fs.writeFileSync(s.stateFile, `${JSON.stringify(old, null, 2)}\n`);
  s.fake.nextUpdateId = 734002911;
  s.fake.message(s.owner, '/ping');

  const r = await s.tick();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(s.fake.callsOf('getUpdates')[0].params.offset, 734002911, 'the first request asks from the saved offset');
  assert.equal(s.logTexts().some((line) => line.startsWith('first tick')), false, 'it did not act like a first tick');
  // This is the bot's first tick with the code of Phase 4: there is no note of the
  // last tick yet, so it says that it was offline, and that it does not know since when.
  const all = s.fake.sentTexts();
  assert.match(all[0], /^The bot was offline until \d\d:\d\d\. Since when is not known: its note of the last tick \(runtime\\last-tick\.txt\) was missing or not readable\.$/);
  assert.equal(fs.existsSync(s.lastTickFile), true, 'the note is written from now on');
  const texts = all.slice(1);
  // Since Phase 5 prep, what waited through a gap is not acted on: the bot names it instead.
  assert.equal(texts[0], 'While I was offline you sent: /ping. It did not run. Send it again if you still want it.');
  assert.equal(all.some((text) => /^pong /.test(text)), false, 'the update that was waiting did not run');
  assert.equal(texts[1], `Builder session for Old_Build: ${SESSION}\nTo take it over on the PC, run this in ${project}:\nclaude --resume ${SESSION}`);
  const end = texts[2].split('\n');
  assert.equal(end[0], 'Builder finished: Old_Build, round 1');
  assert.equal(end[1], 'Result: completed (exit code 0)');
  assert.equal(end[3], 'Turns: 9, cost: $0.1466');
  assert.equal(end[4], 'Context: peak 11,000 tokens (1.1%), at the end 11,000 tokens (1.1%), window 1,000,000');
  assert.equal(end[7], 'Denied tool calls: 1');
  const document = s.fake.sent.find((m) => m.method === 'sendDocument');
  assert.equal(document.filename, 'Old_Build-round-01-builder.log');
  assert.equal(document.content, 'the old log\n');

  const state = s.state();
  assert.equal(state.offset, 734002912);
  assert.equal(state.nextId, 3);
  assert.equal(state.loop, null, 'the new key is there');
  assert.deepEqual(state.jobs.map((job) => [job.id, job.kind, job.ended]), [[1, 'build', true], [2, 'build', true]]);
  assert.deepEqual(state.jobs[0], old.jobs[0], 'an old entry that had ended is kept as it was');

  // Nothing is reported twice, and /build itself is gone.
  const sent = s.fake.sent.length;
  s.fake.message(s.owner, '/build Old_Build');
  await s.tick();
  assert.deepEqual(s.fake.sentTexts().slice(4), ['I do not know /build. Send /help for the list of commands.'], 'and the offline message is not said again');
  assert.equal(s.fake.sent.length, sent + 1);
});

test('an old build job that is still running blocks /loop; one that died is reported as lost, once', async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  const { dir: project } = createProject({ root: s.projectsRoot, name: 'Lost', goal: GOAL, prompt: PROMPT });
  createProject({ root: s.projectsRoot, name: 'Waiting', goal: GOAL, prompt: PROMPT });
  const summaryFile = path.join(project, '.audit', 'round-01-builder.json');
  const running = (heartbeat) => fs.writeFileSync(summaryFile, JSON.stringify({ status: 'running', session_id: SESSION, started_at: heartbeat, heartbeat_at: heartbeat, runner_pid: 1 }));
  const state = s.state();
  state.jobs.push(oldBuildJob(s, 1, 'Lost', project, { sessionReported: true }));
  fs.writeFileSync(s.stateFile, JSON.stringify(state));

  // Its heartbeat is fresh: it counts as running, and one job at a time is the rule.
  running(new Date().toISOString());
  s.fake.message(s.owner, '/loop Waiting');
  await s.tick();
  assert.match(s.fake.sentTexts().pop(), /^\/loop was refused: a job is still running: the builder for Lost, started at \d\d:\d\d:\d\d\.$/);
  assert.equal(s.state().loop, null);

  // No sign of life for ten minutes: lost.
  running(new Date(Date.now() - 10 * 60 * 1000).toISOString());
  await s.tick();
  assert.match(s.fake.sentTexts().pop(), /^The builder for Lost, round 1, ended without a result: its process is gone and its record has no end\./);
  const sent = s.fake.sent.length;
  await s.tick();
  assert.equal(s.fake.sent.length, sent, 'it is reported once');
  assert.equal(s.state().jobs[0].ended, true);
});

