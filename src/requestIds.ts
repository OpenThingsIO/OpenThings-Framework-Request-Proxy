import { randomInt } from "crypto";

export class RequestIds {
    constructor(private next = randomInt(0x10000)) {}

    allocate(pending: ReadonlyMap<string, unknown>): string | undefined {
        for (let checked = 0; checked < 0x10000; checked++) {
            const id = this.next.toString(16).padStart(4, "0");
            this.next = (this.next + 1) & 0xffff;
            if (!pending.has(id)) return id;
        }
        return undefined;
    }
}
