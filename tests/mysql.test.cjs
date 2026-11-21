const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MySQLAuthenticationPlugin } = require(process.env.OTF_TEST_BUNDLE);
const { capture, token } = require('./helpers.cjs');

test('MySQL pool limits override URL options and driver SQL debugging is disabled', async () => {
    const previous = { MYSQL_CONNECTION_URL: process.env.MYSQL_CONNECTION_URL, MYSQL_TABLE: process.env.MYSQL_TABLE };
    const plugin = new MySQLAuthenticationPlugin();
    try {
        process.env.MYSQL_CONNECTION_URL = 'mysql://fake:fake@localhost/otf_test?connectionLimit=999&queueLimit=0&waitForConnections=true&debug=true';
        process.env.MYSQL_TABLE = 'fake_devices';
        await plugin.init(capture().logger, { concurrency: 3 });
        assert.equal(plugin.pool.config.connectionLimit, 3);
        assert.equal(plugin.pool.config.waitForConnections, false);
        assert.equal(plugin.pool.config.queueLimit, 1);
        assert.equal(plugin.pool.config.connectionConfig.debug, false);
        assert.equal(plugin.pool.config.acquireTimeout, 10_000);
    } finally {
        await plugin.close();
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    }
});

test('caller disappearance during acquisition skips SQL and releases the connection once', async () => {
    const plugin = new MySQLAuthenticationPlugin();
    let acquired;
    let releases = 0;
    const abort = new AbortController();
    plugin.pool = { getConnection: callback => { acquired = callback; } };
    const operation = plugin.validateKey(token, { signal: abort.signal, remainingMs: () => 500 });
    abort.abort();
    acquired(null, { release: () => releases++, query: () => assert.fail('abandoned lookup ran SQL') });
    await assert.rejects(operation, error => error.code === 'AUTH_TIMEOUT');
    assert.equal(releases, 1);
});

test('driver query timeout uses remaining time and release waits for query completion', async () => {
    const plugin = new MySQLAuthenticationPlugin();
    plugin.table = 'fake_devices';
    let remaining = 200;
    let acquired;
    let completed;
    let releases = 0;
    plugin.pool = { getConnection: callback => { acquired = callback; } };
    const operation = plugin.validateKey(token, { signal: new AbortController().signal, remainingMs: () => remaining });
    remaining = 47.9;
    acquired(null, { release: () => releases++, query: (options, args, callback) => {
        assert.equal(options.sql, 'SELECT 1 FROM ?? WHERE device_key = ? LIMIT 1');
        assert.equal(options.timeout, 47);
        assert.deepEqual(args, ['fake_devices', token]);
        completed = callback;
    } });
    assert.equal(releases, 0);
    completed(null, [{}]);
    assert.equal(await operation, true);
    assert.equal(releases, 1);
});

test('deadline after acquisition and synchronous driver errors never leak SQL or start stale work', async () => {
    for (const stale of [true, false]) {
        const plugin = new MySQLAuthenticationPlugin();
        let acquired;
        let remaining = 100;
        let releases = 0;
        plugin.pool = { getConnection: callback => { acquired = callback; } };
        const operation = plugin.validateKey(token, { signal: new AbortController().signal, remainingMs: () => remaining });
        if (stale) remaining = 0;
        acquired(null, { release: () => releases++, query: () => {
            assert.equal(stale, false);
            throw Object.assign(new Error(token), { code: 'ER_PARSE_ERROR', sql: token });
        } });
        await assert.rejects(operation, error => {
            assert.equal(error.code, stale ? 'AUTH_TIMEOUT' : 'ER_PARSE_ERROR');
            assert.equal(JSON.stringify(error).includes(token), false);
            return true;
        });
        assert.equal(releases, 1);
    }
});
