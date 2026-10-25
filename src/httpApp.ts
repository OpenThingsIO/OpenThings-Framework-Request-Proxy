import bodyParser from "body-parser";
import cors from "cors";
import express, { RequestHandler } from "express";
import { Logger } from "pino";
import { pinoHttp } from "pino-http";
import { forwardedEndpoint, tokenFingerprint } from "./diagnostics";

export function createHttpApp(forward: RequestHandler, logger: Logger) {
    const app = express();
    app.use(pinoHttp({
        logger: logger.child({ name: "http" }),
        customSuccessMessage(req, res) {
            if ((res as express.Response).locals?.controllerResponseForwarded) {
                return "controller response forwarded";
            }
            return !req.readableAborted && res.writableEnded ? "request completed" : "request aborted";
        },
        serializers: {
            req(req) {
                const match = /^\/forward\/v1\/([^/?]+)/.exec(req.url || "");
                return { id: req.id, method: req.method,
                    route: match ? "/forward/v1/:deviceKey" : "other",
                    endpoint: forwardedEndpoint(req.url || ""),
                    tokenHash: match ? tokenFingerprint(match[1]) : undefined };
            },
            // Redirect Location headers can also contain the token and password.
            res(res) {
                // Pino's standard wrapper reports null until Express sends
                // headers. Raw controller replies bypass that Express state.
                const raw = res.raw as express.Response;
                return { statusCode: raw?.locals?.controllerResponseForwarded
                    ? raw.statusCode : res.statusCode };
            },
            err() { return { message: "HTTP request failed" }; },
        },
    }));
    app.use(cors());
    app.use(bodyParser.text({ type: "*/*", limit: "1mb" }));
    app.all("/forward/v1/:deviceKey$", (req, res) => {
        res.redirect(301, req.url + "/");
    });
    app.all("/forward/v1/:deviceKey*?", forward);
    const errorHandler: express.ErrorRequestHandler = (err, req, res, _next) => {
        req.log.warn({ event: "http_request_error" });
        if (res.headersSent) {
            res.destroy();
            return;
        }
        const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500
            ? err.status : 500;
        res.status(status).json({ message: "Unable to process request." });
    };
    app.use(errorHandler);
    return app;
}
