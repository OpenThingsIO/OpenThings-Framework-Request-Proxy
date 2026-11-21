import { monitorEventLoopDelay, performance } from "perf_hooks";
import { Logger } from "pino";

const counters = {
    connections_opened: 0, connections_closed: 0, sessions_accepted: 0, session_cleanups: 0,
    connection_rejected: 0, duplicate_rejected: 0, policy_rejected: 0,
    authentication_started: 0, authentication_valid: 0, authentication_invalid: 0,
    authentication_failed: 0, authentication_timed_out: 0, authentication_cancelled: 0,
    authentication_busy: 0, heartbeat_expired: 0, transport_error: 0, oversized_message: 0,
    invalid_response_frame: 0, unknown_response_id: 0, forwarded_requests: 0,
    requests_settled: 0, controller_responses: 0, request_timeouts: 0,
    browser_departures: 0, send_failures: 0, response_write_failures: 0,
    rejection_forced_close: 0,
};
const gauges = { connections: 0, unaccepted: 0, closing: 0, sessions: 0,
    authActive: 0, authQueued: 0, pendingRequests: 0 };
const rejectionCounts = { "invalid path": 0, "missing device key": 0, "invalid device key": 0,
    "device key already connected": 0, "authentication unavailable": 0,
    "authentication timed out": 0, "authentication busy": 0 };
export type RejectionReason = keyof typeof rejectionCounts;

// Fixed buckets/labels: no samples, keys, URLs or per-device metric series.
class Histogram {
    private readonly bounds = [1, 5, 10, 50, 100, 500, 1000, 5000, 10_000, 60_000];
    private counts = Array(this.bounds.length + 1).fill(0) as number[];
    private count = 0;
    private sumMs = 0;
    private maxMs = 0;

    observe(ms: number): void {
        const value = Math.max(0, ms);
        const index = this.bounds.findIndex(bound => value <= bound);
        this.counts[index < 0 ? this.bounds.length : index]++;
        this.count++;
        this.sumMs += value;
        this.maxMs = Math.max(this.maxMs, value);
    }

    snapshot() {
        return { boundsMs: this.bounds.slice(), buckets: this.counts.slice(),
            count: this.count, sumMs: this.sumMs, maxMs: this.maxMs };
    }
}

export class Telemetry {
    private totals = { ...counters };
    private previous = { ...counters };
    private current = { ...gauges };
    private highWater = { ...gauges };
    private rejections = { ...rejectionCounts };
    private histograms = { authentication: new Histogram(), lookup: new Histogram(),
        queueWait: new Histogram(), request: new Histogram() };
    private readonly loop = monitorEventLoopDelay({ resolution: 20 });
    private utilization = performance.eventLoopUtilization();
    private cpu = process.cpuUsage();
    private readonly startedAt = performance.now();
    private reportedAt = this.startedAt;
    private readonly timer: ReturnType<typeof setInterval>;

    constructor(private readonly logger: Logger, intervalMs = 10_000) {
        this.loop.enable();
        this.timer = setInterval(() => this.report(), intervalMs);
        this.timer.unref();
    }

    count(name: keyof typeof counters): void { this.totals[name]++; }

    rejected(reason: RejectionReason): void {
        this.count("connection_rejected");
        this.rejections[reason]++;
    }

    adjust(name: keyof typeof gauges, change: number): void {
        this.current[name] += change;
        this.highWater[name] = Math.max(this.highWater[name], this.current[name]);
    }

    observe(name: keyof Telemetry["histograms"], ms: number): void {
        this.histograms[name].observe(ms);
    }

    snapshot() {
        return { counters: { ...this.totals }, rejections: { ...this.rejections },
            gauges: { ...this.current }, highWater: { ...this.highWater },
            latency: { authentication: this.histograms.authentication.snapshot(),
                lookup: this.histograms.lookup.snapshot(), queueWait: this.histograms.queueWait.snapshot(),
                request: this.histograms.request.snapshot() } };
    }

    report(): void {
        const now = performance.now();
        const cpuNow = process.cpuUsage();
        const utilizationNow = performance.eventLoopUtilization();
        const usage = process.memoryUsage();
        const delta = { ...this.totals };
        for (const name of Object.keys(delta) as (keyof typeof counters)[]) {
            delta[name] -= this.previous[name];
        }
        this.logger.info({ event: "proxy_stats", ...this.snapshot(), delta,
            intervalMs: now - this.reportedAt, uptimeMs: now - this.startedAt,
            memory: { rss: usage.rss, heapUsed: usage.heapUsed, heapTotal: usage.heapTotal,
                external: usage.external, arrayBuffers: usage.arrayBuffers },
            cpu: { userMicros: cpuNow.user - this.cpu.user, systemMicros: cpuNow.system - this.cpu.system },
            eventLoop: { utilization: performance.eventLoopUtilization(utilizationNow, this.utilization).utilization,
                p99Ms: this.loop.percentile(99) / 1e6, maxMs: this.loop.max / 1e6 },
        });
        this.previous = { ...this.totals };
        this.cpu = cpuNow;
        this.utilization = utilizationNow;
        this.reportedAt = now;
        this.loop.reset();
    }

    close(): void {
        clearInterval(this.timer);
        this.loop.disable();
    }
}
