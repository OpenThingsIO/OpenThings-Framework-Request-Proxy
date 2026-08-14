import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import WebSocket from "ws";

function waitForOutput(child, pattern, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for ${pattern}: ${output}`));
        }, timeoutMs);

        const onData = (data) => {
            output += data.toString();
            if (pattern.test(output)) {
                clearTimeout(timeout);
                child.stdout.off("data", onData);
                resolve();
            }
        };

        child.stdout.on("data", onData);
        child.once("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`Proxy exited early with code ${code}: ${output}`));
        });
    });
}

test("forwards requests with and without bodies", async (t) => {
    const suffix = process.pid % 1000;
    const httpPort = 33000 + suffix;
    const websocketPort = 34000 + suffix;
    const deviceKey = "request-body-test";

    const proxy = spawn(process.execPath, ["dist/index.cjs"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            AUTHENTICATION_PLUGIN: "EnvironmentVariableAuthenticationPlugin",
            DEVICE_KEYS: deviceKey,
            HOST: "127.0.0.1",
            HTTP_PORT: String(httpPort),
            WEBSOCKET_PORT: String(websocketPort),
            LOG_LEVEL: "info",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => proxy.kill("SIGTERM"));

    await waitForOutput(proxy, /now listening/);

    const socket = new WebSocket(
        `ws://127.0.0.1:${websocketPort}/socket/v1?deviceKey=${deviceKey}`
    );
    await once(socket, "open");
    t.after(() => socket.close());

    const forwarded = [];
    socket.on("message", (data) => {
        const request = data.toString();
        forwarded.push(request);
        const match = request.match(/^FWD: ([0-9a-f]{4})\r\n/);
        assert.ok(match, `Invalid forwarded frame: ${request}`);
        socket.send(
            `RES: ${match[1]}\r\nHTTP/1.1 200 OK\r\n` +
            "Content-Length: 2\r\nConnection: close\r\n\r\nOK"
        );
    });

    const url = `http://127.0.0.1:${httpPort}/forward/v1/${deviceKey}/test`;
    const request = async (options = {}) => {
        const response = await fetch(url, {
            ...options,
            signal: AbortSignal.timeout(3000),
        });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "OK");
    };

    await request();
    await request({ method: "POST" });
    await request({
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "test-body",
    });

    assert.equal(forwarded.length, 3);
    assert.match(forwarded[0], /^FWD: [0-9a-f]{4}\r\nGET /);
    assert.match(forwarded[1], /^FWD: [0-9a-f]{4}\r\nPOST /);
    assert.ok(forwarded[2].endsWith("\r\n\r\ntest-body"));
});
