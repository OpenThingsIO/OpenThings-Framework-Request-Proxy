import * as express from "express";
import * as WebSocket from "ws";
import * as mysql from "mysql";
import * as http from "http";
import * as querystring from "querystring";
import * as URL from "url";

const server = new WebSocket.Server( {
	port: 8888
} );
const connectedControllers: Map<String, WebSocket> = new Map();
const pendingResponses: Map<String, express.Response> = new Map();
const connection: mysql.Connection = mysql.createConnection( process.env.MYSQL_CONNECTION_URL );

connection.connect( ( err ) => {
	if ( err ) {
		console.error( "Error connecting to database:", err );
		process.exit( 1 );
		return;
	}

	console.log( "Connected to database" );
} );


server.on( "connection", async ( ws: WebSocket, req: http.IncomingMessage ) => {
	const url = URL.parse( req.url );
	if ( url.pathname !== "/socket/v1" ) {
		ws.send( "ERR: invalid path." );
		ws.terminate();
		return;
	}

	const deviceKey = querystring.parse( url.query )[ "deviceKey" ];
	if ( !deviceKey || typeof deviceKey !== "string" ) {
		ws.send( "ERR: deviceKey was not properly specified." );
		ws.terminate();
		return;
	}

	if ( connectedControllers.has( deviceKey ) ) {
		ws.send( "ERR: A controller with this device key is already connected." );
		ws.terminate();
		return;
	}

	if ( !await validateKey( deviceKey ) ) {
		ws.send( "ERR: Invalid device key." );
		ws.terminate();
		return;
	}

	connectedControllers.set( deviceKey, ws );
	ws.on( "close", () => {
		connectedControllers.delete( deviceKey );
	} );

	ws.on( "message", ( message ) => {
		// Ignore binary messages.
		if ( typeof message !== "string" ) {
			console.info( "Ignoring binary message" );
			return;
		}

		const match = message.match( /^RES: ([0-9a-f]{4})\n([\s\S]*)$/ );
		// Ignore messages that aren't formatted like responses to forwarded requests.
		if ( !match ) {
			console.info( "Received message with invalid format:", message );
			return;
		}
		const requestKey = `${ deviceKey }:${ match[ 1 ] }`;
		const body = match[ 2 ];

		// Ignore invalid request IDs.
		if ( !pendingResponses.has( requestKey ) ) {
			console.info( "Received response with invalid key " + deviceKey );
			return;
		}

		const res: express.Response = pendingResponses.get( requestKey );
		pendingResponses.delete( requestKey );

		res.connection.write( body );
		res.connection.end();
	} );

	// Close connections that don't respond to pings within 10 seconds.
	ws[ "isAlive" ] = true;
	ws.on( "pong", () => {
		ws[ "isAlive" ] = true;
	} );
	setInterval( () => {
		// Close the connection if a pong was not received since the last check.
		if ( !ws[ "isAlive" ] ) {
			ws.terminate();
			return;
		}

		ws[ "isAlive" ] = false;
		ws.ping();
	}, 10 * 1000 );

	console.log( `A client connected with device key '${ deviceKey }'.` );
} );

export const forwardRequest = ( req: express.Request, res: express.Response ) => {
	const deviceKey = req.params.deviceKey;
	if ( !deviceKey || typeof deviceKey !== "string" ) {
		res.status( 401 ).json( { message: "No device key was specified or an invalid format was used." } );
		return;
	}

	if ( !connectedControllers.has( deviceKey ) ) {
		res.status( 404 ).json( { message: "Specified device does not exist or is not connected." } );
		return;
	}

	const ws: WebSocket = connectedControllers.get( deviceKey );

	const path = req.url.substring( ( "/forward/v1/" + deviceKey ).length );

	let rawRequest: string = `${ req.method } ${ path } HTTP/${ req.httpVersion }\r\n`;
	for ( const header in req.headers ) {
		rawRequest += `${ header }: ${ req.headers[ header ] }\r\n`;
	}

	// req.body be an empty object if no body exists.
	rawRequest += `\r\n${ Object.keys( req.body ).length === 0 ? "" : req.body }`;

	// A random 4 digit hexadecimal number.
	const requestId = Math.floor( Math.random() * 0x10000 ).toString( 16 ).padStart( 4, "0" );
	pendingResponses.set( `${ deviceKey }:${ requestId }`, res );
	ws.send( `FWD: ${ requestId }\r\n${ rawRequest }` );
};

/** Checks that the specified device key exists in the database. */
const validateKey = async ( deviceKey: string ): Promise<boolean> => {
	return new Promise<boolean>( ( resolve, reject ) => {
		// Reject all keys if the database connection isn't ready yet.
		if ( connection.state !== "authenticated" ) {
			resolve( false );
		}

		connection.query( "SELECT * FROM ? WHERE device_key = ?", [ process.env.MYSQL_TABLE, deviceKey ], ( err, results, fields ) => {
			if ( err ) {
				console.error( err );
				resolve( false );
				return;
			}

			resolve( results.length !== 0 );
		} );
	} );
};
