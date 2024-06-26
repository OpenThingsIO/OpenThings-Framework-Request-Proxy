import { Request, Response } from "express";
import WebSocket, { WebSocketServer } from "ws";
import { IncomingMessage } from "http";
import { URL } from "url";
import { AuthenticationPlugin } from "../AuthenticationPlugin";
import { default as fs } from "fs";
import { Logger } from "pino";

let server: WebSocketServer;
const connectedControllers: Map<String, WebSocket> = new Map();
const pendingResponses: Map<String, { res: Response; logger: Logger }> =
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
                    message = data;
                    break;
                case "object":
                    if (data instanceof Buffer) {
                        message = data.toString();
                        break;
                    } else if (data instanceof ArrayBuffer) {
                        message = Buffer.from(data).toString();
                        break;
                    } else if (data instanceof Array) {
                        // Array of buffers
                        message = Buffer.concat(data).toString();
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
            const requestKey = `${deviceKey}:${match[1]}`;
            const body = match[2];

            // Ignore invalid request IDs.
            if (!pendingResponses.has(requestKey)) {
                wsLogger.warn(
                    `Received response with invalid key: ${requestKey} from client with device key '${deviceKey}'.`
                );
                return;
            }

            const { res, logger } = pendingResponses.get(requestKey);
            logger.trace(
                `Received response from device with key '${deviceKey}'`
            );
            pendingResponses.delete(requestKey);

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
    pendingResponses.set(`${deviceKey}:${requestId}`, {
        res,
        logger: responseLogger,
    });
    ws.send(`FWD: ${requestId}\r\n${rawRequest}`);
};
