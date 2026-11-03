'use strict';

// Entry point for `node --test tests/`. Node 22+ no longer scans a folder given to
// --test: it loads the folder as a module, which resolves to this file.
// tests/run_fixture_tests.js is left out on purpose (it makes real Claude calls).

require('./test_parse_verdict.js');
require('./test_run_auditor.js');
require('./test_clean_env.js');
require('./test_launcher.js');
require('./test_telegram.js');
require('./test_runtime.js');
require('./test_run_builder.js');
require('./test_bot.js');
require('./test_loop.js');
require('./test_controls.js');
require('./test_phase5.js');
require('./test_phase6.js');
require('./test_phase7.js');
require('./test_phase7b.js');
require('./test_phase7c.js');
require('./test_phase7d.js');
require('./test_phase7e.js');
require('./test_jobs.js');
