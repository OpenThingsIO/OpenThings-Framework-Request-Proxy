const { test } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql');
const { MySQLAuthenticationPlugin } = require(process.env.OTF_TEST_BUNDLE);
const { fixture, capture, token, delay, until, receive, reply, id } = require('./helpers.cjs');

const options = { skip: process.env.OTF_TEST_MYSQL_ISOLATED !== '1' };
let sequence = 0;

async function database(t) {
    // Never fall back to the application's real authentication configuration.
    const url = process.env.OTF_TEST_MYSQL_URL;
    assert.equal(new URL(url).pathname, '/otf_test', 'Use a disposable otf_test database only');
    const admin = mysql.createConnection(url);
    const sql = (query, args = []) => new Promise((resolve, reject) =>
        admin.query(query, args, (error, rows) => error ? reject(error) : resolve(rows)));
    const table = `otf_test_${process.pid}_${sequence++}`;
    await sql('CREATE TABLE ?? (device_key VARCHAR(128) PRIMARY KEY)', [table]);
    await sql('INSERT INTO ?? VALUES (?), (?)', [table, token, 'second-fake-token']);
    t.after(async () => {
        await sql('UNLOCK TABLES');
        await sql('DROP TABLE IF EXISTS ??', [table]);
        await new Promise((resolve, reject) => admin.end(error => error ? reject(error) : resolve()));
    });
    async function configure(action) {
        const previous = { MYSQL_CONNECTION_URL: process.env.MYSQL_CONNECTION_URL, MYSQL_TABLE: process.env.MYSQL_TABLE };
        try {
            process.env.MYSQL_CONNECTION_URL = url;
            process.env.MYSQL_TABLE = table;
            return await action();
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key]; else process.env[key] = value;
            }
        }
    }
    async function plugin(concurrency = 1) {
        const instance = new MySQLAuthenticationPlugin();
        await configure(() => instance.init(capture().logger, { concurrency }));
        t.after(() => instance.close());
        return instance;
    }
    async function proxy(extra = {}) {
        const auth = new MySQLAuthenticationPlugin();
        const f = await configure(() => fixture(t, { auth, authenticationConcurrency: 1, ...extra }));
        return { ...f, auth };
    }
    async function blockedQuery() {
        for (let n = 0; n < 100; n++) {
            const rows = await sql('SHOW FULL PROCESSLIST');
            if (rows.some(row => row.Info?.includes(`SELECT 1 FROM \`${table}\``))) return;
            await delay(10);
        }
        assert.fail('Expected the actual authentication SELECT to reach the locked table');
    }
    return { sql, table, plugin, proxy, blockedQuery };
}

test('isolated MySQL: indexed existence lookup accepts and rejects keys', options, async t => {
    const db = await database(t);
    const plugin = await db.plugin();
    assert.equal(await plugin.validateKey(token), true);
    assert.equal(await plugin.validateKey('unregistered-fake-token'), false);
    assert.equal(plugin.pool._connectionQueue.length, 0);
});

test('isolated MySQL: occupied pool fails promptly instead of retaining a hidden queue', options, async t => {
    const db = await database(t);
    const plugin = await db.plugin();
    const reserved = await new Promise((resolve, reject) => plugin.pool.getConnection((err, c) => err ? reject(err) : resolve(c)));
    try {
        const start = performance.now();
        await assert.rejects(plugin.validateKey(token), error => error.code === 'POOL_CONNLIMIT');
        assert.ok(performance.now() - start < 1000);
        assert.equal(plugin.pool._connectionQueue.length, 0);
    } finally { reserved.release(); }
    assert.equal(await plugin.validateKey(token), true);
});

test('isolated MySQL: abort during actual connection acquisition prevents SQL', options, async t => {
    const db = await database(t);
    const plugin = await db.plugin();
    const abort = new AbortController();
    let queries = 0;
    plugin.pool.on('connection', connection => {
        const original = connection.query;
        connection.query = function (...args) { queries++; return original.apply(this, args); };
    });
    const abandon = () => abort.abort();
    plugin.pool.on('acquire', abandon);
    await assert.rejects(plugin.validateKey(token, { signal: abort.signal, remainingMs: () => 1000 }),
        error => error.code === 'AUTH_TIMEOUT');
    assert.equal(queries, 0);
    assert.equal(plugin.pool._freeConnections.length, 1);
    plugin.pool.off('acquire', abandon);
    assert.equal(await plugin.validateKey(token), true);
    assert.equal(queries, 1);
});

test('isolated MySQL: disconnected running SQL retains its slot and abandoned waiter never runs', options, async t => {
    const db = await database(t);
    const f = await db.proxy({ authenticationTimeoutMs: 2000 });
    await db.sql('LOCK TABLES ?? WRITE', [db.table]);
    const running = await f.connect();
    await db.blockedQuery();
    const queued = await f.connect({ key: 'second-fake-token' });
    assert.equal(f.stats().gauges.authQueued, 1);
    running.ws.close();
    queued.ws.close();
    await Promise.all([running.closed, queued.closed]);
    await until(() => f.stats().gauges.authQueued === 0);
    assert.equal(f.stats().gauges.authActive, 1);
    assert.equal(f.stats().counters.authentication_started, 1);
    await db.sql('UNLOCK TABLES');
    await until(() => f.stats().gauges.authActive === 0);
    assert.equal(f.stats().counters.authentication_valid, 1);
    assert.equal(f.stats().counters.sessions_accepted, 0);
    const next = await f.connect();
    await next.accepted();
    assert.equal(f.stats().counters.authentication_started, 2);
});

test('isolated MySQL: real query inactivity timeout releases the slot and recovery succeeds', options, async t => {
    const db = await database(t);
    const f = await db.proxy({ authenticationTimeoutMs: 200 });
    await db.sql('LOCK TABLES ?? WRITE', [db.table]);
    const start = performance.now();
    const running = await f.connect();
    await db.blockedQuery();
    assert.equal((await running.closed).code, 1011);
    await until(() => f.stats().gauges.authActive === 0);
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 150 && elapsed < 1500, String(elapsed));
    assert.equal(f.auth.pool._connectionQueue.length, 0);
    assert.equal(f.stats().counters.authentication_failed, 1);
    await db.sql('UNLOCK TABLES');
    const recovered = await f.connect();
    await recovered.accepted();
    assert.equal(f.stats().gauges.sessions, 1);
});

test('isolated MySQL: backend errors are sanitized and established forwarding survives', options, async t => {
    const db = await database(t);
    const f = await db.proxy();
    const owner = await f.connect();
    await owner.accepted();
    f.auth.table = 'otf_test_missing_table';
    const rejected = await f.connect({ key: 'second-fake-token' });
    assert.deepEqual(await rejected.closed, { code: 1011, reason: 'authentication unavailable' });
    const incoming = receive(owner.ws);
    const request = f.request();
    reply(owner.ws, id(await incoming), 'HEALTHY');
    assert.equal((await request.response).body.toString(), 'HEALTHY');
    assert.equal(f.logs.text().includes(token), false);
    assert.equal(f.logs.text().includes('SELECT 1'), false);
    assert.equal(f.logs.text().includes('sqlMessage'), false);
});
