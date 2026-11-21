const { test } = require('node:test');
const assert = require('node:assert/strict');
const { capture, token } = require('./helpers.cjs');
const { RequestIds, requestTimeout, EventLimiter, MySQLAuthenticationPlugin } = require(process.env.OTF_TEST_BUNDLE);

test('request IDs skip pending values, wrap, and bound exhausted allocation', () => {
    const ids = new RequestIds(0xfffe);
    const pending = new Map([['fffe', {}], ['0000', {}]]);
    assert.equal(ids.allocate(pending), 'ffff');
    assert.equal(ids.allocate(pending), '0001');
    // A single available ID can be reused after scanning occupied values: wrap
    // means counter advances, not a guaranteed number of forwarded requests.
    const full = new Map(Array.from({ length: 65536 }, (_, n) => [n.toString(16).padStart(4, '0'), {}]));
    assert.equal(ids.allocate(full), undefined);
    full.delete('0001');
    assert.equal(ids.allocate(full), '0001');
    assert.equal(ids.allocate(full), '0001');
});

test('normal allocation avoids reuse for a complete counter cycle', () => {
    const ids = new RequestIds(17);
    const seen = new Set();
    const pending = new Map();
    for (let n = 0; n < 65536; n++) {
        const value = ids.allocate(pending);
        assert.equal(seen.has(value), false);
        seen.add(value);
    }
    assert.equal(ids.allocate(pending), '0011');
});

test('request deadline defaults to 60 seconds and rejects invalid or excessive configuration safely', () => {
    const logs = capture();
    assert.equal(requestTimeout(undefined, logs.logger), 60000);
    assert.equal(requestTimeout('60000', logs.logger), 60000);
    assert.equal(requestTimeout(123, logs.logger), 123);
    for (const value of ['', 'not-a-number-secret', 'Infinity', '-1', 0, 0.5, 300001, null]) {
        assert.equal(requestTimeout(value, logs.logger), 60000);
    }
    assert.equal(logs.text().includes('not-a-number-secret'), false);
});

test('rejection logging bounds same-key and distinct-key bursts and reports suppression', () => {
    let now = 0;
    const logs = capture();
    const limiter = new EventLimiter(100, 8, 10, () => now);
    for (let n = 0; n < 1000; n++) limiter.log(logs.logger, 'info', 'rejected', 'same');
    assert.equal(logs.records().length, 1);
    now = 101;
    limiter.log(logs.logger, 'info', 'rejected', 'same');
    assert.equal(logs.records().at(-1).suppressed, 999);
    for (let n = 0; n < 1000; n++) limiter.log(logs.logger, 'info', 'rejected', `key-${n}`);
    assert.ok(logs.records().length <= 11);
    assert.ok(limiter.entries.size <= 8);
});

test('MySQL backend errors reject with a sanitized code instead of invalid-key false', async () => {
    const logs = capture();
    const plugin = new MySQLAuthenticationPlugin();
    plugin.logger = logs.logger;
    plugin.pool = { query: (_sql, args, callback) => {
        assert.equal(args[1], token);
        callback(Object.assign(new Error(`query contained ${token}`), {
            code: 'ER_PARSE_ERROR', sql: `SELECT secret '${token}'`, sqlMessage: token,
        }));
    } };
    await assert.rejects(plugin.validateKey(token), error => {
        assert.equal(error.code, 'ER_PARSE_ERROR');
        assert.equal(error.message, 'Authentication backend unavailable');
        assert.equal('sql' in error, false);
        assert.equal(JSON.stringify(error).includes(token), false);
        return true;
    });
    assert.equal(logs.text().includes(token), false);
    plugin.pool = { query: (_sql, _args, callback) => callback(null, []) };
    assert.equal(await plugin.validateKey(token), false);
    plugin.pool = { query: (_sql, _args, callback) => callback(null, [{}]) };
    assert.equal(await plugin.validateKey(token), true);
});
