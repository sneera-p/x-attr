// Test globals for in-source tests. Only these names: no `process`, no `Bun`.
// Calls to test/describe/beforeEach/afterEach are removed from the build (manualPureFunctions
// in tsdown.config.ts); server and settle are only ever used inside them.
declare global {
    const test: typeof import('bun:test').test;
    const describe: typeof import('bun:test').describe;
    const expect: typeof import('bun:test').expect;
    const beforeEach: typeof import('bun:test').beforeEach;
    const afterEach: typeof import('bun:test').afterEach;

    /** A fake response: HTML for a 200, or a spec. */
    type FakeRoute = string | {
        body?: string;
        status?: number;
        headers?: Record<string, string>;
        /** Respond after this many ms (to test races and aborts). */
        delay?: number;
        /** Fail like a network error (fetch rejects with TypeError). */
        fail?: true;
    };

    /** The fake server behind fetch in tests (test/setup.ts). Reset before every test. */
    interface FakeServer {
        /** URL (path + query, exactly as fetched) → response. */
        routes: Record<string, FakeRoute>;
        /** Every URL fetched, in order. */
        requested: string[];
    }

    const server: FakeServer;

    /** Controls the fake IntersectionObserver (test/setup.ts). Nothing is visible until revealed. */
    interface FakeViewport {
        /** Scrolls `el` into view: every observer watching it is called with isIntersecting = true. */
        reveal(el: Element): void;
        /** Scrolls `el` out of view: observers are called with isIntersecting = false. */
        hide(el: Element): void;
        /** Whether any observer is still watching `el`. */
        isObserved(el: Element): boolean;
    }
    const viewport: FakeViewport;
    /** Waits for timers and pending fetches; `ms` covers delayed routes and debounces. */
    const settle: (ms?: number) => Promise<void>;
}
export {};