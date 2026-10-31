import { XEvents } from "../shared/events";
import { XHeaders } from "../shared/headers";
import { type Message, type Parser, createParser } from "./parse";

/** Identifies one SSE connection: its URL and the headers it is opened with. Made by streamKey(). */
export type StreamKey = string & { readonly __brand: 'StreamKey' };

/** Request headers for a stream, beyond the library's own. */
export type StreamHeaders = Record<string, string>;

/**
 * The key of the connection for `url` opened with `headers`. Header names are compared
 * without case and in any order, so the same headers written differently share a connection.
 */
export function streamKey(url: string, headers: StreamHeaders): StreamKey {
    const canonical = Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), value] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify([url, canonical]) as StreamKey;
}

type StreamError = {
    message: string;
    status?: number;    // HTTP status, when the server answered at all.
};

export type StreamEnd =
    | { reason: 'redirect'; url: string }       // X-Attr-Redirect header, or x:redirect event
    | { reason: 'refresh' }                     // x:refresh event, or a plain 3xx
    | { reason: 'rejected'; status: number };   // 4xx

type StreamState = {
    url: string,
    headers: StreamHeaders,
    closed: boolean,
    lastEventId: string | null,
    retry: {
        /**
         * backoff: grows on failure, resets on connect
         * server: set by the server's `retry:`, fixed from then on
        */
        type: 'backoff' | 'server',
        delay: number,
    }
    controller: AbortController | null,
    timer: ReturnType<typeof setTimeout> | undefined,
};

type StreamOutcome =
    | { kind: 'redirect'; url: string }      // X-Attr-Redirect
    | { kind: 'reload' }                     // opaqueredirect (plain 3xx)
    | { kind: 'stop'; status: number }       // 4xx
    | { kind: 'retry'; status?: number }     // 5xx, no body
    | { kind: 'read' };                      // 2xx with a body

export type StreamCallbacks = {
    onMessage: (message: Message) => void,
    onId: (id: string) => void,
    onError: (error: StreamError) => void,
    onEnd: (end: StreamEnd) => void,
};


export type StreamOptions = {
    headers: StreamHeaders;
    lastEventId?: string; // resume from this id (failover, or the page's #sse-from)
};

const DELAY = {
    MIN: 1000,
    MAX: 30000,
} as const;

/** 
 * The headers of one connect attempt:
 *  - Accept
 *  - X-Attr-Request
 *  - Last-Event-ID (once an id is known)
 */
function headers({ headers, lastEventId }: StreamState): Record<string, string> {
    const list: Record<string, string> = {
        ...headers,
        'Accept': 'text/event-stream',
        [XHeaders.REQUEST]: 'true',
    };

    if (lastEventId !== null)
        list[XHeaders.LAST_EVENT_ID] = lastEventId;

    return list;
}

function classify(response: Response): StreamOutcome {
    // A plain 3xx under redirect: 'manual': no status, no headers to read
    if (response.type === 'opaqueredirect') {
        return { kind: 'reload' };
    }

    const redirect = response.headers.get(XHeaders.REDIRECT);
    if (redirect !== null)
        return { kind: 'redirect', url: redirect };

    if (response.status >= 400 && response.status < 500)
        return { kind: 'stop', status: response.status };

    if (!response.ok || response.body === null)
        return { kind: 'retry', status: response.status };

    return { kind: 'read' };
}

/** 
 * The wait before the next attempt 
 * A backoff delay doubles (up to the cap) for the attempt after. 
 */
function nextWait(retry: StreamState['retry']): number {
    const wait = retry.delay;
    if (retry.type === 'backoff')
        retry.delay = Math.min(retry.delay * 2, DELAY.MAX);
    return wait;
}

/** 
 * After a successful connect, 
 *  backoff starts over
 *  server-set delay stays. 
 */
function resetWait(retry: StreamState['retry']): void {
    if (retry.type === 'backoff')
        retry.delay = DELAY.MIN;
}

/** 
 * Stops everything: 
 *  - no more events, 
 *  - no reconnect, the current attempt aborted. 
 * Safe to call twice. 
 */
function closeStream(state: StreamState): void {
    clearTimeout(state.timer);
    state.timer = undefined;
    state.closed = true;
    state.controller?.abort();
}

/**
 * The only way the stream ends for good on the server's say-so: 
 *  - closes it, 
 *  - then reports why.
 * Does nothing if the stream is already closed, so onEnd is called at most once.
 */
function endStream(state: StreamState, { onEnd }: StreamCallbacks, end: StreamEnd): void {
    if (state.closed)
        return;

    closeStream(state);
    onEnd(end);
}

/** 
 * Reports a failure and schedules the next attempt. 
 * Does nothing once the stream is closed. 
 */
function scheduleRetry(state: StreamState, { onError }: StreamCallbacks, connect: () => Promise<void>, error: StreamError): void {
    if (state.closed)
        return;

    onError(error);
    state.timer = setTimeout(() => void connect(), nextWait(state.retry));
}

/** 
 * One parsed event: 
 *  - reserved ones end the stream, 
 *  - the rest go to onMessage. 
 * Dropped once closed. 
 */
function handleEvent(state: StreamState, callbacks: StreamCallbacks, message: Message): void {
    // The rest of a chunk can still be parsed after the stream closed: drop it.
    if (state.closed)
        return;

    switch (message.event) {
        case XEvents.REDIRECT:
            endStream(state, callbacks, { reason: 'redirect', url: message.data });
            break;

        case XEvents.REFRESH:
            endStream(state, callbacks, { reason: 'refresh' });
            break;

        default:
            callbacks.onMessage(message);
            break;
    }
}

/** 
 * An Error's message, or anything else as a string: plain data, 
 * safe to postMessage. 
 */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the body until it ends, feeding each chunk to the parser.
 * Resolves when the server ends the response, or once the stream is closed.
 * Rejects when the connection breaks (or is aborted).
 */
async function readBody(body: ReadableStream<Uint8Array>, parser: Parser, state: StreamState): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    while (true) {
        const { done, value } = await reader.read();
        if (done || state.closed)
            return;
        parser.feed(decoder.decode(value, { stream: true }));
    }
}

/** 
 * One connect attempt, start to finish: 
 *  - request, 
 *  - decide, 
 *  - then end, retry or read. 
 */
async function connectStream(state: StreamState, callbacks: StreamCallbacks, parser: Parser, retry: (error: StreamError) => void): Promise<void> {
    state.controller = new AbortController();

    let response: Response;
    try {
        response = await fetch(state.url, {
            headers: headers(state),
            redirect: 'manual',
            signal: state.controller.signal,
        });
    } catch (error) {
        retry({ message: errorMessage(error) });   // no response at all; after close() this does nothing
        return;
    }

    if (state.closed)
        return;

    const outcome = classify(response);
    switch (outcome.kind) {
        case 'redirect':
            endStream(state, callbacks, { reason: 'redirect', url: outcome.url });
            return;

        case 'reload':
            endStream(state, callbacks, { reason: 'refresh' });
            return;

        case 'stop':
            endStream(state, callbacks, { reason: 'rejected', status: outcome.status });
            return;

        case 'retry':
            retry({ message: `SSE ${state.url} answered ${outcome.status}`, status: outcome.status });
            return;

        case 'read':
            break;
    }

    resetWait(state.retry);
    parser.reset();

    try {
        await readBody(response.body!, parser, state);
    } catch (error) {
        retry({ message: errorMessage(error) });
        return;
    }

    retry({ message: `SSE ${state.url} ended` });
}

export function open(url: string, callbacks: StreamCallbacks, options: StreamOptions = { headers: {} }): () => void {
    const state: StreamState = {
        url: url,
        headers: options.headers,
        closed: false,
        lastEventId: options.lastEventId ?? null,
        retry: { type: 'backoff', delay: DELAY.MIN },
        controller: null,
        timer: undefined,
    };

    const parser = createParser({
        onEvent: message => handleEvent(state, callbacks, message),
        onId: id => {
            if (state.closed)
                return;   // the rest of a chunk after close: not ours to report
            state.lastEventId = id;
            callbacks.onId(id);
        },
        onRetry: ms => {
            state.retry = { type: 'server', delay: ms };
        },
    });

    const connect = () => connectStream(state, callbacks, parser, retry);
    const retry = (error: StreamError) => scheduleRetry(state, callbacks, connect, error);

    void connect();
    return () => closeStream(state);
}


// ---- tests (removed from the build) ----

describe('stream', () => {
 
    const state = (overrides: Partial<StreamState> = {}): StreamState => ({
        url: '/sse',
        headers: {},
        closed: false,
        lastEventId: null,
        controller: null,
        timer: undefined,
        retry: {
            type: 'backoff',
            delay: DELAY.MIN
        },
        ...overrides,
    });
 
    describe('pure helpers', () => {
 
        describe('streamKey', () => {
            test('the same URL and headers give the same key, whatever the order and case of names', () => {
                expect(streamKey('/live', { 'X-Tenant': '7', 'X-A': '1' })).toBe(streamKey('/live', { 'x-a': '1', 'x-tenant': '7' }));
            });
            test('different header values give different keys', () => {
                expect(streamKey('/live', { 'X-Tenant': '7' })).not.toBe(streamKey('/live', { 'X-Tenant': '9' }));
            });
            test('different URLs give different keys', () => {
                expect(streamKey('/a', {})).not.toBe(streamKey('/b', {}));
            });
            test('no headers is its own key, different from any header set', () => {
                expect(streamKey('/live', {})).not.toBe(streamKey('/live', { 'X-A': '' }));
            });
            test('values cannot run into each other', () => {
                expect(streamKey('/live', { a: 'b,c' })).not.toBe(streamKey('/live', { a: 'b', c: '' }));
            });
        });
 
        describe('headers', () => {
            test('first connect: Accept and X-Attr-Request, no Last-Event-ID', () => {
                expect(headers(state())).toEqual({
                    'Accept': 'text/event-stream',
                    'X-Attr-Request': 'true',
                });
            });
            test('once an id is known, it is sent as Last-Event-ID', () => {
                expect(headers(state({ lastEventId: '17-0' }))['Last-Event-Id']).toBe('17-0');
            });
            test('an empty id is still an id, and is sent', () => {
                expect(headers(state({ lastEventId: '' }))['Last-Event-Id']).toBe('');
            });
            test('the stream\'s own headers are sent too', () => {
                expect(headers(state({ headers: { 'X-Tenant': '7' } }))['X-Tenant']).toBe('7');
            });
            test('the library\'s headers win over the stream\'s', () => {
                expect(headers(state({ headers: { 'Accept': 'text/html' } }))['Accept']).toBe('text/event-stream');
            });
        });
 
        describe('classify', () => {
            const stream = (): ReadableStream => new ReadableStream();
            const opaque = (): Response => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), body: null }) as unknown as Response;
 
            test('2xx with a body → read', () => {
                expect(classify(new Response(stream(), { status: 200 }))).toEqual({ kind: 'read' });
            });
            test('a plain 3xx (opaque redirect) → reload', () => {
                expect(classify(opaque())).toEqual({ kind: 'reload' });
            });
            test('X-Attr-Redirect → redirect, whatever the status', () => {
                for (const status of [200, 204, 401, 500]) {
                    const response = new Response(null, { status, headers: { 'X-Attr-Redirect': '/login' } });
                    expect(classify(response)).toEqual({ kind: 'redirect', url: '/login' });
                }
            });
            test('4xx → stop, with the status', () => {
                expect(classify(new Response(null, { status: 403 }))).toEqual({ kind: 'stop', status: 403 });
                expect(classify(new Response(null, { status: 404 }))).toEqual({ kind: 'stop', status: 404 });
            });
            test('5xx → retry, with the status', () => {
                expect(classify(new Response(null, { status: 503 }))).toEqual({ kind: 'retry', status: 503 });
            });
            test('2xx without a body (204) → retry', () => {
                expect(classify(new Response(null, { status: 204 }))).toEqual({ kind: 'retry', status: 204 });
            });
        });
 
        describe('nextWait', () => {
            test('backoff: returns the current delay, then doubles it', () => {
                const retry = state().retry;
                expect([nextWait(retry), nextWait(retry), nextWait(retry)]).toEqual([1000, 2000, 4000]);
                expect(retry.delay).toBe(8000);
            });
            test('backoff: never grows past the cap', () => {
                const retry = { type: 'backoff' as const, delay: 20000 };
                expect([nextWait(retry), nextWait(retry), nextWait(retry)]).toEqual([20000, 30000, 30000]);
            });
            test('server: always the same delay', () => {
                const retry = { type: 'server' as const, delay: 5000 };
                expect([nextWait(retry), nextWait(retry)]).toEqual([5000, 5000]);
                expect(retry.delay).toBe(5000);
            });
        });
 
        describe('resetWait', () => {
            test('backoff starts over', () => {
                const retry = { type: 'backoff' as const, delay: 16000 };
                resetWait(retry);
                expect(retry.delay).toBe(1000);
            });
            test('a server delay stays', () => {
                const retry = { type: 'server' as const, delay: 5000 };
                resetWait(retry);
                expect(retry.delay).toBe(5000);
            });
        });
    });
 
    describe('effects', () => {
        /** Records every callback. */
        const recorder = (): StreamCallbacks & { messages: Message[]; ids: string[]; errors: StreamError[]; ends: StreamEnd[] } => {
            const out = { messages: [] as Message[], ids: [] as string[], errors: [] as StreamError[], ends: [] as StreamEnd[] };
            return {
                ...out,
                onMessage: m => out.messages.push(m),
                onId: id => out.ids.push(id),
                onError: e => out.errors.push(e),
                onEnd: e => out.ends.push(e),
            };
        };
 
        describe('closeStream', () => {
            test('marks the stream closed and aborts the current attempt', () => {
                const controller = new AbortController();
                const s = state({ controller });
                closeStream(s);
                expect(s.closed).toBe(true);
                expect(controller.signal.aborted).toBe(true);
            });
            test('cancels a scheduled reconnect', async () => {
                let ran = false;
                const s = state({ timer: setTimeout(() => { ran = true; }, 5) });
                closeStream(s);
                await settle(10);
                expect(ran).toBe(false);
                expect(s.timer).toBeUndefined();
            });
            test('is safe with nothing running, and safe to call twice', () => {
                const s = state();
                closeStream(s);
                closeStream(s);
                expect(s.closed).toBe(true);
            });
        });
 
        describe('endStream', () => {
            test('closes the stream, then reports why', () => {
                const s = state({ controller: new AbortController() });
                const got = recorder();
                endStream(s, got, { reason: 'rejected', status: 403 });
                expect(s.closed).toBe(true);
                expect(s.controller!.signal.aborted).toBe(true);
                expect(got.ends).toEqual([{ reason: 'rejected', status: 403 }]);
            });
            test('the stream is already closed when onEnd runs', () => {
                const s = state();
                let closedDuringOnEnd: boolean | undefined;
                endStream(s, { ...recorder(), onEnd: () => { closedDuringOnEnd = s.closed; } }, { reason: 'refresh' });
                expect(closedDuringOnEnd).toBe(true);
            });
            test('onEnd is called at most once', () => {
                const s = state();
                const got = recorder();
                endStream(s, got, { reason: 'refresh' });
                endStream(s, got, { reason: 'redirect', url: '/login' });
                expect(got.ends).toEqual([{ reason: 'refresh' }]);
            });
            test('a stream the caller closed does not report an end', () => {
                const s = state();
                const got = recorder();
                closeStream(s);
                endStream(s, got, { reason: 'refresh' });
                expect(got.ends).toEqual([]);
            });
        });
 
        describe('scheduleRetry', () => {
            test('reports the error, then connects again after the wait', async () => {
                const s = state({ retry: { type: 'server', delay: 5 } });
                const got = recorder();
                let connects = 0;
                scheduleRetry(s, got, async () => { connects++; }, { message: 'down', status: 503 });
 
                expect(got.errors).toEqual([{ message: 'down', status: 503 }]);
                expect(connects).toBe(0);
                await settle(5);
                expect(connects).toBe(1);
            });
            test('advances the backoff', () => {
                const s = state();
                scheduleRetry(s, recorder(), async () => { }, { message: 'x' });
                expect(s.retry.delay).toBe(2000);
                closeStream(s);
            });
            test('the reconnect can be cancelled through state.timer', async () => {
                const s = state({ retry: { type: 'server', delay: 5 } });
                let connects = 0;
                scheduleRetry(s, recorder(), async () => { connects++; }, { message: 'x' });
                closeStream(s);
                await settle(10);
                expect(connects).toBe(0);
            });
            test('once closed: no error reported, nothing scheduled', async () => {
                const s = state({ retry: { type: 'server', delay: 5 } });
                const got = recorder();
                let connects = 0;
                closeStream(s);
                scheduleRetry(s, got, async () => { connects++; }, { message: 'x' });
                await settle(10);
                expect(got.errors).toEqual([]);
                expect(connects).toBe(0);
                expect(s.timer).toBeUndefined();
            });
        });
 
        describe('handleEvent', () => {
            test('ordinary events go to onMessage', () => {
                const s = state();
                const got = recorder();
                handleEvent(s, got, { event: 'job:1', data: '<li>a</li>' });
                expect(got.messages).toEqual([{ event: 'job:1', data: '<li>a</li>' }]);
                expect(s.closed).toBe(false);
            });
            test('the redirect event ends the stream with its data as the URL', () => {
                const s = state();
                const got = recorder();
                handleEvent(s, got, { event: XEvents.REDIRECT, data: '/login' });
                expect(got.ends).toEqual([{ reason: 'redirect', url: '/login' }]);
                expect(got.messages).toEqual([]);
                expect(s.closed).toBe(true);
            });
            test('the refresh event ends the stream; its data is ignored', () => {
                const s = state();
                const got = recorder();
                handleEvent(s, got, { event: XEvents.REFRESH, data: 'anything' });
                expect(got.ends).toEqual([{ reason: 'refresh' }]);
                expect(got.messages).toEqual([]);
            });
            test('after the stream closed, every event is dropped', () => {
                const s = state();
                const got = recorder();
                handleEvent(s, got, { event: XEvents.REFRESH, data: '' });
                handleEvent(s, got, { event: 'job:1', data: 'late' });
                handleEvent(s, got, { event: XEvents.REDIRECT, data: '/x' });
                expect(got.messages).toEqual([]);
                expect(got.ends).toEqual([{ reason: 'refresh' }]);
            });
        });
    });
 
    describe('readBody', () => {
        const body = (...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> => new ReadableStream({
            start(c) {
                for (const chunk of chunks) c.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
                c.close();
            },
        });
        const collect = (): { parser: Parser; events: Message[] } => {
            const events: Message[] = [];
            return { events, parser: createParser({ onEvent: m => events.push(m), onId: () => {}, onRetry: () => {} }) };
        };
 
        test('feeds every chunk to the parser and resolves when the body ends', async () => {
            const { parser, events } = collect();
            await readBody(body('data: a\n\n', 'data: b\n\n'), parser, state());
            expect(events.map(e => e.data)).toEqual(['a', 'b']);
        });
        test('a multi-byte character split across chunks survives', async () => {
            const { parser, events } = collect();
            const bytes = new TextEncoder().encode('data: é\n\n');   // é is 2 bytes
            const cut = bytes.indexOf(0xc3) + 1;
            await readBody(body(bytes.slice(0, cut), bytes.slice(cut)), parser, state());
            expect(events.map(e => e.data)).toEqual(['é']);
        });
        test('stops feeding once the stream is closed', async () => {
            const { parser, events } = collect();
            await readBody(body('data: a\n\n'), parser, state({ closed: true }));
            expect(events).toEqual([]);
        });
        test('rejects when the connection breaks', async () => {
            const { parser } = collect();
            const broken = new ReadableStream<Uint8Array>({ start(c) { c.error(new TypeError('network error')); } });
            await expect(readBody(broken, parser, state())).rejects.toThrow(/network error/);
        });
    });
 
    describe('open', () => {
        let got: StreamCallbacks & { messages: Message[]; ids: string[]; errors: StreamError[]; ends: StreamEnd[] };
        let close: () => void;
 
        beforeEach(() => {
            const out = { messages: [] as Message[], ids: [] as string[], errors: [] as StreamError[], ends: [] as StreamEnd[] };
            got = { ...out, onMessage: m => out.messages.push(m), onId: id => out.ids.push(id), onError: e => out.errors.push(e), onEnd: e => out.ends.push(e) };
            close = () => {};
        });
        afterEach(() => close());
 
        const start = (options?: StreamOptions): void => { close = open('/sse', got, options); };
        const stream = (i = 0): FakeStream => server.streams[i]!;
 
        test('delivers events and ids as they arrive', async () => {
            server.routes['/sse'] = { stream: true };
            start();
            await settle();
            stream().send('id: 1-0\nevent: a\ndata: x\n\n');
            await settle();
            expect(got.messages).toEqual([{ event: 'a', data: 'x' }]);
            expect(got.ids).toEqual(['1-0']);
            expect(got.errors).toEqual([]);
        });
 
        test('sends Accept, X-Attr-Request, and options.lastEventId on the first connect', async () => {
            server.routes['/sse'] = { stream: true };
            start({ headers: {}, lastEventId: '7-0' });
            await settle();
            expect(server.headers[0]!.get('Accept')).toBe('text/event-stream');
            expect(server.headers[0]!.get('X-Attr-Request')).toBe('true');
            expect(stream().lastEventId).toBe('7-0');
        });
 
        test('sends options.headers on every connect', async () => {
            server.routes['/sse'] = { stream: true };
            start({ headers: { 'X-Tenant': '7' } });
            await settle();
            stream().send('retry: 10\n\n');
            await settle();
            stream().end();
            await settle(10);
            expect(server.headers.map(h => h.get('X-Tenant'))).toEqual(['7', '7']);
        });
 
        test('reconnects after the stream ends, resuming from the last id', async () => {
            server.routes['/sse'] = { stream: true };
            start();
            await settle();
            stream().send('retry: 10\nid: 5-0\ndata: x\n\n');
            await settle();
            stream().end();
            await settle(10);
            expect(got.errors).toEqual([{ message: 'SSE /sse ended' }]);
            expect(stream(1).lastEventId).toBe('5-0');
        });
 
        test('reconnects after the connection breaks', async () => {
            server.routes['/sse'] = { stream: true };
            start();
            await settle();
            stream().send('retry: 10\n\n');
            await settle();
            stream().fail();
            await settle(10);
            expect(got.errors).toHaveLength(1);
            expect(server.streams).toHaveLength(2);
        });
 
        test('5xx retries with the status; a network failure retries without one', async () => {
            server.routes['/sse'] = { status: 503 };
            start();
            await settle();
            expect(got.errors).toEqual([{ message: 'SSE /sse answered 503', status: 503 }]);
            close();
 
            server.routes['/b'] = { fail: true };
            close = open('/b', got);
            await settle();
            expect(got.errors[1]!.status).toBeUndefined();
            expect(typeof got.errors[1]!.message).toBe('string');
        });
 
        test('4xx ends the stream: onEnd rejected, no error, no retry', async () => {
            server.routes['/sse'] = { status: 403 };
            start();
            await settle(1100);
            expect(got.ends).toEqual([{ reason: 'rejected', status: 403 }]);
            expect(got.errors).toEqual([]);
            expect(server.requested).toEqual(['/sse']);
        });
 
        test('X-Attr-Redirect ends the stream with the URL; nothing navigates', async () => {
            server.routes['/sse'] = { status: 204, headers: { 'X-Attr-Redirect': '/login' } };
            start();
            await settle();
            expect(got.ends).toEqual([{ reason: 'redirect', url: '/login' }]);
            expect(page.navigated).toEqual([]);
        });
 
        test('a plain 3xx ends the stream as refresh; nothing reloads', async () => {
            server.routes['/sse'] = { redirect: '/login' };
            start();
            await settle();
            expect(got.ends).toEqual([{ reason: 'refresh' }]);
            expect(page.reloads).toBe(0);
        });
 
        test('the redirect event ends the stream; the rest of the chunk is dropped', async () => {
            server.routes['/sse'] = { stream: true };
            start();
            await settle();
            stream().send(`event: ${XEvents.REDIRECT}\ndata: /login\n\nid: 9-0\ndata: late\n\n`);
            await settle();
            expect(got.ends).toEqual([{ reason: 'redirect', url: '/login' }]);
            expect(got.messages).toEqual([]);
            expect(got.ids).toEqual([]);
            expect(stream().closed).toBe(true);
        });
 
        test('close() is quiet: no error, no end, no reconnect', async () => {
            server.routes['/sse'] = { stream: true };
            start();
            await settle();
            close();
            await settle(1100);
            expect(stream().closed).toBe(true);
            expect(got.errors).toEqual([]);
            expect(got.ends).toEqual([]);
            expect(server.requested).toEqual(['/sse']);
        });
    });
});