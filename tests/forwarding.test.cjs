const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, receive, reply, id, until, delay } = require('./helpers.cjs');
const { RequestIds } = require(process.env.OTF_TEST_BUNDLE);

test('sequential GET and POST preserve path, body and byte-exact responses', async t => {
    const f = await fixture(t);
    const controller = await f.connect();
    await controller.accepted();
    const body = Buffer.from([0x00, 0xff, 0xc3, 0xa9]);
    for (const [method, payload] of [['GET', undefined], ['POST', undefined], ['POST', 'fake-device-password']]) {
        const incoming = receive(controller.ws);
        const pending = f.request('/s2id_gen?test=1', { method, body: payload });
        const frame = await incoming;
        assert.match(frame, new RegExp(`${method} /s2id_gen\\?test=1 HTTP/1\\.1`));
        assert.equal(frame.split('\r\n\r\n')[1], payload || '');
        reply(controller.ws, id(frame), body);
        const response = await pending.response;
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, body);
    }
    await until(() => f.logs.records().filter(r => r.msg === 'controller response forwarded').length === 3);
    assert.equal(f.logs.records().filter(r => r.msg === 'request aborted').length, 0);
});

test('concurrent requests use distinct IDs and route out-of-order replies correctly', async t => {
    const f = await fixture(t);
    const controller = await f.connect();
    await controller.accepted();
    const seen = new Set();
    const frames = [];
    controller.ws.on('message', data => {
        const frame = data.toString();
        const requestId = id(frame);
        assert.equal(seen.has(requestId), false);
        seen.add(requestId);
        frames.push(frame);
        if (frames.length === 40) for (const frame of frames.reverse()) {
            reply(controller.ws, id(frame), /GET \/jc\?n=(\d+)/.exec(frame)[1]);
        }
    });
    const pending = Array.from({ length: 40 }, (_, n) => f.request(`/jc?n=${n}`));
    const results = await Promise.all(pending.map(p => p.response));
    results.forEach((res, n) => assert.equal(res.body.toString(), String(n)));
    assert.equal(seen.size, 40);
});

test('large valid fragmented responses survive with no second response on duplicates', async t => {
    const f = await fixture(t, { requestTimeoutMs: 1000 });
    const controller = await f.connect();
    await controller.accepted();
    const incoming = receive(controller.ws);
    const pending = f.request('/jl');
    const requestId = id(await incoming);
    const body = 'x'.repeat(256 * 1024);
    const response = `RES: ${requestId}\r\nHTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    controller.ws.send(response.slice(0, 3), { fin: false });
    controller.ws.send(response.slice(3, 1000), { fin: false });
    controller.ws.send(response.slice(1000), { fin: true });
    assert.equal((await pending.response).body.toString(), body);
    reply(controller.ws, requestId, 'duplicate');
    await delay(10);
    assert.equal(f.logs.records().filter(r => r.event === 'request_settled').length, 1);
});

test('abandoned browser requests remove entries and listeners; late replies are ignored', async t => {
    let response;
    let ownedFinish;
    const f = await fixture(t, { wrapForward: forward => (req, res) => {
        response = res;
        const existing = new Set(res.listeners('finish'));
        forward(req, res);
        ownedFinish = res.listeners('finish').filter(listener => !existing.has(listener));
    } });
    const controller = await f.connect();
    await controller.accepted();
    const incoming = receive(controller.ws);
    const pending = f.request();
    const requestId = id(await incoming);
    pending.request.destroy();
    await assert.rejects(pending.response);
    await until(() => f.logs.records().some(r => r.reason === 'browser_departed'));
    assert.ok(ownedFinish.length > 0);
    for (const listener of ownedFinish) assert.equal(response.listeners('finish').includes(listener), false);
    reply(controller.ws, requestId);
    await delay(10);
    assert.equal(f.logs.records().filter(r => r.event === 'request_settled').length, 1);
    const next = receive(controller.ws);
    const healthy = f.request();
    reply(controller.ws, id(await next));
    assert.equal((await healthy.response).status, 200);
});

test('timeout gives one 408, does not replay state-changing GET or POST, and skips expired IDs', async t => {
    const f = await fixture(t, { requestTimeoutMs: 35 });
    const controller = await f.connect();
    await controller.accepted();
    const seen = [];
    controller.ws.on('message', data => seen.push(data.toString()));
    for (const method of ['GET', 'POST']) {
        const incoming = receive(controller.ws);
        const pending = f.request('/cm?sid=1&en=1', { method, body: method === 'POST' ? 'fake-key' : undefined });
        const requestId = id(await incoming);
        const result = await pending.response;
        assert.equal(result.status, 408);
        assert.equal(JSON.parse(result.body).message, 'Controller did not respond.');
        reply(controller.ws, requestId, 'too late');
    }
    await delay(45);
    assert.equal(seen.length, 2);
    assert.notEqual(id(seen[0]), id(seen[1]));
    assert.equal(f.logs.records().filter(r => r.event === 'request_settled').length, 2);
});

test('a slow legitimate response within its deadline completes', async t => {
    const f = await fixture(t, { requestTimeoutMs: 200 });
    const controller = await f.connect();
    await controller.accepted();
    const incoming = receive(controller.ws);
    const pending = f.request('/jl');
    const requestId = id(await incoming);
    await delay(80);
    reply(controller.ws, requestId);
    assert.equal((await pending.response).status, 200);
    await delay(140);
    assert.equal(f.logs.records().filter(r => r.event === 'request_settled').length, 1);
});

test('failed sends, thrown sends and delayed send-error callbacks settle only their own request', async t => {
    const f = await fixture(t);
    const controller = await f.connect();
    await controller.accepted();
    const send = controller.socket.send;
    controller.socket.send = (_data, callback) => callback(new Error('send failure'));
    assert.equal((await f.request().response).status, 408);
    controller.socket.send = () => { throw new Error('send failure'); };
    assert.equal((await f.request().response).status, 408);
    let late;
    controller.socket.send = function (data, callback) {
        late = callback;
        return send.call(this, data, () => {});
    };
    const incoming = receive(controller.ws);
    const pending = f.request();
    reply(controller.ws, id(await incoming));
    assert.equal((await pending.response).status, 200);
    late(new Error('late error'));
    assert.equal(f.logs.records().filter(r => r.event === 'request_settled').length, 3);
});

test('a response with a missing socket is settled without throwing', async t => {
    let response;
    const f = await fixture(t, { wrapForward: forward => (req, res) => { response = res; forward(req, res); } });
    const controller = await f.connect();
    await controller.accepted();
    const incoming = receive(controller.ws);
    const pending = f.request();
    const requestId = id(await incoming);
    response.socket = null;
    reply(controller.ws, requestId);
    await until(() => f.logs.records().some(r => r.reason === 'controller_response'));
    pending.request.destroy();
    await assert.rejects(pending.response);
    assert.equal(f.logs.records().filter(r => r.event === 'request_settled').length, 1);
});

test('partially sent HTTP responses are destroyed instead of receiving another response', async t => {
    let response;
    const f = await fixture(t, { wrapForward: forward => (req, res) => { response = res; forward(req, res); } });
    const controller = await f.connect();
    await controller.accepted();
    const incoming = receive(controller.ws);
    const pending = f.request();
    const requestId = id(await incoming);
    response.write('partial');
    reply(controller.ws, requestId);
    await assert.rejects(pending.response);
    assert.equal(f.logs.records().filter(r => r.event === 'request_settled').length, 1);
});

test('malformed continuation frames fail pending GET and POST exactly once and permit reconnect', async t => {
    const f = await fixture(t);
    for (const method of ['GET', 'POST']) {
        const controller = await f.connect();
        await controller.accepted();
        const incoming = receive(controller.ws);
        const pending = f.request('/jc', { method, body: method === 'POST' ? 'fake-key' : undefined });
        await incoming;
        controller.ws._socket.write(Buffer.from([0x80, 0x81, 0, 0, 0, 0, 0x58]));
        const result = await pending.response;
        assert.equal(result.status, 408);
        assert.equal(JSON.parse(result.body).message, 'Controller dropped packet.');
        await controller.closed;
    }
    assert.equal(f.logs.records().filter(r => r.event === 'request_settled').length, 2);
    assert.equal(f.logs.records().filter(r => r.event === 'session_cleanup').length, 2);
});

test('malformed, binary and invalid UTF-8 headers do not consume pending requests or log payload', async t => {
    const f = await fixture(t);
    const controller = await f.connect();
    await controller.accepted();
    const incoming = receive(controller.ws);
    const pending = f.request();
    const requestId = id(await incoming);
    controller.ws.send('fake-payload-secret');
    controller.ws.send('RES: xxxx\r\nfake-payload-secret');
    controller.ws.send(Buffer.from([0xff, 0x0a, 0x61]), { binary: false });
    controller.ws.send(Buffer.from('fake-payload-secret'));
    reply(controller.ws, requestId);
    assert.equal((await pending.response).status, 200);
    assert.equal(f.logs.text().includes('fake-payload-secret'), false);
});

test('redirect and HTTP error logging omit URLs, credentials, payloads and response headers', async t => {
    const f = await fixture(t);
    const redirect = await f.request('?pw=fake-query-secret', { headers: {
        authorization: 'fake-auth-secret', cookie: 'fake-cookie-secret',
    } }).response;
    assert.equal(redirect.status, 301);
    assert.match(redirect.headers.location, /pw=fake-query-secret/);
    const tooLarge = await f.request('/jc?pw=fake-query-secret', { method: 'POST',
        body: 'fake-body-secret'.repeat(100000) }).response;
    assert.equal(tooLarge.status, 413);
    const malformedPath = await f.request('/jc', { key: 'fake-%FF-secret' }).response;
    assert.equal(malformedPath.status, 400);
    for (const secret of ['fake-query-secret', 'fake-auth-secret', 'fake-cookie-secret',
        'fake-body-secret', 'fake-%FF-secret', 'local-only-fake-token']) {
        assert.equal(f.logs.text().includes(secret), false, secret);
    }
});

test('HTTP completion and lifecycle logs identify /jc and /cm without query strings', async t => {
    const f = await fixture(t);
    const controller = await f.connect();
    await controller.accepted();
    for (const endpoint of ['/jc', '/cm', '/fake-path-secret']) {
        const incoming = receive(controller.ws);
        const pending = f.request(`${endpoint}?pw=fake-query-secret`);
        reply(controller.ws, id(await incoming));
        assert.equal((await pending.response).status, 200);
    }
    await until(() => f.logs.records().filter(r => r.msg === 'controller response forwarded').length === 3);
    const httpEndpoints = f.logs.records().filter(r => r.msg === 'controller response forwarded').map(r => r.req.endpoint);
    const lifecycleEndpoints = f.logs.records().filter(r => r.event === 'request_settled').map(r => r.endpoint);
    assert.deepEqual(httpEndpoints, ['/jc', '/cm', '/other']);
    assert.deepEqual(lifecycleEndpoints, httpEndpoints);
    assert.equal(f.logs.text().includes('fake-query-secret'), false);
    assert.equal(f.logs.text().includes('fake-path-secret'), false);
});

test('HTTP diagnostics preserve raw controller status codes without exposing response headers', async t => {
    const f = await fixture(t);
    const controller = await f.connect();
    await controller.accepted();
    for (const status of [200, 404, 503]) {
        const incoming = receive(controller.ws);
        const pending = f.request();
        const requestId = id(await incoming);
        controller.ws.send(`RES: ${requestId}\r\nHTTP/1.1 ${status} Test\r\nContent-Length: 2\r\nX-Secret: fake-response-secret\r\n\r\nOK`);
        const response = await pending.response;
        assert.equal(response.status, status);
        assert.equal(response.body.toString(), 'OK');
    }
    await until(() => f.logs.records().filter(r => r.res).length === 3);
    assert.deepEqual(f.logs.records().filter(r => r.res).map(r => r.res.statusCode), [200, 404, 503]);
    assert.equal(f.logs.text().includes('fake-response-secret'), false);
});

test('full ID capacity returns a non-5xx response without forwarding', async t => {
    const f = await fixture(t);
    const controller = await f.connect();
    await controller.accepted();
    t.mock.method(RequestIds.prototype, 'allocate', () => undefined);
    let forwarded = 0;
    controller.ws.on('message', () => forwarded++);
    assert.equal((await f.request().response).status, 429);
    assert.equal(forwarded, 0);
});

test('reply/disconnect and timeout/disconnect races produce one terminal result', async t => {
    const f = await fixture(t, { requestTimeoutMs: 40 });
    for (const order of ['reply-first', 'disconnect-first', 'timeout-first']) {
        const controller = await f.connect();
        await controller.accepted();
        const incoming = receive(controller.ws);
        const pending = f.request();
        const requestId = id(await incoming);
        const countBefore = f.logs.records().filter(r => r.event === 'request_settled').length;
        if (order === 'reply-first') {
            reply(controller.ws, requestId);
            controller.ws.close();
        } else if (order === 'disconnect-first') {
            controller.ws.close();
            reply(controller.ws, requestId);
        } else {
            assert.equal((await pending.response).status, 408);
            controller.ws.terminate();
        }
        const result = await pending.response;
        assert.ok([200, 408].includes(result.status));
        await controller.closed;
        await delay(50);
        assert.equal(f.logs.records().filter(r => r.event === 'request_settled').length, countBefore + 1);
    }
});

test('the real 60-second default permits a legitimate response after 30 seconds', { timeout: 45000 }, async t => {
    const previous = process.env.REQUEST_TIMEOUT_MS;
    delete process.env.REQUEST_TIMEOUT_MS;
    t.after(() => {
        if (previous === undefined) delete process.env.REQUEST_TIMEOUT_MS;
        else process.env.REQUEST_TIMEOUT_MS = previous;
    });
    const f = await fixture(t, { requestTimeoutMs: undefined });
    const controller = await f.connect();
    await controller.accepted();
    const incoming = receive(controller.ws);
    const pending = f.request('/jl');
    const requestId = id(await incoming);
    await delay(31000);
    reply(controller.ws, requestId, 'slow response');
    assert.equal((await pending.response).body.toString(), 'slow response');
    const terminal = f.logs.records().find(r => r.event === 'request_settled');
    assert.ok(terminal.durationMs >= 30000);
    assert.equal(terminal.reason, 'controller_response');
});
