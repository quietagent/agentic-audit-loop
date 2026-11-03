'use strict';
/*
 * dns-fallback.cjs - DNS fallback for the loop's n8n on this PC.
 *
 * A copy of C:\Projects\Making_Life_Easier\n8n\dns-fallback.cjs (the email
 * assistant's n8n), made in Phase 2b. Two things differ from that file: this
 * comment, and the DNS_FALLBACK_QUIET switch in noteOnce() (Phase 3a).
 *
 * Loaded through NODE_OPTIONS=--require=... in n8n-loop\.env. Node passes that
 * setting on, so every Node process that n8n starts loads this file too.
 *
 * Why: the router's DNS on this network does not answer for api.telegram.org.
 * Public DNS servers do. This file patches
 * dns.lookup and dns.promises.lookup, which is what Node's http, https and
 * fetch use to turn a host name into an address.
 *
 * What it does:
 *   - Names in DIRECT_HOSTS are resolved with a dns.Resolver that asks
 *     1.1.1.1, then 8.8.8.8 if the first does not reply. Windows is only asked
 *     if that gives no address. Answers are reused for one minute.
 *   - Every other name uses the normal Windows lookup first. Only if that fails
 *     with ENOTFOUND, EAI_AGAIN or a timeout is it retried once through the
 *     public servers. If they fail too, the caller gets the original error.
 *   - localhost, IP addresses, names ending in .local and single-word names
 *     are never touched.
 *   - Answers from the public servers put IPv4 first, unless the caller asked
 *     for order "ipv6first".
 *   - The first time a name is resolved through the public servers, one line is
 *     written to logs\dns-fallback.log: time, process id, "listed" or
 *     "fallback", and the host name. Never addresses or URLs. A process that
 *     sets DNS_FALLBACK_QUIET=1 writes no such line: the loop's bot does, because
 *     it is a new process every 5 seconds and would add a line each time.
 *   - It never throws while loading. If anything in here goes wrong, the
 *     original lookup is used.
 *
 * To add a name: put it in DIRECT_HOSTS (lower case) and restart n8n.
 * To switch it off: delete the NODE_OPTIONS line from n8n-loop\.env and
 * restart the loop's n8n.
 */
(function installDnsFallback() {
  try {
    const dns = require('node:dns');
    const MARK = Symbol.for('n8n.dns-fallback.installed');
    if (dns[MARK]) return;

    const net = require('node:net');
    const fs = require('node:fs');
    const path = require('node:path');
    const url = require('node:url');

    // ---- settings ----------------------------------------------------------
    const DIRECT_HOSTS = new Set(['api.telegram.org']);
    const PUBLIC_SERVERS = ['1.1.1.1', '8.8.8.8'];
    const RETRY_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEOUT', 'ETIMEDOUT']);
    const NAME_ANSWERS = new Set(['ENOTFOUND', 'ENODATA']); // the server replied: no such name / no such record
    const QUERY_TIMEOUT_MS = 1000; // first try; the second try waits twice as long
    const QUERY_TRIES = 2;
    const SERVER_DEADLINE_MS = 5000; // hard stop per server, in case a query never returns
    const CACHE_MS = 60 * 1000; // reuse a public answer for one minute
    const CACHE_MAX = 200;
    const LOG_MAX_NAMES = 1000;
    const LOG_FILE = path.join(__dirname, 'logs', 'dns-fallback.log');
    const VALID_ORDERS = ['verbatim', 'ipv4first', 'ipv6first'];

    const promisesApi = dns.promises;
    const origLookup = dns.lookup;
    const origPromisesLookup = promisesApi && promisesApi.lookup;
    if (typeof origLookup !== 'function' || typeof origPromisesLookup !== 'function') return;

    // ---- which names to handle ---------------------------------------------
    // Returns null (leave this call alone) or { host, direct }.
    function planFor(hostname) {
      if (typeof hostname !== 'string' || hostname.length === 0 || hostname.length > 253) return null;
      let host = hostname.toLowerCase();
      if (host.endsWith('.')) host = host.slice(0, -1);
      if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return null;
      if (host === 'local' || host.endsWith('.local')) return null;
      if (net.isIP(host) !== 0) return null;
      if (!host.includes('.')) return null; // single-word names are local network names
      const ascii = url.domainToASCII(host);
      if (!ascii || ascii.endsWith('.local') || net.isIP(ascii) !== 0) return null;
      return { host: ascii, direct: DIRECT_HOSTS.has(ascii) };
    }

    // Returns null (not understood: let the original lookup validate and answer)
    // or { family: 0|4|6, all: boolean, v6first: boolean }.
    function readOptions(options) {
      let family = 0;
      let all = false;
      let order;
      if (options === undefined || options === null) {
        // defaults
      } else if (typeof options === 'number') {
        family = options;
      } else if (typeof options === 'object') {
        const f = options.family;
        if (f === 'IPv4') family = 4;
        else if (f === 'IPv6') family = 6;
        else if (f !== undefined && f !== null) family = f;
        if (options.all !== undefined && options.all !== null) {
          if (typeof options.all !== 'boolean') return null;
          all = options.all;
        }
        if (options.hints !== undefined && options.hints !== null && typeof options.hints !== 'number') return null;
        if (options.verbatim !== undefined && options.verbatim !== null) {
          if (typeof options.verbatim !== 'boolean') return null;
          order = options.verbatim ? 'verbatim' : 'ipv4first';
        }
        if (options.order !== undefined && options.order !== null) {
          if (!VALID_ORDERS.includes(options.order)) return null;
          order = options.order;
        }
      } else {
        return null;
      }
      if (family !== 0 && family !== 4 && family !== 6) return null;
      if (order === undefined && typeof dns.getDefaultResultOrder === 'function') {
        order = dns.getDefaultResultOrder();
      }
      return { family, all, v6first: order === 'ipv6first' };
    }

    // ---- asking the public servers ------------------------------------------
    let servers = null;
    function getServers() {
      if (!servers) {
        servers = PUBLIC_SERVERS.map((address) => {
          const resolver = new dns.Resolver({ timeout: QUERY_TIMEOUT_MS, tries: QUERY_TRIES });
          resolver.setServers([address]);
          return { resolver, tail: Promise.resolve() };
        });
      }
      return servers;
    }

    // One question at a time per server. Measured on this network: when two
    // questions are in flight on the same resolver, only one answer gets
    // through and the other waits 1-2 s for a retry. One after the other takes
    // about 5 ms each.
    // Never rejects. serverFailed = no usable reply (timeout, refused, ...), as
    // opposed to the server answering "this name has no such address".
    function ask(server, method, host, family) {
      const job = () =>
        new Promise((resolve) => {
          try {
            server.resolver[method](host, (err, addresses) => {
              if (err) return resolve({ list: [], serverFailed: !NAME_ANSWERS.has(err.code) });
              if (!Array.isArray(addresses)) return resolve({ list: [], serverFailed: true });
              resolve({
                list: addresses.filter((a) => typeof a === 'string' && net.isIP(a) === family),
                serverFailed: false,
              });
            });
          } catch (_) {
            resolve({ list: [], serverFailed: true });
          }
        });
      const run = server.tail.then(job, job);
      server.tail = run;
      return run;
    }

    // IPv4 question first, then IPv6. Fills "out" as answers arrive.
    async function fill(out, server, host, family) {
      if (family !== 6) {
        const a = await ask(server, 'resolve4', host, 4);
        if (a.serverFailed) return;
        out.v4 = a.list;
      }
      if (family !== 4) {
        const b = await ask(server, 'resolve6', host, 6);
        if (b.serverFailed) {
          out.answered = out.v4.length > 0;
          return;
        }
        out.v6 = b.list;
      }
      out.answered = true;
    }

    function askServer(server, host, family) {
      const out = { v4: [], v6: [], answered: false };
      const work = fill(out, server, host, family).catch(() => {});
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(resolve, SERVER_DEADLINE_MS);
        if (typeof timer.unref === 'function') timer.unref();
      });
      // On the deadline, keep whatever has arrived so far.
      return Promise.race([work, deadline]).then(() => {
        clearTimeout(timer);
        return { v4: out.v4.slice(), v6: out.v6.slice(), answered: out.answered };
      });
    }

    // 1.1.1.1 first. 8.8.8.8 only if the first did not reply at all.
    async function queryServers(host, family) {
      for (const server of getServers()) {
        const found = await askServer(server, host, family);
        if (found.v4.length + found.v6.length > 0) return { v4: found.v4, v6: found.v6 };
        if (found.answered) break; // a real "no such name": the next server would say the same
      }
      throw new Error('no address from the public DNS servers');
    }

    // Resolves to { v4: [...], v6: [...] } with at least one address, or rejects.
    const cache = new Map(); // "family|host" -> { at, promise }
    function resolvePublic(host, family) {
      try {
        const key = family + '|' + host;
        const now = Date.now();
        const hit = cache.get(key);
        if (hit && now - hit.at < CACHE_MS) return hit.promise;
        const promise = queryServers(host, family);
        const entry = { at: now, promise };
        cache.delete(key);
        cache.set(key, entry);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        promise.catch(() => {
          if (cache.get(key) === entry) cache.delete(key);
        });
        return promise;
      } catch (err) {
        return Promise.reject(err);
      }
    }

    // New objects on every call: callers may change what they are given.
    function toList(found, opts) {
      const v4 = found.v4.map((address) => ({ address, family: 4 }));
      const v6 = found.v6.map((address) => ({ address, family: 6 }));
      const list = opts.v6first ? v6.concat(v4) : v4.concat(v6);
      if (list.length === 0) throw new Error('empty answer');
      return list;
    }

    // ---- log: one line per host name per process -----------------------------
    const noted = new Set();
    function two(n) {
      return (n < 10 ? '0' : '') + n;
    }
    function noteOnce(host, how) {
      try {
        if (process.env.DNS_FALLBACK_QUIET === '1') return;
        if (noted.has(host) || noted.size >= LOG_MAX_NAMES) return;
        noted.add(host);
        const d = new Date();
        const stamp = d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' +
          two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
        fs.appendFile(LOG_FILE, stamp + ' pid=' + process.pid + ' ' + how + ' ' + host + '\r\n', () => {});
      } catch (_) {
        // logging must never get in the way
      }
    }

    // ---- dns.lookup(hostname[, options], callback) -----------------------------
    function finish(callback, all, list) {
      if (all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    }

    function lookup(hostname, options, callback) {
      let plan = null;
      let opts = null;
      let cb = null;
      try {
        const noOptions = typeof options === 'function';
        cb = noOptions ? options : callback;
        if (typeof cb === 'function') {
          plan = planFor(hostname);
          if (plan) opts = readOptions(noOptions ? undefined : options);
        }
      } catch (_) {
        plan = null;
      }
      if (!plan || !opts) return origLookup.apply(this, arguments);

      const self = this;
      const args = arguments;

      if (plan.direct) {
        let pending;
        try {
          pending = resolvePublic(plan.host, opts.family);
        } catch (_) {
          return origLookup.apply(this, arguments);
        }
        pending
          .then((found) => {
            const list = toList(found, opts);
            noteOnce(plan.host, 'listed');
            return list;
          })
          .then(
            (list) => {
              process.nextTick(finish, cb, opts.all, list);
            },
            () => {
              // Public servers gave nothing: ask Windows after all.
              process.nextTick(() => {
                try {
                  origLookup.apply(self, args);
                } catch (err) {
                  cb(err);
                }
              });
            }
          );
        return {};
      }

      const onLookup = function (err) {
        if (!err || !RETRY_CODES.has(err.code)) return cb.apply(this, arguments);
        const cbThis = this;
        const cbArgs = arguments;
        let pending;
        try {
          pending = resolvePublic(plan.host, opts.family);
        } catch (_) {
          return cb.apply(this, arguments);
        }
        pending
          .then((found) => {
            const list = toList(found, opts);
            noteOnce(plan.host, 'fallback');
            return list;
          })
          .then(
            (list) => {
              process.nextTick(finish, cb, opts.all, list);
            },
            () => {
              // Public servers failed too: hand back the original error.
              process.nextTick(() => cb.apply(cbThis, cbArgs));
            }
          );
      };
      if (typeof options === 'function') return origLookup.call(this, hostname, onLookup);
      return origLookup.call(this, hostname, options, onLookup);
    }

    // ---- dns.promises.lookup(hostname[, options]) ------------------------------
    function promisesLookup(hostname, options) {
      let plan = null;
      let opts = null;
      try {
        plan = planFor(hostname);
        if (plan) opts = readOptions(options);
      } catch (_) {
        plan = null;
      }
      if (!plan || !opts) return origPromisesLookup.apply(this, arguments);

      const self = this;
      const args = arguments;
      const viaPublic = (how) =>
        resolvePublic(plan.host, opts.family).then((found) => {
          const list = toList(found, opts);
          noteOnce(plan.host, how);
          return opts.all ? list : list[0];
        });

      if (plan.direct) {
        return viaPublic('listed').catch(() => origPromisesLookup.apply(self, args));
      }
      return origPromisesLookup.apply(this, arguments).catch((err) => {
        if (!err || !RETRY_CODES.has(err.code)) throw err;
        return viaPublic('fallback').catch(() => {
          throw err;
        });
      });
    }

    // ---- install -----------------------------------------------------------------
    // Carry over what Node attaches to the original function (util.promisify support).
    for (const sym of Object.getOwnPropertySymbols(origLookup)) {
      try {
        Object.defineProperty(lookup, sym, Object.getOwnPropertyDescriptor(origLookup, sym));
      } catch (_) {
        // not essential
      }
    }

    dns.lookup = lookup;
    promisesApi.lookup = promisesLookup;
    Object.defineProperty(dns, MARK, { value: true, enumerable: false });

    try {
      // So that "import { lookup } from 'node:dns'" also sees the patched function.
      require('node:module').syncBuiltinESMExports();
    } catch (_) {
      // not essential
    }
  } catch (_) {
    // Never break the process that loads this file.
  }
})();
