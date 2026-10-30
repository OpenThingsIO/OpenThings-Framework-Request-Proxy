const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, receive, id, capture, until } = require('./helpers.cjs');
const { setupWebsockets, DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES } = require(process.env.OTF_TEST_BUNDLE);

test('incoming message cap defaults to 4 MiB and rejects invalid configuration without values', async t => {
    const f = await fixture(t);
    assert.equal(f.server.options.maxPayload, 4 * 1024 * 1024);
    assert.equal(DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES, f.server.options.maxPayload);
    for (const value of [0, -1, 0.5, Infinity, 16 * 1024 * 1024 + 1, 'secret-invalid-value']) {
        const logs = capture();
        await assert.rejects(setupWebsockets({ init: async () => {} }, logs.logger,
            { port: 0, maxPayloadBytes: value }), error => {
            assert.equal(error.message, 'WEBSOCKET_MAX_PAYLOAD_BYTES is invalid');
            assert.equal(JSON.stringify(error).includes('secret-invalid-value'), false);
            return true;
        });
    }
});

for (const size of [511, 512, 513]) {
    test(`message size ${size} against a 512-byte cap is checked across fragments`, async t => {
        const f = await fixture(t, { maxPayloadBytes: 512 });
        const controller = await f.connect();
        await controller.accepted();
        const incoming = receive(controller.ws);
        const pending = f.request();
        const requestId = id(await incoming);
        // Equal-width body lengths keep the complete envelope length predictable.
        const prefix = `RES: ${requestId}\r\nHTTP/1.1 200 OK\r\nContent-Length: 000\r\n\r\n`;
        const body = 'x'.repeat(size - Buffer.byteLength(prefix));
        const frame = Buffer.from(prefix.replace('000', String(body.length)) + body);
        assert.equal(frame.length, size);
        controller.ws.send(frame.subarray(0, 256), { binary: false, fin: false });
        controller.ws.send(frame.subarray(256), { binary: false, fin: true });
        const result = await pending.response;
        if (size <= 512) {
            assert.equal(result.status, 200);
            assert.equal(result.body.toString(), body);
            assert.equal(controller.ws.readyState, 1);
        } else {
            assert.equal((await controller.closed).code, 1009);
            assert.equal(result.status, 408);
        }
    });
}

test('oversized fragmented messages are rejected before delayed authentication completes', async t => {
    let complete;
    const f = await fixture(t, { maxPayloadBytes: 512, auth: {
        init: async () => {}, validateKey: () => new Promise(resolve => { complete = resolve; }),
    } });
    const controller = await f.connect();
    await until(() => complete);
    controller.ws.send('x'.repeat(300), { fin: false });
    controller.ws.send('x'.repeat(300), { fin: true });
    assert.equal((await controller.closed).code, 1009);
    complete(true);
    assert.equal((await f.request().response).status, 404);
    assert.equal(f.logs.records().some(r => r.event === 'session_accepted'), false);
});

for (const offset of [-1, 0, 1]) {
    test(`default 4 MiB message boundary ${offset >= 0 ? '+' : ''}${offset} works across fragments`, async t => {
        const f = await fixture(t, { requestTimeoutMs: 5000 });
        const controller = await f.connect();
        await controller.accepted();
        const incoming = receive(controller.ws);
        const pending = f.request();
        const requestId = id(await incoming);
        const size = DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES + offset;
        let prefix = `RES: ${requestId}\r\nHTTP/1.1 200 OK\r\nContent-Length: 0000000\r\n\r\n`;
        const bodyLength = size - Buffer.byteLength(prefix);
        prefix = prefix.replace('0000000', String(bodyLength));
        const frame = Buffer.alloc(size, 0x78);
        frame.write(prefix);
        const middle = Math.floor(size / 2);
        controller.ws.send(frame.subarray(0, middle), { binary: false, fin: false });
        controller.ws.send(frame.subarray(middle), { binary: false, fin: true });
        const response = await pending.response;
        if (offset <= 0) {
            assert.equal(response.status, 200);
            assert.equal(response.body.length, bodyLength);
            assert.ok(response.body.every(byte => byte === 0x78));
        } else {
            assert.equal((await controller.closed).code, 1009);
            assert.equal(response.status, 408);
        }
    });
}
