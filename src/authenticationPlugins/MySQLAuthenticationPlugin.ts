import { Logger } from "pino";
import { AuthenticationPlugin } from "../AuthenticationPlugin";
import * as mysql from "mysql";
import { backendErrorCode } from "../diagnostics";
import { ConfigurationError } from "../configuration";

/**
 * Validates device keys by checking if they exist in a MySQL database.
 */
export default class MySQLAuthenticationPlugin extends AuthenticationPlugin {
    private pool: mysql.Pool;
    private logger: Logger;

    public async init(logger: Logger): Promise<void> {
        this.logger = logger;
        return new Promise((resolve, reject) => {
            // Make sure that necessary variables have been defined.
            for (const key of ["MYSQL_TABLE", "MYSQL_CONNECTION_URL"] as const) {
                if (!process.env[key]) {
                    reject(new ConfigurationError(key, "missing"));
                    return;
                }
            }

            try {
                this.pool = mysql.createPool(process.env.MYSQL_CONNECTION_URL);
            } catch {
                reject(new ConfigurationError("MYSQL_CONNECTION_URL", "invalid"));
                return;
            }
            resolve();
        });
    }

    public validateKey(deviceKey: string): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            this.pool.query(
                { sql: "SELECT * FROM ?? WHERE device_key = ?", timeout: 10_000 },
                [process.env.MYSQL_TABLE, deviceKey],
                (err, results, fields) => {
                    if (err) {
                        // mysql errors include the formatted SQL and key. The
                        // forwarder rate-limits logging of this sanitized failure.
                        const failure = new Error("Authentication backend unavailable");
                        Object.assign(failure, { code: backendErrorCode(err) });
                        reject(failure);
                        return;
                    }

                    resolve(results.length !== 0);
                }
            );
        });
    }
}
