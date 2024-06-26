import { Logger } from "pino";
import { AuthenticationPlugin } from "../AuthenticationPlugin";
import * as mysql from "mysql";

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
            for (const key of ["MYSQL_TABLE", "MYSQL_CONNECTION_URL"]) {
                if (!process.env[key]) {
                    reject(`Environment variable '${key}' is not defined.`);
                    return;
                }
            }

            this.pool = mysql.createPool(process.env.MYSQL_CONNECTION_URL);
            resolve();
        });
    }

    public validateKey(deviceKey: string): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            this.pool.query(
                "SELECT * FROM ?? WHERE device_key = ?",
                [process.env.MYSQL_TABLE, deviceKey],
                (err, results, fields) => {
                    if (err) {
                        this.logger.error(err);
                        resolve(false);
                        return;
                    }

                    resolve(results.length !== 0);
                }
            );
        });
    }
}
