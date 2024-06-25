import bodyParser from "body-parser";
import express from "express";
import { forwardRequest } from "./routes/forwarder";
import { config as dotenv_config } from "dotenv"
import cors from "cors";

dotenv_config();

const host = process.env.HOST || "127.0.0.1";
const port = parseInt( process.env.HTTP_PORT ) || 3000;

const app = express();

app.use( cors() );
app.use( bodyParser.text( { type: "*/*", limit: "1mb" } ) );
// Add a trailing slash
app.all( "/forward/v1/:deviceKey$", ( req, res, next ) => {
	res.redirect( 301, req.url + "/" );
} );
app.all( "/forward/v1/:deviceKey*?", forwardRequest );

app.listen( port, host, () => {
	console.log( "%s v%s now listening on %s:%d", process.env.npm_package_description, process.env.npm_package_version, host, port );
} );
