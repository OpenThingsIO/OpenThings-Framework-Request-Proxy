import * as bodyParser from "body-parser";
import * as express from "express";
import * as forwarder from "./routes/forwarder";
import { config as dotenv_config } from "dotenv"

dotenv_config();

const host = process.env.HOST || "0.0.0.0";
const port = parseInt( process.env.HTTP_PORT ) || 8080;

const app = express();

app.use( bodyParser.text( { type: "*/*", limit: "1mb" } ) );
app.all( "/forward/v1/:deviceKey/*", forwarder.forwardRequest );

app.listen( port, host, () => {
	console.log( "%s v%s now listening on %s:%d", process.env.npm_package_description, process.env.npm_package_version, host, port );
} );
