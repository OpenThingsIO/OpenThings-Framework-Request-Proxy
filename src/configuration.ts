type Setting = "AUTHENTICATION_PLUGIN" | "DEVICE_KEYS" | "MYSQL_TABLE" | "MYSQL_CONNECTION_URL";

// These messages are safe to log: they name settings, never their values.
export class ConfigurationError extends Error {
    constructor(readonly setting: Setting, readonly reason: "missing" | "unsupported" | "invalid") {
        super(`${setting} is ${reason}`);
        this.name = "ConfigurationError";
    }
}

export function startupFailure(error: unknown) {
    if (error instanceof ConfigurationError) {
        return { event: "startup_failure", setting: error.setting,
            reason: error.reason, message: error.message };
    }
    const code = (error as { code?: unknown })?.code;
    const known = ["EADDRINUSE", "EADDRNOTAVAIL", "EACCES", "EMFILE", "ENFILE"];
    return { event: "startup_failure", reason: "initialization_failed",
        errorCode: typeof code === "string" && known.includes(code) ? code : undefined,
        message: "Unable to initialize proxy" };
}
