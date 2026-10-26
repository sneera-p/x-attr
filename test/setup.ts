// Preloaded before every test file (bunfig.toml). Sets up the DOM and a fake server.
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });

/**
 * Fake server that replaces fetch in every test.
 * A route is HTML (status 200), or a spec for anything else. Unknown URLs → 404.
 * Requests honour AbortSignal like the real fetch: an aborted request rejects with AbortError.
 */
const server: FakeServer = { routes: {}, requested: [] };

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
    return new Response(spec.body ?? '', { status: spec.status ?? 200, headers: spec.headers });
}) as typeof fetch;

/** Waits for timers and pending fetches; `ms` covers delayed routes and debounces. */
const settle = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms + 5));

Object.assign(globalThis, { server, settle });

// Runs before every test in every file: a clean page and a clean server.
beforeEach(() => {
    document.body.innerHTML = '';
    server.routes = {};
    server.requested = [];
});