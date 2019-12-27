import { AuthenticationPlugin } from "../AuthenticationPlugin";

/** Validates device keys by checking if they're listed in the environment variable `DEVICE_KEYS`. */
export default class EnvironmentVariableAuthenticationPlugin extends AuthenticationPlugin {

	private deviceKeys: string[];

	public async init(): Promise<void> {
		if ( !process.env.DEVICE_KEYS ) {
			throw `Environment variable 'DEVICE_KEYS' is not defined.`;
		}

		this.deviceKeys = process.env.DEVICE_KEYS.split(",");
	}

	public async validateKey( deviceKey: string ): Promise<boolean> {
		return this.deviceKeys.includes(deviceKey);
	}
}
