const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const WebSocket = require('ws');

const token = 'local-only-fake-device-key';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function start(t) {
    const httpPort = await freePort();
    const wsPort = await freePort();
    const child = spawn(process.execPath, ['dist/index.cjs'], {
        env: { ...process.env, HOST: '127.0.0.1', HTTP_PORT: String(httpPort),
            WEBSOCKET_PORT: String(wsPort), DEVICE_KEYS: token, LOG_LEVEL: 'trace',
            AUTHENTICATION_PLUGIN: 'EnvironmentVariableAuthenticationPlugin' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', data => { logs += data; });
    child.stderr.on('data', data => { logs += data; });
    const exit = once(child, 'exit');
    t.after(async () => {
        if (child.exitCode === null) child.kill();
        await exit;
    });
    for (let i = 0; i < 200 && !logs.includes('now listening'); i++) {
        if (child.exitCode !== null) throw new Error(logs);
        await delay(10);
    }
    assert.match(logs, /now listening/);
    const url = `ws://127.0.0.1:${wsPort}/socket/v1?deviceKey=${token}`;
    const controller = new WebSocket(url);
    controller.on('error', () => {});
    t.after(() => controller.terminate());
    await once(controller, 'open');
    return { controller, url, child, logs: () => logs,
        base: `http://127.0.0.1:${httpPort}/forward/v1/${token}` };
}

test('running proxy forwards GET and body-parsed POST and keeps secrets out of logs', async t => {
    const proxy = await start(t);
    proxy.controller.on('message', data => {
        const frame = data.toString();
        const id = /^FWD: ([0-9a-f]{4})\r\n/.exec(frame)[1];
        proxy.controller.send(`RES: ${id}\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK`);
    });
    for (const method of ['GET', 'POST']) {
        const response = await fetch(`${proxy.base}/jc?pw=fake-password-secret`, {
            method, signal: AbortSignal.timeout(1500),
            ...(method === 'POST' ? { body: 'fake-device-password',
                headers: { 'content-type': 'text/plain' } } : {}),
        });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'OK');
    }
    await delay(20);
    assert.equal(proxy.logs().includes(token), false);
    assert.equal(proxy.logs().includes('fake-password-secret'), false);
    assert.equal(proxy.logs().includes('fake-device-password'), false);
});

test('running proxy rejects duplicates with a close frame and preserves its owner', async t => {
    const proxy = await start(t);
    const duplicate = new WebSocket(proxy.url);
    duplicate.on('error', () => {});
    t.after(() => duplicate.terminate());
    const closed = once(duplicate, 'close');
    const [code] = await closed;
    assert.equal(code, 1008);
    assert.equal(proxy.controller.readyState, WebSocket.OPEN);
    assert.equal(proxy.child.exitCode, null);
});
