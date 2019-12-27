export abstract class AuthenticationPlugin {
	public constructor() {

	}

	/**
	 * Initializes the plugin. This method will be called after the plugin is loaded and the server won't begin processing
	 * any requests until the promise it returns has been resolved. The default implementation returns a Promise that
	 * will be resolved immediately.
	 */
	public async init(): Promise<void> {

	}

	/**
	 * Returns a Promise that resolves with a boolean indicating if the specified device key is valid. If the Promise is
	 * resolved with `false` or is rejected, access will be denied.
	 */
	public abstract validateKey( deviceKey: string ): Promise<boolean>
}
