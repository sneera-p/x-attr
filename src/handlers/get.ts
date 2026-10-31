import { bind } from '../fire/bind';
import { createFire, emit, withQuery } from '../fire/request';
import { extractInclude } from '../modifiers/include';
import { resolveSwap, swap } from '../modifiers/swap';
import { resolveTarget } from '../modifiers/target';
import { resolveTrigger } from '../modifiers/trigger';
import { extractVals } from '../modifiers/vals';
import { subscribe, type SubscriptionError } from '../sse';
import { Verbs } from '../shared/attrs';
import { cleanup, onCleanup } from '../shared/cleanup';
import { XEvents } from '../shared/events';
import { collectValues, toQuery } from '../shared/values';
import { extractHeaders } from '../modifiers/headers';

type Reprocess = (node: Node) => void;

/** Swaps one SSE message into the element's target. A broken element reports, but never breaks the shared stream. */
function swapMessage(node: Element, html: string, reprocess: Reprocess): void {
    try {
        const target = resolveTarget(node);
        for (const inserted of swap(target, resolveSwap(node, target), html))
            reprocess(inserted);
    } catch (error) {
        setTimeout(() => { throw error; });   // still reaches the console, outside the stream's read loop
    }
}

/** Turns a stream error into the element's error event: refused for good → response error, otherwise request error. */
function reportStreamError(node: Element, url: string, { message, status, retrying }: SubscriptionError): void {
    if (!retrying && status !== undefined)
        emit(node, XEvents.RESPONSE_ERROR, { url, status });
    else
        emit(node, XEvents.REQUEST_ERROR, { url, message, status, retrying });
}

/**
 * x-trigger="sse <event>": the x-get URL (plus x-include / x-vals, read once) is a stream;
 * each <event> message is swapped in like a response.
 */
function subscribeTo(node: Element, url: string, event: string, reprocess: Reprocess): () => void {
    const streamUrl = withQuery(url, toQuery(collectValues(node, extractInclude(node), extractVals(node))));
    const unsubscribe = subscribe(
        streamUrl,
        extractHeaders(node),
        event,
        html => {
            if (!node.isConnected)
                unsubscribe();   // removed without cleanup(): leave on the next message
            else
                swapMessage(node, html, reprocess);
        },
        error => {
            if (!node.isConnected)
                unsubscribe();
            else
                reportStreamError(node, streamUrl, error);
        },
    );
    return unsubscribe;
}

/**
 * Wires an x-get element: on its trigger, fetch the URL (values in the query string)
 * and swap the response in; or, with x-trigger="sse <event>", subscribe to it as a stream.
 */
export function get(node: Element, reprocess: Reprocess): void {
    const url = node.getAttribute(Verbs.GET);
    if (url === null)
        throw new Error('get() called on an element without x-get');

    const trigger = resolveTrigger(node);
    if (trigger.kind === 'sse') {
        const unsubscribe = subscribeTo(node, url, trigger.event, reprocess);
        onCleanup(node, unsubscribe);
    } else {
        const { fire, abort } = createFire(node, url, 'GET', reprocess);
        onCleanup(node, abort);
        bind(node, trigger, () => void fire());
    }
}


// ---- tests (removed from the build) ----

describe('get', () => {
    describe('wiring', () => {
        test('throws when the element has no x-get', () => {
            document.body.innerHTML = '<button>none</button>';
            expect(() => get(document.querySelector('button')!, () => {})).toThrow(/x-get/);
        });

        test('a normal trigger fires a GET of the x-get URL and swaps the response', async () => {
            server.routes['/jobs/42'] = '<p>Job 42</p>';
            document.body.innerHTML = '<button x-get="/jobs/42" x-target="#out">go</button><div id="out"></div>';
            get(document.querySelector('button')!, () => {});
            expect(server.requested).toEqual([]);

            document.querySelector('button')!.click();
            await settle();
            expect(server.requested).toEqual(['/jobs/42']);
            expect(document.getElementById('out')!.innerHTML).toBe('<p>Job 42</p>');
        });

        test('cleanup aborts a request in flight', async () => {
            server.routes['/slow'] = { body: '<p>late</p>', delay: 10 };
            document.body.innerHTML = '<main id="m"><button x-get="/slow" x-target="#out">go</button></main><div id="out">empty</div>';
            const button = document.querySelector('button')!;
            get(button, () => {});
            button.click();
            cleanup(document.getElementById('m')!);
            await settle(20);
            expect(document.getElementById('out')!.innerHTML).toBe('empty');
        });
    });

    describe('sse', () => {
        let reprocessed: Node[];
        const reprocess = (n: Node): void => { reprocessed.push(n); };
        beforeEach(() => { reprocessed = []; });
        // Unsubscribe every element this test wired, so its streams close before the next test.
        afterEach(async () => {
            cleanup(document.body);
            await settle();
        });

        const run = async (html: string): Promise<void> => {
            document.body.innerHTML = html;
            for (const el of document.querySelectorAll('[x-get]')) get(el, reprocess);
            await settle();
        };
        const send = (text: string): void => server.streams[0]!.send(text);

        test('swaps each matching event into the target, then reprocesses it', async () => {
            server.routes['/sse'] = { stream: true };
            await run('<ul id="t" x-get="/sse" x-trigger="sse jobs" x-swap="afterbegin"></ul>');
            send('event: jobs\ndata: <li>2</li>\n\nevent: other\ndata: <li>no</li>\n\nevent: jobs\ndata: <li>3</li>\n\n');
            await settle();

            expect(document.getElementById('t')!.innerHTML).toBe('<li>3</li><li>2</li>');
            expect(reprocessed.map(n => n.nodeName)).toEqual(['LI', 'LI']);
        });

        test('elements with the same URL share one connection', async () => {
            server.routes['/sse'] = { stream: true };
            await run('<p id="a" x-get="/sse" x-trigger="sse a">-</p><p id="b" x-get="/sse" x-trigger="sse b">-</p>');
            send('event: b\ndata: B\n\nevent: a\ndata: A\n\n');
            await settle();

            expect(server.requested).toEqual(['/sse']);
            expect(document.body.textContent).toBe('AB');
        });

        test('x-include and x-vals are read once, into the stream URL', async () => {
            server.routes['/sse?lastEventId=7-0&scope=mine'] = { stream: true };
            await run('<input type="hidden" id="from" name="lastEventId" value="7-0"><p x-get="/sse" x-trigger="sse a" x-include="#from" x-vals="scope=mine"></p>');
            (document.getElementById('from') as HTMLInputElement).value = '9-0';
            await settle();

            expect(server.requested).toEqual(['/sse?lastEventId=7-0&scope=mine']);
        });

        test('outerHTML: the replacement keeps listening on the same connection', async () => {
            server.routes['/sse'] = { stream: true };
            const row = (v: string): string => `<p id="job" x-get="/sse" x-trigger="sse job" x-swap="outerHTML">${v}</p>`;
            document.body.innerHTML = row('v1');
            const reget = (n: Node): void => { if (n instanceof Element && n.hasAttribute('x-get')) get(n, reget); };
            get(document.getElementById('job')!, reget);
            await settle();

            send(`event: job\ndata: ${row('v2')}\n\n`);
            await settle();
            send(`event: job\ndata: ${row('v3')}\n\n`);
            await settle();

            expect(document.body.innerHTML).toBe(row('v3'));
            expect(server.requested).toEqual(['/sse']);
        });

        test('empty data with outerHTML removes the element', async () => {
            server.routes['/sse'] = { stream: true };
            await run('<div><p x-get="/sse" x-trigger="sse gone" x-swap="outerHTML">x</p></div>');
            send('event: gone\ndata:\n\n');
            await settle();
            expect(document.body.innerHTML).toBe('<div></div>');
        });

        test('cleanup unsubscribes: the last element gone closes the connection', async () => {
            server.routes['/sse'] = { stream: true };
            await run('<main id="m"><p x-get="/sse" x-trigger="sse a">x</p></main>');
            cleanup(document.getElementById('m')!);
            await settle();
            expect(server.streams[0]!.closed).toBe(true);
        });

        test('an element removed without cleanup leaves on its next message', async () => {
            server.routes['/sse'] = { stream: true };
            await run('<p x-get="/sse" x-trigger="sse a">x</p>');
            document.body.innerHTML = '';
            send('event: a\ndata: late\n\n');
            await settle();
            expect(server.streams[0]!.closed).toBe(true);
        });

        test('a broken element does not break the stream for the others', async () => {
            server.routes['/sse'] = { stream: true };
            await run('<p id="bad" x-get="/sse" x-trigger="sse a" x-target="#nowhere">x</p><p id="ok" x-get="/sse" x-trigger="sse a">x</p>');
            const thrown: unknown[] = [];
            const realSetTimeout = globalThis.setTimeout;
            globalThis.setTimeout = ((fn: () => void, ms?: number) => realSetTimeout(() => { try { fn(); } catch (e) { thrown.push(e); } }, ms)) as typeof setTimeout;
            try {
                send('event: a\ndata: fine\n\n');
                await settle();
            } finally {
                globalThis.setTimeout = realSetTimeout;
            }
            expect(document.getElementById('ok')!.textContent).toBe('fine');
            expect(thrown).toHaveLength(1);
            expect(server.streams[0]!.closed).toBe(false);
        });

        test('4xx → response error event; 5xx → request error event, retrying', async () => {
            const seen: string[] = [];
            const listening = new AbortController();
            const { signal } = listening;
            document.addEventListener(XEvents.RESPONSE_ERROR, e => seen.push(`response ${(e as CustomEvent).detail.status}`), { signal });
            document.addEventListener(XEvents.REQUEST_ERROR, e => seen.push(`request ${(e as CustomEvent).detail.status} ${(e as CustomEvent).detail.retrying}`), { signal });

            server.routes['/a'] = { status: 403 };
            server.routes['/b'] = { status: 503 };
            await run('<p x-get="/a" x-trigger="sse a"></p><p x-get="/b" x-trigger="sse b"></p>');

            expect(seen.sort()).toEqual(['request 503 true', 'response 403']);
            listening.abort();
        });
    });
});