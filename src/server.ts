import bodyParser from "body-parser";
import express from "express";
import { forwardRequest, setupWebsockets } from "./routes/forwarder";
import { config as dotenv_config } from "dotenv";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { pino, LevelWithSilent } from "pino";

function getLogLevel(): LevelWithSilent {
    switch (process.env.LOG_LEVEL) {
        case "trace":
            return "trace";
        case "debug":
            return "debug";
        case "info":
            return "info";
        case "warn":
            return "warn";
        case "error":
            return "error";
        case "fatal":
            return "fatal";
        case "silent":
            return "silent";
        default:
            return "info";
    }
}

const logger = pino({ level: getLogLevel() });

dotenv_config();

const host = process.env.HOST || "127.0.0.1";
const port = parseInt(process.env.HTTP_PORT) || 3000;

const authPluginRoot = `${__dirname}`;

setupWebsockets(authPluginRoot, logger, host);

const app = express();

app.use(
    pinoHttp({
        logger: logger.child({ name: "http" }),
        redact: {
            paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "req.query.pw",
            ],
            censor: "***CENSORED***",
        },
    })
);

app.use(cors());
app.use(bodyParser.text({ type: "*/*", limit: "1mb" }));
// Add a trailing slash
app.all("/forward/v1/:deviceKey$", (req, res, next) => {
    res.redirect(301, req.url + "/");
});
app.all("/forward/v1/:deviceKey*?", forwardRequest);

app.listen(port, host, () => {
    logger.info(
        "%s v%s now listening on %s:%d",
        process.env.npm_package_description,
        process.env.npm_package_version,
        host,
        port
    );
});
