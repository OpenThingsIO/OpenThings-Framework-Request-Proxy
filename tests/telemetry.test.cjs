const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Telemetry, EventLimiter } = require(process.env.OTF_TEST_BUNDLE);
const { fixture, capture, token, until, delay, receive, reply, id } = require('./helpers.cjs');

test('aggregate counters and fixed histograms survive suppression and report interval deltas', () => {
    const logs = capture();
    const telemetry = new Telemetry(logs.logger);
    try {
        for (let n = 0; n < 10_000; n++) {
            telemetry.rejected('invalid device key');
            telemetry.observe('lookup', n);
        }
        telemetry.adjust('authQueued', 5);
        telemetry.adjust('authQueued', -5);
        telemetry.report();
        telemetry.report();
        const [first, second] = logs.records();
        assert.equal(first.delta.connection_rejected, 10_000);
        assert.equal(first.rejections['invalid device key'], 10_000);
        assert.equal(second.delta.connection_rejected, 0);
        assert.equal(second.counters.connection_rejected, 10_000);
        assert.equal(first.highWater.authQueued, 5);
        assert.equal(first.gauges.authQueued, 0);
        assert.equal(first.latency.lookup.buckets.length, 11);
        assert.equal(first.latency.lookup.buckets.reduce((a, b) => a + b), 10_000);
        assert.equal(typeof first.memory.external, 'number');
        assert.equal(typeof first.eventLoop.p99Ms, 'number');
        const snapshot = telemetry.snapshot();
        snapshot.counters.connection_rejected = -1;
        snapshot.latency.lookup.buckets.fill(-1);
        assert.equal(telemetry.snapshot().counters.connection_rejected, 10_000);
        assert.ok(telemetry.snapshot().latency.lookup.buckets.every(n => n >= 0));
        assert.equal(logs.text().includes(token), false);
    } finally { telemetry.close(); }
});

test('admission log bursts cannot consume the protocol or request warning budgets', () => {
    const logs = capture();
    const limiter = new EventLimiter();
    for (let n = 0; n < 1000; n++) limiter.log(logs.logger, 'info', 'connection_rejected', String(n));
    limiter.log(logs.logger, 'warn', 'request_timeout', 'one');
    limiter.log(logs.logger, 'warn', 'invalid_response_frame', 'one');
    assert.equal(logs.records().length, 102);
    assert.equal(logs.records().at(-2).event, 'request_timeout');
    assert.equal(logs.records().at(-1).event, 'invalid_response_frame');
    assert.ok(limiter.entries.size <= 256);
});

test('socket/session/pending gauges settle once and duplicate counters include suppressed events', async t => {
    const f = await fixture(t);
    const controller = await f.connect();
    await controller.accepted();
    for (let n = 0; n < 20; n++) {
        const duplicate = await f.connect();
        assert.equal((await duplicate.closed).code, 1008);
    }
    await until(() => f.stats().gauges.connections === 1);
    assert.equal(f.stats().counters.duplicate_rejected, 20);
    assert.equal(f.stats().rejections['device key already connected'], 20);
    assert.equal(f.logs.records().filter(r => r.event === 'connection_rejected').length, 1);
    const incoming = receive(controller.ws);
    const pending = f.request();
    const requestId = id(await incoming);
    assert.equal(f.stats().gauges.pendingRequests, 1);
    reply(controller.ws, requestId);
    assert.equal((await pending.response).status, 200);
    assert.equal(f.stats().gauges.pendingRequests, 0);
    const lateClose = controller.socket.listeners('close')[0];
    controller.ws.close();
    await controller.closed;
    await until(() => f.stats().gauges.connections === 0);
    lateClose(1006);
    assert.deepEqual(f.stats().gauges, { connections: 0, unaccepted: 0, closing: 0, sessions: 0,
        authActive: 0, authQueued: 0, pendingRequests: 0 });
    assert.equal(f.stats().counters.session_cleanups, 1);
    assert.equal(f.stats().counters.requests_settled, 1);
});

test('disconnected authentication remains counted until actual backend completion', async t => {
    let finish;
    const f = await fixture(t, { auth: { init: async () => {},
        validateKey: () => new Promise(resolve => { finish = resolve; }) } });
    const client = await f.connect();
    await until(() => finish);
    client.ws.close();
    await client.closed;
    await until(() => f.stats().gauges.connections === 0);
    assert.equal(f.stats().gauges.authActive, 1);
    finish(true);
    await until(() => f.stats().gauges.authActive === 0);
    assert.equal(f.stats().counters.sessions_accepted, 0);
});

test('periodic reports stop when the proxy closes', async t => {
    const f = await fixture(t, { statsIntervalMs: 10 });
    await until(() => f.logs.records().some(r => r.event === 'proxy_stats'));
    // The fixture closes again during teardown; close() must be idempotent.
    await f.close();
    const before = f.logs.records().filter(r => r.event === 'proxy_stats').length;
    await delay(40);
    assert.equal(f.logs.records().filter(r => r.event === 'proxy_stats').length, before);
});
