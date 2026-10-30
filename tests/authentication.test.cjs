const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AuthenticationQueue, Telemetry, setupWebsockets } = require(process.env.OTF_TEST_BUNDLE);
const { fixture, capture, until, delay, receive, reply, id } = require('./helpers.cjs');

test('auth limits are validated before initializing a backend', async () => {
    for (const [option, setting, values] of [
        ['authenticationConcurrency', 'AUTH_CONCURRENCY', [0, -1, 1.1, 101, 'secret-invalid']],
        ['authenticationQueueLimit', 'AUTH_QUEUE_LIMIT', [0, -1, 1.1, 10001, 'secret-invalid']],
    ]) {
        for (const value of values) {
            let initialized = false;
            await assert.rejects(setupWebsockets({ init: async () => { initialized = true; } },
                capture().logger, { port: 0, [option]: value }), error => {
                assert.equal(error.message, `${setting} is invalid`);
                return true;
            });
            assert.equal(initialized, false);
        }
    }
});

test('60 disconnected clients leave at most 10 running lookups and no waiting work', async t => {
    const complete = [];
    const f = await fixture(t, { auth: { init: async () => {},
        validateKey: () => new Promise(resolve => complete.push(resolve)) } });
    const clients = await Promise.all(Array.from({ length: 60 }, (_, n) => f.connect({ key: `fake-${n}` })));
    assert.equal(complete.length, 10);
    assert.equal(f.stats().gauges.authActive, 10);
    assert.equal(f.stats().gauges.authQueued, 50);
    for (const client of clients) client.ws.close();
    await Promise.all(clients.map(client => client.closed));
    await until(() => f.stats().gauges.authQueued === 0 && f.stats().gauges.connections === 0);
    assert.equal(f.stats().gauges.authActive, 10);
    assert.equal(complete.length, 10);
    for (const finish of complete) finish(true);
    await until(() => f.stats().gauges.authActive === 0);
    assert.equal(f.stats().counters.sessions_accepted, 0);
    assert.equal(f.stats().counters.authentication_cancelled, 60);
});

test('queue-full and same-key contention reject promptly without extra backend calls', async t => {
    const calls = [];
    const f = await fixture(t, { authenticationConcurrency: 1, authenticationQueueLimit: 1,
        auth: { init: async () => {}, validateKey: key => { calls.push(key); return new Promise(() => {}); } } });
    const running = await f.connect({ key: 'running' });
    const queued = await f.connect({ key: 'queued' });
    const duplicate = await f.connect({ key: 'running' });
    const full = await f.connect({ key: 'excess' });
    for (const client of [duplicate, full]) {
        assert.deepEqual(await client.closed, { code: 1011, reason: 'authentication busy' });
    }
    assert.deepEqual(calls, ['running']);
    assert.equal(f.stats().gauges.authActive, 1);
    assert.equal(f.stats().gauges.authQueued, 1);
    assert.equal(f.stats().counters.authentication_busy, 2);
    assert.equal(f.stats().gauges.sessions, 0);
    running.ws.close();
    queued.ws.close();
});

test('expired waiters never enter the plugin and running slots survive socket deadlines', async t => {
    let finish;
    const calls = [];
    const f = await fixture(t, { authenticationConcurrency: 1, authenticationTimeoutMs: 70,
        auth: { init: async () => {}, validateKey: key => {
            calls.push(key); return new Promise(resolve => { finish = resolve; });
        } } });
    const running = await f.connect({ key: 'running' });
    const queued = await f.connect({ key: 'queued' });
    assert.equal((await running.closed).reason, 'authentication timed out');
    assert.equal((await queued.closed).reason, 'authentication timed out');
    assert.deepEqual(calls, ['running']);
    assert.equal(f.stats().gauges.authActive, 1);
    assert.equal(f.stats().gauges.authQueued, 0);
    finish(true);
    await until(() => f.stats().gauges.authActive === 0);
    assert.equal(f.stats().counters.sessions_accepted, 0);
});

test('backend outage and busy queue do not prevent an established owner forwarding', async t => {
    let lookups = 0;
    const f = await fixture(t, { authenticationConcurrency: 1, authenticationQueueLimit: 1,
        auth: { init: async () => {}, validateKey: async () => {
            if (++lookups === 1) return true;
            return new Promise(() => {});
        } } });
    const owner = await f.connect();
    await owner.accepted();
    await f.connect({ key: 'hung-backend' });
    await f.connect({ key: 'queued' });
    const overflow = await f.connect({ key: 'overflow' });
    assert.equal((await overflow.closed).reason, 'authentication busy');
    const duplicate = await f.connect();
    assert.equal((await duplicate.closed).reason, 'device key already connected');
    assert.equal(lookups, 2);
    const incoming = receive(owner.ws);
    const pending = f.request();
    reply(owner.ws, id(await incoming), 'STILL HEALTHY');
    assert.equal((await pending.response).body.toString(), 'STILL HEALTHY');
});

test('queue wait consumes the same deadline and FIFO jobs get only remaining time', async t => {
    let finish;
    let remaining;
    const f = await fixture(t, { authenticationConcurrency: 1, authenticationTimeoutMs: 300,
        auth: { init: async () => {}, validateKey: (key, context) => {
            if (key === 'first') return new Promise(resolve => { finish = resolve; });
            remaining = context.remainingMs();
            assert.equal(context.signal.aborted, false);
            return Promise.resolve(true);
        } } });
    const first = await f.connect({ key: 'first' });
    const second = await f.connect({ key: 'second' });
    await delay(60);
    finish(true);
    await first.accepted();
    await second.accepted();
    assert.ok(remaining > 0 && remaining <= 250, String(remaining));
    assert.equal(f.stats().latency.queueWait.count, 2);
});

test('a delayed timer cannot let an expired queue entry start SQL', async () => {
    const logs = capture();
    const telemetry = new Telemetry(logs.logger);
    let finish;
    const calls = [];
    const queue = new AuthenticationQueue({ validateKey: key => {
        calls.push(key); return new Promise(resolve => { finish = resolve; });
    } }, telemetry, 1, 2, 25);
    try {
        const first = queue.submit('first', new AbortController().signal);
        await until(() => finish);
        const second = queue.submit('second', new AbortController().signal);
        const end = performance.now() + 40;
        while (performance.now() < end) { /* delay timers deliberately */ }
        finish(true);
        assert.equal((await first).status, 'timed_out');
        assert.equal((await second).status, 'timed_out');
        assert.deepEqual(calls, ['first']);
        await until(() => telemetry.snapshot().gauges.authActive === 0);
    } finally { queue.close(); telemetry.close(); }
});
