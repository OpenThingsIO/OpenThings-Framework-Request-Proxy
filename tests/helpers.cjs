const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const WebSocket = require('ws');
const pino = require('pino');
const { randomUUID } = require('node:crypto');
const { setupWebsockets, createHttpApp } = require(process.env.OTF_TEST_BUNDLE);

const token = 'local-only-fake-token';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
    for (let n = 0; n < 300; n++) {
        if (check()) return;
        await delay(5);
    }
    assert.fail('Condition did not become true');
}
function capture() {
    let output = '';
    return { logger: pino({ level: 'trace' }, { write: value => { output += value; } }),
        text: () => output,
        records: () => output.trim() ? output.trim().split('\n').map(line => JSON.parse(line)) : [] };
}
async function fixture(t, options = {}) {
    const logs = capture();
    const auth = options.auth || { init: async () => {}, validateKey: async key => key === token };
    const proxy = await setupWebsockets(auth, logs.logger, {
        host: '127.0.0.1', port: 0, requestTimeoutMs: 1000,
        heartbeatIntervalMs: 10_000, rejectionTimeoutMs: 60, ...options,
    });
    const forward = options.wrapForward ? options.wrapForward(proxy.forwardRequestV1) : proxy.forwardRequestV1;
    const server = createHttpApp(forward, logs.logger).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const clients = new Set();
    const connecting = new Map();
    proxy.server.on('connection', (socket, req) => {
        const tag = req.headers['x-otf-test-connection'];
        const resolve = connecting.get(tag);
        if (resolve) { connecting.delete(tag); resolve(socket); }
    });
    t.after(async () => {
        for (const client of clients) client.terminate();
        server.closeAllConnections();
        const stopped = new Promise(resolve => server.close(resolve));
        await proxy.close();
        await stopped;
    });
    async function connect({ key = token, path = '/socket/v1', query, ...wsOptions } = {}) {
        const acceptedBefore = logs.records().filter(r => r.event === 'session_accepted').length;
        const tag = randomUUID();
        const serverConnection = new Promise(resolve => connecting.set(tag, resolve));
        const ws = new WebSocket(`ws://127.0.0.1:${proxy.server.address().port}${path}${query ?? `?deviceKey=${key}`}`,
            { ...wsOptions, headers: { ...wsOptions.headers, 'x-otf-test-connection': tag } });
        clients.add(ws);
        ws.on('error', () => {});
        const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
        await once(ws, 'open');
        const socket = await serverConnection;
        return { ws, socket, closed, accepted: () => until(() =>
            logs.records().filter(r => r.event === 'session_accepted').length > acceptedBefore) };
    }
    function request(path = '/jc', { method = 'GET', body, headers = {}, key = token } = {}) {
        let request;
        const response = new Promise((resolve, reject) => {
            request = http.request({ host: '127.0.0.1', port: server.address().port,
                path: `/forward/v1/${key}${path}`, method, agent: false,
                headers: { ...headers, ...(body !== undefined ? {
                    'content-length': Buffer.byteLength(body), 'content-type': 'text/plain' } : {}) } }, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('error', reject);
                res.on('aborted', () => reject(new Error('Response aborted')));
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
            });
            request.on('error', reject);
            request.end(body);
        });
        response.catch(() => {});
        return { request, response };
    }
    return { ...proxy, logs, connect, request, httpServer: server };
}
async function receive(ws) { return (await once(ws, 'message'))[0].toString(); }
function id(frame) { return /^FWD: ([0-9a-f]{4})\r\n/.exec(frame)[1]; }
function reply(ws, requestId, body = 'OK') {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    ws.send(Buffer.concat([Buffer.from(`RES: ${requestId}\r\nHTTP/1.1 200 OK\r\nContent-Length: ${bytes.length}\r\n\r\n`), bytes]), { binary: false });
}
module.exports = { fixture, receive, id, reply, delay, until, capture, token };
