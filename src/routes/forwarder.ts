import { RequestHandler, Response } from "express";
import WebSocket, { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { once } from "events";
import { Logger } from "pino";
import { AuthenticationPlugin } from "../AuthenticationPlugin";
import { backendErrorCode, EventLimiter, forwardedEndpoint, tokenFingerprint } from "../diagnostics";
import { RequestIds } from "../requestIds";

/**
 * Checks if a given buffer contains only correct UTF-8.
 * From the ws library.
 * Ported from https://www.cl.cam.ac.uk/%7Emgk25/ucs/utf8_check.c by
 * Markus Kuhn.
 *
 * @param {Buffer} buf The buffer to check
 * @return {Boolean} `true` if `buf` contains only correct UTF-8, else `false`
 * @public
 */
function isValidUTF8(buf: Buffer): boolean {
    const len = buf.length;
    let i = 0;

    while (i < len) {
        if ((buf[i] & 0x80) === 0) {
            // 0xxxxxxx
            i++;
        } else if ((buf[i] & 0xe0) === 0xc0) {
            // 110xxxxx 10xxxxxx
            if (
                i + 1 === len ||
                (buf[i + 1] & 0xc0) !== 0x80 ||
                (buf[i] & 0xfe) === 0xc0 // Overlong
            ) {
                return false;
            }

            i += 2;
        } else if ((buf[i] & 0xf0) === 0xe0) {
            // 1110xxxx 10xxxxxx 10xxxxxx
            if (
                i + 2 >= len ||
                (buf[i + 1] & 0xc0) !== 0x80 ||
                (buf[i + 2] & 0xc0) !== 0x80 ||
                (buf[i] === 0xe0 && (buf[i + 1] & 0xe0) === 0x80) || // Overlong
                (buf[i] === 0xed && (buf[i + 1] & 0xe0) === 0xa0) // Surrogate (U+D800 - U+DFFF)
            ) {
                return false;
            }

            i += 3;
        } else if ((buf[i] & 0xf8) === 0xf0) {
            // 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
            if (
                i + 3 >= len ||
                (buf[i + 1] & 0xc0) !== 0x80 ||
                (buf[i + 2] & 0xc0) !== 0x80 ||
                (buf[i + 3] & 0xc0) !== 0x80 ||
                (buf[i] === 0xf0 && (buf[i + 1] & 0xf0) === 0x80) || // Overlong
                (buf[i] === 0xf4 && buf[i + 1] > 0x8f) ||
                buf[i] > 0xf4 // > U+10FFFF
            ) {
                return false;
            }

            i += 4;
        } else {
            return false;
        }
    }

    return true;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const MAX_REQUEST_TIMEOUT_MS = 300_000;
export const AUTHENTICATION_TIMEOUT_MS = 10_000;

export function requestTimeout(value: unknown, logger: Logger): number {
    if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
    const parsed = typeof value === "string" && value.trim() !== "" ? Number(value)
        : typeof value === "number" ? value : NaN;
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_REQUEST_TIMEOUT_MS) return parsed;
    logger.warn({ event: "invalid_request_timeout", defaultMs: DEFAULT_REQUEST_TIMEOUT_MS });
    return DEFAULT_REQUEST_TIMEOUT_MS;
}

export interface ForwarderOptions {
    host?: string;
    port?: number;
    requestTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    rejectionTimeoutMs?: number;
    authenticationTimeoutMs?: number;
}

interface PendingResponse {
    res: Response;
    startedAt: number;
    endpoint: string;
    timer: ReturnType<typeof setTimeout>;
    settled: boolean;
    detach: () => void;
}

interface Session {
    ws: WebSocket;
    key: string;
    connectionId: string;
    logger: Logger;
    startedAt: number;
    lastPongAt: number;
    isAlive: boolean;
    closed: boolean;
    pending: Map<string, PendingResponse>;
    ids: RequestIds;
    heartbeat?: ReturnType<typeof setInterval>;
    onMessage?: (data: WebSocket.RawData, binary: boolean) => void;
    onPong?: () => void;
}

// Each instance owns its maps; tests and staged instances cannot share sessions.
export async function setupWebsockets(
    authPlugin: AuthenticationPlugin,
    logger: Logger,
    options: ForwarderOptions = {}
) {
    await authPlugin.init(logger.child({ name: "auth" }));
    const timeoutMs = requestTimeout(options.requestTimeoutMs ?? process.env.REQUEST_TIMEOUT_MS, logger);
    const heartbeatMs = options.heartbeatIntervalMs ?? 10_000;
    const rejectionMs = options.rejectionTimeoutMs ?? 5_000;
    const authenticationMs = options.authenticationTimeoutMs ?? AUTHENTICATION_TIMEOUT_MS;
    const sessions = new Map<string, Session>();
    const limiter = new EventLimiter();
    let stopping = false;
    const server = new WebSocketServer({
        host: options.host ?? "127.0.0.1",
        port: options.port ?? 8080,
        skipUTF8Validation: true,
    });

    function settle(session: Session, id: string, entry: PendingResponse,
        outcome: { reason: string; body?: Buffer; message?: string }): void {
        if (entry.settled) return;
        entry.settled = true;
        // A delayed callback must never remove a newer entry with the same ID.
        if (session.pending.get(id) === entry) session.pending.delete(id);
        clearTimeout(entry.timer);
        entry.detach();
        const fields = { requestId: id, reason: outcome.reason,
            durationMs: Date.now() - entry.startedAt, endpoint: entry.endpoint,
            pendingRequests: session.pending.size };
        session.logger.debug({ ...fields, event: "request_settled" });
        if (outcome.reason === "request_timeout") {
            limiter.log(session.logger, "warn", "request_timeout", session.connectionId, fields);
        }
        const res = entry.res;
        if (!outcome.body && !outcome.message) return;
        const socket = res.socket;
        if (!socket || socket.destroyed || !socket.writable || res.destroyed || res.writableEnded) return;
        if (res.headersSent) {
            res.destroy();
            return;
        }
        try {
            if (outcome.body) {
                // The controller already supplied the complete HTTP response.
                // Mark settled BEFORE raw I/O; Express flags do not track it.
                const status = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: |\r)/
                    .exec(outcome.body.subarray(0, 64).toString("latin1"));
                if (status) res.statusCode = Number(status[1]);
                res.locals.controllerResponseForwarded = true;
                socket.end(outcome.body);
            } else {
                res.status(408).json({ message: outcome.message });
            }
        } catch {
            res.locals.controllerResponseForwarded = false;
            socket.destroy();
            limiter.log(session.logger, "warn", "response_write_failed", session.connectionId);
        }
    }

    function cleanup(session: Session, reason: string,
        message = "Controller disconnected.", closeCode?: number): void {
        if (session.closed) return;
        session.closed = true;
        clearInterval(session.heartbeat);
        if (session.onMessage) session.ws.off("message", session.onMessage);
        if (session.onPong) session.ws.off("pong", session.onPong);
        const owned = sessions.get(session.key) === session;
        if (owned) sessions.delete(session.key);
        const pendingRequests = session.pending.size;
        for (const [id, entry] of session.pending) {
            settle(session, id, entry, { reason, message });
        }
        session.logger.info({ event: "session_cleanup", reason, owned, closeCode,
            pendingRequests, ageMs: Date.now() - session.startedAt,
            lastPongAgeMs: Date.now() - session.lastPongAt });
    }

    server.on("connection", (ws, req) => {
        const connectionId = randomUUID();
        const connectedAt = Date.now();
        let connectionLogger = logger.child({ name: "ws", connectionId,
            client: req.socket.remoteAddress });
        let session: Session | undefined;
        let closed = false;
        let rejected = false;
        let rejectionTimer: ReturnType<typeof setTimeout> | undefined;
        let authenticationTimer: ReturnType<typeof setTimeout> | undefined;
        let cancelAuthentication: (() => void) | undefined;
        let identity = "unspecified";

        // Observe transport state before URL parsing or asynchronous auth.
        ws.on("close", (code) => {
            closed = true;
            clearTimeout(rejectionTimer);
            clearTimeout(authenticationTimer);
            cancelAuthentication?.();
            if (session) {
                cleanup(session, "peer_close", undefined, code);
                connectionLogger.debug({ event: "connection_closed", closeCode: code,
                    pendingRequests: session.pending.size });
            } else {
                limiter.log(connectionLogger, "debug", rejected ? "rejected_connection_closed" : "auth_closed",
                    identity, { closeCode: code });
            }
        });
        ws.on("error", (error) => {
            closed = true;
            clearTimeout(rejectionTimer);
            clearTimeout(authenticationTimer);
            cancelAuthentication?.();
            const fragment = error.message === "Invalid WebSocket frame: invalid opcode 0";
            if (session) cleanup(session, fragment ? "fragment_error" : "transport_error",
                fragment ? "Controller dropped packet." : "Controller disconnected.");
            else if (!rejected) limiter.log(connectionLogger, "warn", "pre_auth_error", identity);
            ws.terminate();
        });

        function reject(code: number, reason: string, extra: Record<string, unknown> = {}): void {
            if (closed || rejected || ws.readyState !== WebSocket.OPEN) return;
            rejected = true;
            limiter.log(connectionLogger, "info", "connection_rejected", `${identity}:${reason}`,
                { reason, closeCode: code, ...extra });
            rejectionTimer = setTimeout(() => {
                limiter.log(connectionLogger, "warn", "rejection_forced_close", `${identity}:${reason}`, { reason });
                ws.terminate();
            }, rejectionMs);
            rejectionTimer.unref();
            try {
                ws.send(`ERR: ${reason}.`);
                ws.close(code, reason);
            } catch {
                clearTimeout(rejectionTimer);
                ws.terminate();
            }
        }

        let url: URL;
        try { url = new URL(req.url || "", "ws://localhost"); }
        catch { reject(1008, "invalid path"); return; }
        if (url.pathname !== "/socket/v1") { reject(1008, "invalid path"); return; }
        const key = url.searchParams.get("deviceKey");
        if (!key) { reject(1008, "missing device key"); return; }
        identity = tokenFingerprint(key);
        connectionLogger = connectionLogger.child({ tokenHash: identity });

        async function authenticate(): Promise<void> {
            if (closed || stopping || ws.readyState !== WebSocket.OPEN) return;
            let valid: boolean;
            let timedOut = false;
            const authenticationStarted = Date.now();
            const cancelled = new Promise<boolean>(resolve => {
                cancelAuthentication = () => resolve(false);
                authenticationTimer = setTimeout(() => {
                    timedOut = true;
                    resolve(false);
                }, authenticationMs);
                authenticationTimer.unref();
            });
            try {
                // Promise.race also observes a late backend rejection, so it
                // cannot become an unhandled rejection after timeout/close.
                valid = await Promise.race([
                    Promise.resolve().then(() => authPlugin.validateKey(key)), cancelled,
                ]);
            }
            catch (error) {
                reject(1011, "authentication unavailable", { errorCode: backendErrorCode(error) });
                return;
            } finally {
                clearTimeout(authenticationTimer);
                cancelAuthentication = undefined;
            }
            if (closed || stopping || ws.readyState !== WebSocket.OPEN) return;
            if (timedOut || Date.now() - authenticationStarted >= authenticationMs) {
                reject(1011, "authentication timed out", { errorCode: "AUTH_TIMEOUT" });
                return;
            }
            if (!valid) { reject(1008, "invalid device key"); return; }
            // Final ownership check and claim are synchronous, with no await gap.
            const owner = sessions.get(key);
            if (owner) {
                reject(1008, "device key already connected", {
                    ownerConnectionId: owner.connectionId, ownerAgeMs: Date.now() - owner.startedAt,
                    pendingRequests: owner.pending.size,
                });
                return;
            }
            session = { ws, key, connectionId, logger: connectionLogger,
                startedAt: connectedAt, lastPongAt: Date.now(), isAlive: true,
                closed: false, pending: new Map(), ids: new RequestIds() };
            sessions.set(key, session);
            const accepted = session;
            accepted.onPong = () => {
                if (accepted.closed) return;
                accepted.isAlive = true;
                accepted.lastPongAt = Date.now();
            };
            ws.on("pong", accepted.onPong);
            accepted.heartbeat = setInterval(() => {
                if (accepted.closed) return;
                if (!accepted.isAlive) {
                    cleanup(accepted, "heartbeat_expired");
                    ws.terminate();
                    return;
                }
                accepted.isAlive = false;
                ws.ping(undefined, undefined, (error) => {
                    if (error) { cleanup(accepted, "ping_failed"); ws.terminate(); }
                });
            }, heartbeatMs);
            accepted.heartbeat.unref();
            accepted.onMessage = (data, binary) => {
                if (accepted.closed || sessions.get(key) !== accepted) return;
                const buffer = Buffer.isBuffer(data) ? data
                    : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
                const newline = buffer.indexOf(0x0a);
                const header = newline < 0 ? Buffer.alloc(0) : buffer.subarray(0, newline);
                const match = !binary && isValidUTF8(header)
                    ? /^RES: ([0-9a-f]{4})\r$/.exec(header.toString()) : null;
                if (!match) {
                    limiter.log(connectionLogger, "warn", "invalid_response_frame", identity,
                        { length: buffer.length, reason: binary ? "binary" : "invalid_header" });
                    return;
                }
                const id = match[1];
                const entry = accepted.pending.get(id);
                if (!entry) {
                    limiter.log(connectionLogger, "debug", "unknown_response_id", identity, { requestId: id });
                    return;
                }
                settle(accepted, id, entry, { reason: "controller_response", body: buffer.subarray(newline + 1) });
            };
            ws.on("message", accepted.onMessage);
            connectionLogger.info({ event: "session_accepted", authentication: "accepted", pendingRequests: 0 });
        }
        void authenticate();
    });

    const forwardRequestV1: RequestHandler = (req, res) => {
        const key = req.params.deviceKey;
        if (!key || typeof key !== "string") {
            res.status(401).json({ message: "No device key was specified or an invalid format was used." });
            return;
        }
        const session = sessions.get(key);
        if (session && session.ws.readyState !== WebSocket.OPEN) cleanup(session, "transport_unavailable");
        if (!session || session.closed) {
            res.status(404).json({ message: "Specified device does not exist or is not connected." });
            return;
        }
        const id = session.ids.allocate(session.pending);
        if (id === undefined) {
            res.status(429).json({ message: "Controller request capacity reached." });
            return;
        }
        const path = /^\/forward\/v1\/[^/?]+(.*)$/.exec(req.url)?.[1] || "/";
        let rawRequest = `${req.method} ${path} HTTP/${req.httpVersion}\r\n`;
        for (const [name, value] of Object.entries(req.headers)) rawRequest += `${name}: ${value}\r\n`;
        rawRequest += `\r\n${typeof req.body === "string" ? req.body : ""}`;
        const entry: PendingResponse = { res, startedAt: Date.now(), settled: false,
            endpoint: forwardedEndpoint(req.url), timer: undefined, detach: () => {} };
        const abandoned = () => settle(session, id, entry, { reason: "browser_departed" });
        const finished = () => settle(session, id, entry, { reason: "http_finished" });
        entry.detach = () => {
            res.off("close", abandoned);
            res.off("error", abandoned);
            res.off("finish", finished);
        };
        res.once("close", abandoned);
        res.once("error", abandoned);
        res.once("finish", finished);
        entry.timer = setTimeout(() => settle(session, id, entry,
            { reason: "request_timeout", message: "Controller did not respond." }), timeoutMs);
        entry.timer.unref();
        session.pending.set(id, entry);
        if (res.destroyed || !res.socket || res.socket.destroyed) { abandoned(); return; }
        try {
            session.ws.send(`FWD: ${id}\r\n${rawRequest}`, (error) => {
                if (error) settle(session, id, entry, { reason: "send_failed", message: "Controller disconnected." });
            });
        } catch {
            settle(session, id, entry, { reason: "send_failed", message: "Controller disconnected." });
        }
    };

    await once(server, "listening");
    return { server, forwardRequestV1, async close(): Promise<void> {
        stopping = true;
        for (const session of sessions.values()) cleanup(session, "server_shutdown");
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}
