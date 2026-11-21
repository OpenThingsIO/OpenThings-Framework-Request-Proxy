import { performance } from "perf_hooks";
import { AuthenticationPlugin } from "./AuthenticationPlugin";
import { Telemetry } from "./telemetry";

type Result = { status: "valid" | "invalid" | "timed_out" | "cancelled" | "busy" }
    | { status: "error"; error: unknown };

interface Job {
    key: string;
    startedAt: number;
    deadline: number;
    active: boolean;
    settled: boolean;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    detach(): void;
    resolve?: (result: Result) => void;
}

/** Bounded, FIFO admission. Client lifetime and backend lifetime are separate. */
export class AuthenticationQueue {
    private jobs = new Map<string, Job>();
    private waiting = new Map<string, Job>();
    private active = 0;
    private stopping = false;

    constructor(private readonly plugin: AuthenticationPlugin, private readonly telemetry: Telemetry,
        private readonly concurrency: number, private readonly queueLimit: number,
        private readonly timeoutMs: number) {}

    submit(key: string, signal: AbortSignal): Promise<Result> {
        if (signal.aborted || this.stopping) return Promise.resolve({ status: "cancelled" });
        if (this.jobs.has(key) || (this.active >= this.concurrency && this.waiting.size >= this.queueLimit)) {
            this.telemetry.count("authentication_busy");
            return Promise.resolve({ status: "busy" });
        }
        return new Promise(resolve => {
            const startedAt = performance.now();
            const job: Job = { key, startedAt, deadline: startedAt + this.timeoutMs,
                controller: new AbortController(), active: false, settled: false,
                timer: undefined, detach: () => {}, resolve };
            const abandon = () => this.settle(job, { status: "cancelled" });
            signal.addEventListener("abort", abandon, { once: true });
            job.detach = () => signal.removeEventListener("abort", abandon);
            job.timer = setTimeout(() => this.settle(job, { status: "timed_out" }), this.timeoutMs);
            job.timer.unref();
            this.jobs.set(key, job);
            this.waiting.set(key, job);
            this.telemetry.adjust("authQueued", 1);
            this.pump();
        });
    }

    private settle(job: Job, result: Result): void {
        if (job.settled) return;
        job.settled = true;
        clearTimeout(job.timer);
        job.detach();
        if (result.status === "cancelled" || result.status === "timed_out") {
            this.telemetry.count(result.status === "cancelled"
                ? "authentication_cancelled" : "authentication_timed_out");
            job.controller.abort();
        }
        if (!job.active) {
            if (this.waiting.delete(job.key)) this.telemetry.adjust("authQueued", -1);
            if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        }
        this.telemetry.observe("authentication", performance.now() - job.startedAt);
        const resolve = job.resolve;
        job.resolve = undefined;
        resolve?.(result);
    }

    private pump(): void {
        while (!this.stopping && this.active < this.concurrency && this.waiting.size) {
            const job = this.waiting.values().next().value as Job;
            if (performance.now() >= job.deadline) {
                this.settle(job, { status: "timed_out" });
                continue;
            }
            this.waiting.delete(job.key);
            this.telemetry.adjust("authQueued", -1);
            this.telemetry.observe("queueWait", performance.now() - job.startedAt);
            job.active = true;
            this.active++;
            this.telemetry.adjust("authActive", 1);
            // Defer invocation, then recheck: a close/deadline may have run in between.
            void Promise.resolve().then(async () => {
                if (job.controller.signal.aborted || performance.now() >= job.deadline) {
                    this.settle(job, { status: job.controller.signal.aborted ? "cancelled" : "timed_out" });
                    return;
                }
                const lookupStarted = performance.now();
                this.telemetry.count("authentication_started");
                try {
                    const valid = await this.plugin.validateKey(job.key, {
                        signal: job.controller.signal,
                        remainingMs: () => Math.max(0, job.deadline - performance.now()),
                    });
                    this.telemetry.count(valid ? "authentication_valid" : "authentication_invalid");
                    this.settle(job, performance.now() >= job.deadline
                        ? { status: "timed_out" } : { status: valid ? "valid" : "invalid" });
                } catch (error) {
                    this.telemetry.count("authentication_failed");
                    this.settle(job, performance.now() >= job.deadline
                        ? { status: "timed_out" } : { status: "error", error });
                } finally {
                    this.telemetry.observe("lookup", performance.now() - lookupStarted);
                }
            }).finally(() => {
                // Do not release a slot or same-key guard just because a socket left.
                job.active = false;
                this.active--;
                this.telemetry.adjust("authActive", -1);
                if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
                this.pump();
            });
        }
    }

    close(): void {
        this.stopping = true;
        for (const job of this.jobs.values()) this.settle(job, { status: "cancelled" });
    }
}
