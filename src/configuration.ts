type Setting = "AUTHENTICATION_PLUGIN" | "DEVICE_KEYS" | "MYSQL_TABLE" | "MYSQL_CONNECTION_URL"
    | "WEBSOCKET_MAX_PAYLOAD_BYTES";

// These messages are safe to log: they name settings, never their values.
export class ConfigurationError extends Error {
    constructor(readonly setting: Setting, readonly reason: "missing" | "unsupported" | "invalid") {
        super(`${setting} is ${reason}`);
        this.name = "ConfigurationError";
    }
}

// Report names, never configuration values (which may contain credentials).
export function boundedInteger(setting: Setting, value: unknown, fallback: number, maximum: number): number {
    if (value === undefined) return fallback;
    const parsed = typeof value === "number" ? value
        : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
        throw new ConfigurationError(setting, "invalid");
    }
    return parsed;
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
