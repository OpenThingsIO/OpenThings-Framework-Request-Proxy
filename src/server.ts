import { once } from "events";
import { config as dotenv_config } from "dotenv";
import { pino, LevelWithSilent } from "pino";
import { setupWebsockets } from "./routes/forwarder";
import { createHttpApp } from "./httpApp";
import EnvironmentVariableAuthenticationPlugin from "./authenticationPlugins/EnvironmentVariableAuthenticationPlugin";
import MySQLAuthenticationPlugin from "./authenticationPlugins/MySQLAuthenticationPlugin";
import { ConfigurationError, startupFailure } from "./configuration";

dotenv_config();
const levels = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
const level = levels.includes(process.env.LOG_LEVEL) ? process.env.LOG_LEVEL : "info";
const logger = pino({ level: level as LevelWithSilent });

async function main(): Promise<void> {
    const auth = process.env.AUTHENTICATION_PLUGIN === "EnvironmentVariableAuthenticationPlugin"
        ? new EnvironmentVariableAuthenticationPlugin()
        : process.env.AUTHENTICATION_PLUGIN === "MySQLAuthenticationPlugin"
            ? new MySQLAuthenticationPlugin() : undefined;
    if (!auth) throw new ConfigurationError("AUTHENTICATION_PLUGIN",
        process.env.AUTHENTICATION_PLUGIN ? "unsupported" : "missing");
    const host = process.env.HOST || "127.0.0.1";
    const port = parseInt(process.env.HTTP_PORT) || 3000;
    const proxy = await setupWebsockets(auth, logger, {
        host, port: parseInt(process.env.WEBSOCKET_PORT) || 8080,
    });
    const http = createHttpApp(proxy.forwardRequestV1, logger).listen(port, host);
    try { await once(http, "listening"); }
    catch (error) { await proxy.close(); throw error; }
    logger.info({ host, port }, "%s v%s now listening",
        process.env.npm_package_description, process.env.npm_package_version);
}

void main().catch(error => {
    const { message, ...fields } = startupFailure(error);
    logger.fatal(fields, message);
    process.exitCode = 1;
});
