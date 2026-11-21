import { Logger } from "pino";
import { AuthenticationContext, AuthenticationInitOptions, AuthenticationPlugin } from "../AuthenticationPlugin";
import * as mysql from "mysql";
import { backendErrorCode } from "../diagnostics";
import { boundedInteger, ConfigurationError } from "../configuration";

/**
 * Validates device keys by checking if they exist in a MySQL database.
 */
export default class MySQLAuthenticationPlugin extends AuthenticationPlugin {
    private pool: mysql.Pool;
    private table: string;
    private stopped?: Promise<void>;

    public async init(_logger: Logger, options?: AuthenticationInitOptions): Promise<void> {
        for (const key of ["MYSQL_TABLE", "MYSQL_CONNECTION_URL"] as const) {
            if (!process.env[key]) throw new ConfigurationError(key, "missing");
        }
        const concurrency = boundedInteger("AUTH_CONCURRENCY",
            options?.concurrency ?? process.env.AUTH_CONCURRENCY, 10, 100);
        this.table = process.env.MYSQL_TABLE;
        try {
            // Let the driver parse its supported URL options. Before any use,
            // override admission/time limits so URL options cannot bypass them.
            this.pool = mysql.createPool(process.env.MYSQL_CONNECTION_URL);
            this.pool.config.connectionLimit = concurrency;
            this.pool.config.waitForConnections = false;
            this.pool.config.queueLimit = 1;
            this.pool.config.acquireTimeout = 10_000;
            this.pool.config.connectionConfig.connectTimeout = 10_000;
            // Driver debug output prints SQL and credentials outside our logger.
            this.pool.config.connectionConfig.debug = false;
        } catch {
            throw new ConfigurationError("MYSQL_CONNECTION_URL", "invalid");
        }
    }

    private failure(error: unknown): Error {
        // Never retain the driver's SQL-bearing error object as a cause.
        return Object.assign(new Error("Authentication backend unavailable"), { code: backendErrorCode(error) });
    }

    public validateKey(deviceKey: string, context?: AuthenticationContext): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            const stale = () => context && (context.signal.aborted || context.remainingMs() < 1);
            const expired = () => this.failure({ code: "AUTH_TIMEOUT" });
            if (stale()) { reject(expired()); return; }
            try {
                this.pool.getConnection((error, connection) => {
                    if (error) { reject(this.failure(error)); return; }
                    let released = false;
                    const release = () => {
                        if (released) return;
                        released = true;
                        connection.release();
                    };
                    if (stale()) { release(); reject(expired()); return; }
                    const timeout = Math.min(10_000, Math.floor(context?.remainingMs() ?? 10_000));
                    if (timeout < 1) { release(); reject(expired()); return; }
                    try {
                        connection.query({ sql: "SELECT 1 FROM ?? WHERE device_key = ? LIMIT 1", timeout },
                            [this.table, deviceKey], (err, results) => {
                                release();
                                if (err) reject(this.failure(err));
                                else resolve(results.length !== 0);
                            });
                    } catch (err) { release(); reject(this.failure(err)); }
                });
            } catch (error) { reject(this.failure(error)); }
        });
    }

    public close(): Promise<void> {
        if (!this.stopped) this.stopped = new Promise((resolve, reject) => {
            if (!this.pool) { resolve(); return; }
            this.pool.end(error => error ? reject(this.failure(error)) : resolve());
        });
        return this.stopped;
    }
}
