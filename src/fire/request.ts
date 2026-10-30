import { resolveSwap, swap } from '../modifiers/swap';
import { resolveTarget } from '../modifiers/target';
import { extractInclude } from '../modifiers/include';
import { extractVals } from '../modifiers/vals';
import { XEvents } from '../shared/events';
import { XHeaders } from '../shared/headers';
import { collectValues, toFormData, toQuery } from '../shared/values';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Everything one element's requests share. One object, passed to each function below. */
type RequestState = {
    node: Element;
    url: string;
    method: Method;
    reprocess: (node: Node) => void;
    /** The request in flight, if any: a new one aborts it (latest request wins). */
    inflight: AbortController | undefined;
};

/** Methods whose values go in the URL; the rest send them as the body. */
const IN_QUERY: ReadonlySet<Method> = new Set(['GET', 'DELETE']);

/** Appends params to a URL that may already have a query string. Same-origin URLs stay relative. */
export function withQuery(url: string, params: URLSearchParams): string {
    if (params.size === 0) {
        return url;
    }
    const full = new URL(url, location.href);
    for (const [key, value] of params) {
        full.searchParams.append(key, value);
    }
    return full.origin === location.origin ? full.pathname + full.search : full.href;
}

/** Dispatches a bubbling event, so one listener on document hears every element. */
export function emit(el: Element, name: string, detail: object): void {
    el.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
}


/** The URL and fetch options for one request, values read now. */
function buildRequest(state: RequestState, signal: AbortSignal): { url: string; init: RequestInit } {
    const entries = collectValues(state.node, extractInclude(state.node), extractVals(state.node));
    const headers: Record<string, string> = {
        'Accept': 'text/html',
        [XHeaders.REQUEST]: 'true',
    };
    const init: RequestInit = { method: state.method, headers, redirect: 'manual', signal };

    if (IN_QUERY.has(state.method)) {
        return { url: withQuery(state.url, toQuery(entries)), init };
    }

    init.body = toFormData(entries);   // fetch sets multipart/form-data and its boundary
    return { url: state.url, init };
}

/** What to do with a response: navigate, report, or swap it in. */
async function handleResponse(state: RequestState, response: Response, url: string, target: Element, mode: string): Promise<void> {
    if (response.type === 'opaqueredirect') {
        location.reload();   // a plain 3xx: let the page's own route redirect
        return;
    }
    const redirect = response.headers.get(XHeaders.REDIRECT);
    if (redirect !== null) {
        location.assign(redirect);
        return;
    }
    if (!response.ok) {
        emit(state.node, XEvents.RESPONSE_ERROR, { url, status: response.status });
        return;
    }

    const html = await response.text();
    if (!state.node.isConnected) {
        return;   // removed while the body was arriving
    }
    for (const inserted of swap(target, mode, html)) {
        state.reprocess(inserted);
    }
}

/** One request, start to finish. Aborts the element's previous one. */
async function fireRequest(state: RequestState): Promise<void> {
    state.inflight?.abort();
    const controller = new AbortController();
    state.inflight = controller;

    const target = resolveTarget(state.node);
    const mode = resolveSwap(state.node, target);
    const { url, init } = buildRequest(state, controller.signal);

    let response: Response;
    try {
        response = await fetch(url, init);
    } catch (error) {
        if (!controller.signal.aborted) {   // aborted = replaced by a newer request: not an error
            emit(state.node, XEvents.REQUEST_ERROR, { url, message: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    if (controller.signal.aborted || !state.node.isConnected) {
        return;   // replaced meanwhile, or the element left the page
    }

    try {
        await handleResponse(state, response, url, target, mode);
    } catch (error) {
        if (!controller.signal.aborted) throw error;   // body aborted mid-read: not an error
    }
}

/**
 * Creates the function that sends `node`'s request with `method` and swaps the response in.
 * Every call reads the element's values afresh; a call aborts the previous one still in flight.
 * Aborting is also registered with the caller through the returned `abort`.
 */
export function createFire(node: Element, url: string, method: Method, reprocess: (node: Node) => void): { fire: () => Promise<void>; abort: () => void } {
    const state: RequestState = { node, url, method, reprocess, inflight: undefined };
    return {
        fire: () => fireRequest(state),
        abort: () => state.inflight?.abort(),
    };
}

// ---- tests (removed from the build) ----

describe('createFire', () => {
    const fireOn = (html: string, selector: string, method: Method = 'GET'): { el: HTMLElement; fire: () => Promise<void>; reprocessed: Node[] } => {
        document.body.innerHTML = html;
        const el = document.querySelector<HTMLElement>(selector)!;
        const reprocessed: Node[] = [];
        const { fire } = createFire(el, el.getAttribute('x-url') ?? '/x', method, n => reprocessed.push(n));
        return { el, fire, reprocessed };
    };
    const out = (): string => document.getElementById('out')!.innerHTML;
    const caught = (name: string): unknown[] => {
        const seen: unknown[] = [];
        document.addEventListener(name, e => seen.push((e as CustomEvent).detail), { once: false, signal: listening.signal });
        return seen;
    };
    let listening: AbortController;
    beforeEach(() => { listening = new AbortController(); });
    afterEach(() => listening.abort());

    describe('the request', () => {
        test('GET puts the values in the query string', async () => {
            const { fire } = fireOn('<input name="q" value="brake pads" x-url="/search">', 'input');
            await fire();
            expect(server.requested).toEqual(['/search?q=brake+pads']);
        });
        test('DELETE puts the values in the query string too', async () => {
            const { fire } = fireOn('<button x-url="/jobs/1" x-vals="reason=dup">x</button>', 'button', 'DELETE');
            await fire();
            expect(server.requested).toEqual(['/jobs/1?reason=dup']);
        });
        test('every request sends X-Attr-Request and Accept: text/html', async () => {
            const { fire } = fireOn('<button x-url="/a">x</button>', 'button');
            await fire();
            expect(server.headers[0]!.get('X-Attr-Request')).toBe('true');
            expect(server.headers[0]!.get('Accept')).toBe('text/html');
        });
        test('values are read when the request fires', async () => {
            const { el, fire } = fireOn('<input name="q" value="old" x-url="/s">', 'input');
            (el as HTMLInputElement).value = 'new';
            await fire();
            expect(server.requested).toEqual(['/s?q=new']);
        });
    });

    describe('POST, PUT, PATCH', () => {
        let bodies: FormData[];
        let methods: string[];
        let realFetch: typeof fetch;
        beforeEach(() => {
            bodies = [];
            methods = [];
            realFetch = globalThis.fetch;
            globalThis.fetch = ((input: string, init?: RequestInit) => {
                methods.push(init?.method ?? 'GET');
                if (init?.body instanceof FormData) bodies.push(init.body);
                return realFetch(input, init);
            }) as typeof fetch;
        });
        afterEach(() => { globalThis.fetch = realFetch; });

        test('send the values as a FormData body, not in the URL', async () => {
            const { fire } = fireOn('<form><input name="plate" value="CAB-1"><button x-url="/jobs">go</button></form>', 'button', 'POST');
            await fire();
            expect(server.requested).toEqual(['/jobs']);
            expect(methods).toEqual(['POST']);
            expect([...bodies[0]!]).toEqual([['plate', 'CAB-1']]);
        });
        test('a file in the form is sent in the body', async () => {
            const { fire } = fireOn('<form><input type="file" name="photo"><button x-url="/upload">go</button></form>', 'button', 'PUT');
            const input = document.querySelector<HTMLInputElement>('input')!;
            const file = new File(['x'], 'a.png', { type: 'image/png' });
            Object.defineProperty(input, 'files', { value: [file] });
            await fire();
            expect(methods).toEqual(['PUT']);
            expect(bodies[0]!.get('photo')).toBeInstanceOf(File);
        });
        test('GET never sends the CSRF token', async () => {
            const { fire } = fireOn('<meta name="csrf-token" content="tok-1"><button x-url="/a">x</button>', 'button', 'GET');
            await fire();
            expect(server.headers[0]!.get('X-Csrf-Token')).toBeNull();
        });
        test('no token on the page: no header', async () => {
            const { fire } = fireOn('<button x-url="/a">x</button>', 'button', 'POST');
            await fire();
            expect(server.headers[0]!.get('X-Csrf-Token')).toBeNull();
        });
    });

    describe('the response', () => {
        test('2xx is swapped into the target, and the inserted nodes reprocessed', async () => {
            server.routes['/two'] = '<p id="one">1</p><p id="two">2</p>';
            const { fire, reprocessed } = fireOn('<button x-url="/two" x-target="#out">go</button><div id="out"></div>', 'button');
            await fire();
            expect(out()).toBe('<p id="one">1</p><p id="two">2</p>');
            expect(reprocessed).toEqual([document.getElementById('one')!, document.getElementById('two')!]);
        });
        test('X-Attr-Redirect navigates instead of swapping, whatever the status', async () => {
            server.routes['/secret'] = { status: 204, headers: { 'X-Attr-Redirect': '/login' } };
            const { fire } = fireOn('<button x-url="/secret" x-target="#out">go</button><div id="out">untouched</div>', 'button');
            await fire();
            expect(page.navigated).toEqual(['/login']);
            expect(out()).toBe('untouched');
        });
        test('a plain 3xx is not followed: the page reloads', async () => {
            server.routes['/old'] = { redirect: '/login' };
            const { fire } = fireOn('<button x-url="/old" x-target="#out">go</button><div id="out">untouched</div>', 'button');
            await fire();
            expect(page.reloads).toBe(1);
            expect(out()).toBe('untouched');
        });
        test('non-2xx: response error event, nothing swapped', async () => {
            const errors = caught('x-attr:response-error');
            const { fire } = fireOn('<button x-url="/missing" x-target="#out">go</button><div id="out">empty</div>', 'button');
            await fire();
            expect(errors).toEqual([{ url: '/missing', status: 404 }]);
            expect(out()).toBe('empty');
        });
        test('network failure: request error event with a message', async () => {
            server.routes['/down'] = { fail: true };
            const errors = caught('x-attr:request-error');
            const { fire } = fireOn('<button x-url="/down">go</button>', 'button');
            await fire();
            expect(errors).toEqual([{ url: '/down', message: 'Failed to fetch' }]);
        });
    });

    describe('latest request wins', () => {
        test('a newer request aborts the older one, which neither swaps nor reports', async () => {
            server.routes['/s?q=a'] = { body: 'a', delay: 30 };
            server.routes['/s?q=ab'] = 'ab';
            const errors = caught('x-attr:request-error');
            const { el, fire } = fireOn('<input name="q" value="a" x-url="/s" x-target="#out"><div id="out"></div>', 'input');
            const first = fire();
            (el as HTMLInputElement).value = 'ab';
            await fire();
            await first;
            expect(out()).toBe('ab');
            expect(errors).toEqual([]);
        });
        test('a response for an element that left the page is dropped', async () => {
            server.routes['/slow'] = { body: 'late', delay: 10 };
            const { el, fire } = fireOn('<div id="wrap"><button x-url="/slow" x-target="#out">go</button></div><div id="out">empty</div>', 'button');
            const pending = fire();
            el.parentElement!.remove();
            await pending;
            expect(out()).toBe('empty');
        });
        test('abort() cancels the request in flight', async () => {
            server.routes['/slow'] = { body: 'late', delay: 10 };
            document.body.innerHTML = '<button>go</button><div id="out">empty</div>';
            const el = document.querySelector('button')!;
            el.setAttribute('x-target', '#out');
            const { fire, abort } = createFire(el, '/slow', 'GET', () => {});
            const pending = fire();
            abort();
            await pending;
            expect(out()).toBe('empty');
        });
    });
});