const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { fixture, receive, reply, id, until, delay, token } = require('./helpers.cjs');

test('simultaneous delayed authentication accepts only one owner and gates protocol handlers', async t => {
    const validations = [];
    const f = await fixture(t, { auth: { init: async () => {},
        validateKey: () => new Promise(resolve => validations.push(resolve)) } });
    const first = await f.connect();
    const second = await f.connect();
    assert.equal(first.socket.listenerCount('message'), 0);
    assert.equal(second.socket.listenerCount('message'), 0);
    validations[1](true);
    await second.accepted();
    const incoming = receive(second.ws);
    const pending = f.request();
    const requestId = id(await incoming);
    // The authenticated-but-not-yet-accepted connection cannot answer for its owner.
    reply(first.ws, requestId, 'FORGED');
    await delay(10);
    assert.equal(f.logs.records().filter(r => r.event === 'request_settled').length, 0);
    validations[0](true);
    assert.equal((await first.closed).code, 1008);
    reply(second.ws, requestId, 'OWNER');
    assert.equal((await pending.response).body.toString(), 'OWNER');
    assert.equal(f.logs.records().filter(r => r.event === 'session_accepted').length, 1);
});

test('disconnect while authenticating cannot later register or install timers', async t => {
    let complete;
    const f = await fixture(t, { auth: { init: async () => {}, validateKey: () =>
        new Promise(resolve => { complete = resolve; }) } });
    const controller = await f.connect();
    controller.ws.close();
    await controller.closed;
    complete(true);
    await delay(10);
    assert.equal(controller.socket.listenerCount('message'), 0);
    assert.equal(f.logs.records().filter(r => r.event === 'session_accepted').length, 0);
    assert.equal((await f.request().response).status, 404);
});

test('malformed frames during delayed authentication are observed safely and cannot register', async t => {
    let complete;
    const f = await fixture(t, { auth: { init: async () => {}, validateKey: () =>
        new Promise(resolve => { complete = resolve; }) } });
    const controller = await f.connect();
    controller.ws._socket.write(Buffer.from([0x80, 0x81, 0, 0, 0, 0, 0x58]));
    await controller.closed;
    complete(true);
    await delay(10);
    assert.equal(f.logs.records().filter(r => r.event === 'session_accepted').length, 0);
    assert.equal((await f.request().response).status, 404);
});

test('all rejection paths deliver distinct safe close reasons and retain no protocol handler', async t => {
    const f = await fixture(t, { auth: { init: async () => {}, validateKey: async key => {
        if (key === 'backend') throw Object.assign(new Error(`SQL secret ${token}`), { code: 'ER_PARSE_ERROR', sql: token });
        return key === token;
    } } });
    const owner = await f.connect();
    await owner.accepted();
    for (const [options, code, reason] of [
        [{ path: '/wrong' }, 1008, 'invalid path'],
        [{ query: '' }, 1008, 'missing device key'],
        [{ key: 'invalid' }, 1008, 'invalid device key'],
        [{ key: 'backend' }, 1011, 'authentication unavailable'],
        [{}, 1008, 'device key already connected'],
    ]) {
        const client = await f.connect(options);
        assert.deepEqual(await client.closed, { code, reason });
        assert.equal(client.socket.listenerCount('message'), 0);
    }
    assert.equal(owner.ws.readyState, WebSocket.OPEN);
    assert.equal(f.logs.text().includes(token), false);
    assert.equal(f.logs.text().includes('SQL secret'), false);
    assert.equal(f.logs.text().includes('"sql"'), false);
});

test('invalid authenticated duplicate cannot displace the owner', async t => {
    let valid = true;
    const f = await fixture(t, { auth: { init: async () => {}, validateKey: async () => valid } });
    const owner = await f.connect();
    await owner.accepted();
    valid = false;
    const duplicate = await f.connect();
    assert.equal((await duplicate.closed).reason, 'invalid device key');
    assert.equal(owner.ws.readyState, WebSocket.OPEN);
});

test('old close, error and heartbeat callbacks cannot affect replacement requests', async t => {
    const callbacks = [];
    const realInterval = global.setInterval;
    t.mock.method(global, 'setInterval', (callback, ms) => {
        callbacks.push(callback);
        return realInterval(callback, ms);
    });
    const f = await fixture(t);
    const old = await f.connect();
    await old.accepted();
    const lateClose = old.socket.listeners('close')[0];
    const lateError = old.socket.listeners('error')[0];
    const oldIncoming = receive(old.ws);
    const oldRequest = f.request();
    await oldIncoming;
    old.ws.terminate();
    assert.equal((await oldRequest.response).status, 408);
    await until(() => f.logs.records().some(r => r.event === 'session_cleanup'));
    const replacement = await f.connect();
    await replacement.accepted();
    const incoming = receive(replacement.ws);
    const pending = f.request();
    const requestId = id(await incoming);
    lateClose(1006);
    lateError(new Error('old transport error'));
    callbacks[0]();
    lateClose(1006);
    reply(replacement.ws, requestId, 'NEW');
    assert.equal((await pending.response).body.toString(), 'NEW');
    assert.equal(f.logs.records().filter(r => r.event === 'session_cleanup').length, 1);
});

test('a pending heartbeat pong does not permit a duplicate takeover', async t => {
    const f = await fixture(t, { heartbeatIntervalMs: 100 });
    const owner = await f.connect({ autoPong: false });
    await owner.accepted();
    const ping = new Promise(resolve => owner.ws.once('ping', resolve));
    await ping;
    const duplicate = await f.connect();
    assert.equal((await duplicate.closed).reason, 'device key already connected');
    owner.ws.pong();
    assert.equal(owner.ws.readyState, WebSocket.OPEN);
});

test('heartbeat expiry fails pending requests, then allows reconnect', async t => {
    const f = await fixture(t, { heartbeatIntervalMs: 60 });
    const owner = await f.connect({ autoPong: false });
    await owner.accepted();
    const incoming = receive(owner.ws);
    const pending = f.request();
    await incoming;
    const duplicate = await f.connect();
    assert.equal((await duplicate.closed).code, 1008);
    const result = await pending.response;
    assert.equal(result.status, 408);
    assert.equal(JSON.parse(result.body).message, 'Controller disconnected.');
    await owner.closed;
    assert.equal((await f.request().response).status, 404);
    const replacement = await f.connect();
    await replacement.accepted();
    const next = receive(replacement.ws);
    const request = f.request();
    reply(replacement.ws, id(await next));
    assert.equal((await request.response).status, 200);
    const event = f.logs.records().find(r => r.event === 'session_cleanup' && r.reason === 'heartbeat_expired');
    assert.equal(event.pendingRequests, 1);
    assert.equal(typeof event.lastPongAgeMs, 'number');
});

test('rejection fallback terminates a stalled close handshake and cancels on normal close', async t => {
    let complete;
    const f = await fixture(t, { rejectionTimeoutMs: 30,
        auth: { init: async () => {}, validateKey: () => new Promise(resolve => { complete = resolve; }) } });
    const normal = await f.connect({ key: 'invalid' });
    complete(false);
    assert.equal((await normal.closed).code, 1008);
    const slow = await f.connect({ key: 'invalid' });
    // Receive the real close frame but suppress the ws client's automatic reply.
    slow.ws._receiver.removeAllListeners('conclude');
    let frameCode;
    slow.ws._receiver.on('conclude', code => { frameCode = code; });
    complete(false);
    assert.equal((await slow.closed).code, 1006);
    assert.equal(frameCode, 1008);
    await delay(40);
    assert.equal(f.logs.records().filter(r => r.event === 'rejection_forced_close').length, 1);
    assert.equal(f.server.clients.size, 0);
});

for (const outcome of ['success', 'error']) {
    test(`authentication timeout closes with 1011; late ${outcome} cannot affect a replacement`, async t => {
        let complete;
        let fail;
        let calls = 0;
        const f = await fixture(t, { authenticationTimeoutMs: 30, auth: {
            init: async () => {}, validateKey: () => ++calls === 1
                ? new Promise((resolve, reject) => { complete = resolve; fail = reject; })
                : Promise.resolve(true),
        } });
        const old = await f.connect();
        assert.deepEqual(await old.closed, { code: 1011, reason: 'authentication timed out' });
        assert.equal(old.socket.listenerCount('message'), 0);
        assert.equal((await f.request().response).status, 404);
        const replacement = await f.connect();
        await replacement.accepted();
        if (outcome === 'success') complete(true);
        else fail(new Error('late backend secret'));
        const incoming = receive(replacement.ws);
        const pending = f.request();
        reply(replacement.ws, id(await incoming));
        assert.equal((await pending.response).status, 200);
        assert.equal(f.logs.records().filter(r => r.event === 'session_accepted').length, 1);
        assert.equal(f.logs.text().includes('late backend secret'), false);
    });
}

test('an authenticating duplicate timing out preserves its healthy owner and pending requests', async t => {
    let calls = 0;
    const f = await fixture(t, { authenticationTimeoutMs: 30, auth: {
        init: async () => {}, validateKey: () => ++calls === 1 ? Promise.resolve(true) : new Promise(() => {}),
    } });
    const owner = await f.connect();
    await owner.accepted();
    const incoming = receive(owner.ws);
    const pending = f.request();
    const requestId = id(await incoming);
    const duplicate = await f.connect();
    assert.equal((await duplicate.closed).code, 1011);
    reply(owner.ws, requestId);
    assert.equal((await pending.response).status, 200);
    assert.equal(owner.ws.readyState, WebSocket.OPEN);
});

test('authentication deadline timers are cancelled on acceptance and peer departure', async t => {
    let expired = 0;
    const originalTimeout = global.setTimeout;
    t.mock.method(global, 'setTimeout', (callback, ms, ...args) => originalTimeout(() => {
        if (ms === 30) expired++;
        callback(...args);
    }, ms));
    let hung = false;
    const f = await fixture(t, { authenticationTimeoutMs: 30, auth: {
        init: async () => {}, validateKey: () => hung ? new Promise(() => {}) : Promise.resolve(true),
    } });
    const owner = await f.connect();
    await owner.accepted();
    hung = true;
    const abandoned = await f.connect();
    abandoned.ws.close();
    await abandoned.closed;
    await delay(50);
    assert.equal(expired, 0);
    assert.equal(f.logs.records().filter(r => r.event === 'connection_rejected').length, 0);
    assert.equal(owner.ws.readyState, WebSocket.OPEN);
});
