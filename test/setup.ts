// Preloaded before every test file (bunfig.toml). Sets up the DOM and a fake server.
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });

/**
 * Fake server that replaces fetch in every test.
 * A route is HTML (status 200), or a spec for anything else. Unknown URLs → 404.
 * Requests honour AbortSignal like the real fetch: an aborted request rejects with AbortError.
 */
const server: FakeServer = { routes: {}, requested: [], streams: [] };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    server.requested.push(url);

    const route = server.routes[url];
    const spec = typeof route === 'string' ? { body: route } : route;

    if (spec?.delay !== undefined) {
        await new Promise(resolve => setTimeout(resolve, spec.delay));
    }
    if (init?.signal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
    }
    if (spec === undefined) {
        return new Response('not found', { status: 404 });
    }
    if (spec.fail) {
        throw new TypeError('Failed to fetch');
    }
    if (spec.stream) {
        return openStream(url, init, spec);
    }
    return new Response(spec.body ?? '', { status: spec.status ?? 200, headers: spec.headers });
}) as typeof fetch;

/** A streamed response the test pushes text into (server.streams). Abort closes it like a real fetch. */
function openStream(url: string, init: RequestInit | undefined, spec: { status?: number; headers?: Record<string, string> }): Response {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const stream: FakeStream = {
        url,
        lastEventId: new Headers(init?.headers).get('Last-Event-ID'),
        closed: false,
        send: text => { if (!stream.closed) controller.enqueue(encoder.encode(text)); },
        end: () => { if (!stream.closed) { stream.closed = true; controller.close(); } },
        fail: () => { if (!stream.closed) { stream.closed = true; controller.error(new TypeError('network error')); } },
    };
    const body = new ReadableStream<Uint8Array>({ start: c => { controller = c; } });
    init?.signal?.addEventListener('abort', () => {
        if (!stream.closed) { stream.closed = true; controller.error(new DOMException('aborted', 'AbortError')); }
    });
    server.streams.push(stream);
    return new Response(body, { status: spec.status ?? 200, headers: spec.headers });
}

/** Waits for timers and pending fetches; `ms` covers delayed routes and debounces. */
const settle = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms + 5));

/**
 * Fake IntersectionObserver: nothing is ever "visible" until a test says so.
 * viewport.reveal(el) / viewport.hide(el) call every observer watching `el`,
 * the same way the browser does when it scrolls in or out of view.
 */
class FakeIntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0];
    readonly targets = new Set<Element>();

    constructor(private readonly callback: IntersectionObserverCallback) {
        observers.add(this);
    }
    observe(el: Element): void { this.targets.add(el); }
    unobserve(el: Element): void { this.targets.delete(el); }
    disconnect(): void { this.targets.clear(); observers.delete(this); }
    takeRecords(): IntersectionObserverEntry[] { return []; }

    notify(el: Element, isIntersecting: boolean): void {
        if (!this.targets.has(el)) {
            return;
        }
        const entry = { target: el, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 } as IntersectionObserverEntry;
        this.callback([entry], this as unknown as IntersectionObserver);
    }
}

const observers = new Set<FakeIntersectionObserver>();

const viewport: FakeViewport = {
    reveal: el => { for (const o of [...observers]) o.notify(el, true); },
    hide: el => { for (const o of [...observers]) o.notify(el, false); },
    isObserved: el => [...observers].some(o => o.targets.has(el)),
};

globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;

/**
 * Fake page navigation: location.assign / location.reload record instead of leaving the page.
 * (Real browsers don't allow replacing these; happy-dom does, and only tests ever see it.)
 */
const page: FakePage = { navigated: [], reloads: 0 };
location.assign = (url: string | URL) => { page.navigated.push(String(url)); };
location.reload = () => { page.reloads++; };

Object.assign(globalThis, { server, settle, viewport, page });

// Runs before every test in every file: a clean page and a clean server.
beforeEach(() => {
    document.body.innerHTML = '';
    server.routes = {};
    for (const s of server.streams) s.end();
    server.requested = [];
    server.streams = [];
    for (const o of [...observers]) o.disconnect();
    page.navigated = [];
    page.reloads = 0;
});