import { AuthenticationPlugin } from "../AuthenticationPlugin";
import * as mysql from "mysql";

/**
 * Validates device keys by checking if they exist in a MySQL database.
 */
export default class MySQLAuthenticationPlugin extends AuthenticationPlugin {

	private connection: mysql.Connection;

	public async init(): Promise<void> {
		return new Promise( ( resolve, reject ) => {
			// Make sure that necessary variables have been defined.
			for ( const key of [ "MYSQL_TABLE", "MYSQL_CONNECTION_URL" ] ) {
				if ( !process.env[ key ] ) {
					reject( `Environment variable '${ key }' is not defined.` );
					return;
				}
			}

			this.connection = mysql.createConnection( process.env.MYSQL_CONNECTION_URL );
			this.connection.connect( ( err ) => {
				if ( err ) {
					reject( "Error connecting to database: " + err );
				} else {
					console.log( "Connected to database" );
					resolve();
				}
			} );
		} );
	}

	public validateKey( deviceKey: string ): Promise<boolean> {
		return new Promise<boolean>( ( resolve, reject ) => {
			// Reject all keys if the database connection isn't ready yet.
			if ( this.connection.state !== "authenticated" ) {
				resolve( false );
			}

			this.connection.query( "SELECT * FROM ?? WHERE device_key = ?", [ process.env.MYSQL_TABLE, deviceKey ], ( err, results, fields ) => {
				if ( err ) {
					console.error( err );
					resolve( false );
					return;
				}

				resolve( results.length !== 0 );
			} );
		} );
	}
}
