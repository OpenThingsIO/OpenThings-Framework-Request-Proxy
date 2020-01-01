import * as express from "express";
import * as WebSocket from "ws";
import * as http from "http";
import * as querystring from "querystring";
import * as URL from "url";
import { AuthenticationPlugin } from "../AuthenticationPlugin";
import * as fs from "fs";

const server = new WebSocket.Server( {
	host: process.env.HOST,
	port: parseInt( process.env.WEBSOCKET_PORT ) || 8080
} );
const connectedControllers: Map<String, WebSocket> = new Map();
const pendingResponses: Map<String, express.Response> = new Map();

async function setup() {
	// Load the specified authentication plugin.
	if ( !fs.existsSync( `${__dirname}/../authenticationPlugins/${process.env.AUTHENTICATION_PLUGIN}.js`) ) {
		console.error( `Authentication plugin '${ process.env.AUTHENTICATION_PLUGIN }' does not exist.` );
		process.exit( 1 );
	}
	const authPlugin: AuthenticationPlugin = new ( require( "../authenticationPlugins/" + process.env.AUTHENTICATION_PLUGIN ).default )();

	try {
		console.log( "Initializing authentication plugin..." );
		await authPlugin.init();
		console.log( "Initialized authentication plugin" );
	} catch ( err ) {
		console.error( "Fatal error initializing authentication plugin", err );
		process.exit( 1 );
	}

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

		let isValid = false;
		try {
			isValid = await authPlugin.validateKey( deviceKey );
		} catch ( err ) {
			console.error( "Error validating device key", err );
			ws.send( "ERR: Error validating device key." );
			ws.terminate();
			return;
		}
		if ( !isValid ) {
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

			const match = message.match( /^RES: ([0-9a-f]{4})\r\n([\s\S]*)$/ );
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
}

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

setup();
