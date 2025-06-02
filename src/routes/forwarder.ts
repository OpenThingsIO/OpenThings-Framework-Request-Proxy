import { Request, Response } from "express";
import WebSocket, { WebSocketServer } from "ws";
import { IncomingMessage } from "http";
import { URL } from "url";
import { AuthenticationPlugin } from "../AuthenticationPlugin";
import { default as fs } from "fs";
import { Logger } from "pino";

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

let server: WebSocketServer;
const connectedControllers: Map<String, WebSocket> = new Map();
const pendingResponses: Map<String, Map<String, { res: Response; logger: Logger }>> =
    new Map();

export async function setupWebsockets(
    authPluginRoot: string,
    logger: Logger,
    host: string
) {
    // Load the specified authentication plugin.
    if (
        !fs.existsSync(
            `${authPluginRoot}/authenticationPlugins/${process.env.AUTHENTICATION_PLUGIN}.js`
        )
    ) {
        logger.error(
            `Authentication plugin '${process.env.AUTHENTICATION_PLUGIN}' does not exist.`
        );
        process.exit(1);
    }
    const authPlugin: AuthenticationPlugin = new (
        await import(
            `${authPluginRoot}/authenticationPlugins/${process.env.AUTHENTICATION_PLUGIN}.js`
        )
    ).default.default();

    try {
        logger.info("Initializing authentication plugin...");
        await authPlugin.init(
            logger.child({
                name: "auth",
                plugin: process.env.AUTHENTICATION_PLUGIN,
            })
        );
        logger.info("Initialized authentication plugin");
    } catch (err) {
        logger.error(err, "Fatal error initializing authentication plugin");
        process.exit(1);
    }

    server = new WebSocketServer({
        host,
        port: parseInt(process.env.WEBSOCKET_PORT) || 8080,
        skipUTF8Validation: true,
    });

    server.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
        const wsLogger = logger.child({
            client: req.socket.remoteAddress,
            url: req.url,
            name: "ws",
        });
        wsLogger.trace("A client connected");
        const url = new URL(req.url, "ws://localhost");
        if (url.pathname !== "/socket/v1") {
            ws.send("ERR: invalid path.");
            ws.terminate();
            return;
        }

        const deviceKey = url.searchParams.get("deviceKey");
        if (!deviceKey || typeof deviceKey !== "string") {
            ws.send("ERR: deviceKey was not properly specified.");
            ws.terminate();
            return;
        }

        if (connectedControllers.has(deviceKey)) {
            ws.send(
                "ERR: A controller with this device key is already connected."
            );
            ws.terminate();
            return;
        }

        let isValid = false;
        try {
            isValid = await authPlugin.validateKey(deviceKey);
        } catch (err) {
            wsLogger.error(err, "Error validating device key");
            ws.send("ERR: Error validating device key.");
            ws.terminate();
            return;
        }
        if (!isValid) {
            ws.send("ERR: Invalid device key.");
            ws.terminate();
            return;
        }

        connectedControllers.set(deviceKey, ws);
        pendingResponses.set(deviceKey, new Map());

        // Close connections that don't respond to pings within 10 seconds.
        ws["isAlive"] = true;
        ws.on("pong", () => {
            ws["isAlive"] = true;
        });

        const intervalId = setInterval(() => {
            // Close the connection if a pong was not received since the last check.
            if (!ws["isAlive"]) {
                wsLogger.trace(
                    `A client with device key '${deviceKey}' did not respond to pings.`
                );
                connectedControllers.delete(deviceKey);
                pendingResponses.delete(deviceKey);
                ws.terminate();
                clearInterval(intervalId);
                return;
            }

            ws["isAlive"] = false;
            ws.ping();
        }, 10 * 1000);

        ws.on("error", (err) => {
            wsLogger.error(
                err,
                `A client with device key '${deviceKey}' errored:`
            );
            connectedControllers.delete(deviceKey);
            clearInterval(intervalId);
        });

        ws.on("close", (code, reason) => {
            wsLogger.trace(
                `A client with device key '${deviceKey}' disconnected.`
            );
            connectedControllers.delete(deviceKey);
            clearInterval(intervalId);
        });

        ws.on("message", (data: WebSocket.Data, isBinary: boolean) => {
            // Ignore binary messages.
            if (isBinary) {
                wsLogger.info(
                    `Ignoring binary message from client with device key '${deviceKey}'.`
                );
                return;
            }

            let message: string;
            switch (typeof data) {
                case "string":
                    const buffer = Buffer.from(data);
                    if (!isValidUTF8(buffer)) {
                        wsLogger.error(
                            { message: buffer.toString('hex') },
                            `Received message with invalid UTF-8 encoding from client with device key '${deviceKey}'.`
                        );
                        return;
                    }
                    
                    message = data;
                    break;
                case "object":
                    if (data instanceof Buffer) {
                        if (!isValidUTF8(data)) {
                            wsLogger.error(
                                { message: data.toString('hex') },
                                `Received message with invalid UTF-8 encoding from client with device key '${deviceKey}'.`
                            );
                            return;
                        }
                        
                        message = data.toString();
                        break;
                    } else if (data instanceof ArrayBuffer) {
                        const buffer = Buffer.from(data);
                        if (!isValidUTF8(buffer)) {
                            wsLogger.error(
                                { message: buffer.toString('hex') },
                                `Received message with invalid UTF-8 encoding from client with device key '${deviceKey}'.`
                            );
                            return;
                        }
                        message = buffer.toString();
                        break;
                    } else if (data instanceof Array) {
                        // Array of buffers
                        const buffer = Buffer.concat(data.map((e) => Uint8Array.from(e)));
                        if (!isValidUTF8(buffer)) {
                            wsLogger.error(
                                { message: buffer.toString('hex') },
                                `Received message with invalid UTF-8 encoding from client with device key '${deviceKey}'.`
                            );
                            return;
                        }
                        message = buffer.toString();
                    }
                    break;
                default:
                    wsLogger.info(
                        `Received message with invalid type: ${typeof data} from client with device key '${deviceKey}'.`
                    );
                    return;
            }

            const match = (message as string).match(
                /^RES: ([0-9a-f]{4})\r\n([\s\S]*)$/
            );
            // Ignore messages that aren't formatted like responses to forwarded requests.
            if (!match) {
                wsLogger.warn(
                    `Received message with invalid format: ${message} from client with device key '${deviceKey}'.`
                );
                return;
            }
            const requestKey = match[1];
            const body = match[2];

            // Ignore invalid request IDs.
            if (!pendingResponses.has(deviceKey)) {
                wsLogger.warn(
                    `Received response with invalid device key '${deviceKey}'.`
                );
                return;
            }

            const deviceResponses = pendingResponses.get(deviceKey);

            if (!deviceResponses.has(requestKey)) {
                wsLogger.warn(
                    `Received response with invalid key: ${requestKey} from client with device key '${deviceKey}'.`
                );
                return;
            }

            const { res, logger } = deviceResponses.get(requestKey);
            logger.trace(
                `Received response for '${requestKey}' from device with key '${deviceKey}'`
            );
            deviceResponses.delete(requestKey);

            res.socket.write(body);
            res.socket.end();
        });

        wsLogger.info(`A client connected with device key '${deviceKey}'.`);
    });
}

export const forwardRequest = (req: Request, res: Response) => {
    const deviceKey = req.params.deviceKey;
    if (!deviceKey || typeof deviceKey !== "string") {
        res.status(401).json({
            message:
                "No device key was specified or an invalid format was used.",
        });
        return;
    }

    if (!connectedControllers.has(deviceKey)) {
        res.status(404).json({
            message: "Specified device does not exist or is not connected.",
        });
        return;
    }

    const ws: WebSocket = connectedControllers.get(deviceKey);

    const path = req.url.substring(("/forward/v1/" + deviceKey).length) || "/";

    let rawRequest: string = `${req.method} ${path} HTTP/${req.httpVersion}\r\n`;
    for (const header in req.headers) {
        rawRequest += `${header}: ${req.headers[header]}\r\n`;
    }

    // req.body be an empty object if no body exists.
    rawRequest += `\r\n${Object.keys(req.body).length === 0 ? "" : req.body}`;

    // A random 4 digit hexadecimal number.
    const requestId = Math.floor(Math.random() * 0x10000)
        .toString(16)
        .padStart(4, "0");

    const responseLogger = req.log.child({ requestId });

    responseLogger.trace(
        `Forwarding request to device with key '${deviceKey}'`
    );

    // Ignore invalid request IDs.
    if (!pendingResponses.has(deviceKey)) {
        res.status(404).json({
            message: "Specified device does not exist or is not connected.",
        });
        return;
    }

    const deviceResponses = pendingResponses.get(deviceKey);

    deviceResponses.set(requestId, {
        res,
        logger: responseLogger,
    });

    req.on("close", () => {
        if (pendingResponses.has(deviceKey)) {
            const deviceResponses = pendingResponses.get(deviceKey);

            deviceResponses.delete(requestId);
        }
    });

    ws.send(`FWD: ${requestId}\r\n${rawRequest}`);
};
