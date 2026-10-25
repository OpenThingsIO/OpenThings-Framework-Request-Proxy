import { createHash } from "crypto";
import { Logger } from "pino";

export function tokenFingerprint(token: string): string {
    return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

const ENDPOINTS = new Set([
    "", "index.html", "cv", "jc", "dp", "cp", "cr", "mp", "up", "jp", "jpa",
    "co", "jo", "sp", "js", "cm", "cs", "jn", "je", "jl", "dl", "su", "cu",
    "ja", "pq", "db", "lf", "df", "jsn", "csn", "dsn", "jsl", "dsl", "jsd",
    "update", "jsap", "ccap", "jtap", "vo", "vl", "ad", "cc", "jt",
    "resetall", "clearlog", "s2id_gen",
]);

export function forwardedEndpoint(url: string): string | undefined {
    const match = /^\/forward\/v1\/[^/?]+(?:\/([^/?#]*))?/.exec(url);
    if (!match) return undefined;
    const endpoint = match[1] || "";
    // Generic IoT paths can contain secrets too. Log only recognized endpoint
    // names, dropping query strings and all subsequent path segments.
    return ENDPOINTS.has(endpoint) ? `/${endpoint}` : "/other";
}

// Limit both repeated identities and a burst of distinct, untrusted identities.
// Suppression counts are reported with the next permitted event.
export class EventLimiter {
    private entries = new Map<string, { at: number; suppressed: number }>();
    private windowStart: number;
    private emitted = 0;
    private suppressed = 0;

    constructor(
        private readonly windowMs = 60_000,
        private readonly maxEntries = 256,
        private readonly maxEvents = 100,
        private readonly now = Date.now
    ) {
        this.windowStart = now();
    }

    log(logger: Logger, level: "info" | "warn" | "debug", event: string,
        identity: string, fields: Record<string, unknown> = {}): void {
        const now = this.now();
        if (now - this.windowStart >= this.windowMs) {
            this.windowStart = now;
            this.emitted = 0;
        }
        if (this.emitted >= this.maxEvents) {
            this.suppressed++;
            return;
        }
        const key = `${event}:${identity}`;
        const entry = this.entries.get(key);
        if (entry && now - entry.at < this.windowMs) {
            entry.suppressed++;
            return;
        }
        if (!entry && this.entries.size >= this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
        }
        this.entries.set(key, { at: now, suppressed: 0 });
        this.emitted++;
        logger[level]({ ...fields, event,
            suppressed: (entry?.suppressed || 0) + this.suppressed });
        this.suppressed = 0;
    }
}

// Never serialize backend error objects: mysql errors may contain SQL and keys.
export function backendErrorCode(error: unknown): string {
    const code = (error as { code?: unknown })?.code;
    const known = new Set([
        "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND",
        "PROTOCOL_CONNECTION_LOST", "PROTOCOL_SEQUENCE_TIMEOUT", "ER_ACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR",
        "ER_NO_SUCH_TABLE", "ER_PARSE_ERROR", "ER_CON_COUNT_ERROR",
        "POOL_ENQUEUELIMIT",
    ]);
    return typeof code === "string" && known.has(code) ? code : "AUTH_BACKEND_ERROR";
}
