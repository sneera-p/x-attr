export type Message = {
    event: string;
    data: string;
};

export type StreamError = {
    error: unknown;
    /** HTTP status, when the server answered at all. */
    status?: number;
    /** False means the stream is closed for good; true means a reconnect is scheduled. */
    retrying: boolean;
};

const FIRST_DELAY = 1000;
const MAX_DELAY = 30000;

/**
 * Opens a connection to an SSE endpoint and keeps it open.
 *
 * - Reconnects on network errors, 5xx and stream end: waits 1s, doubling up to 30s,
 *   or the server's `retry:` value. A successful connect resets the wait.
 *   Reconnects send `Last-Event-ID` so the server can replay what was missed.
 * - 4xx: closes for good (`retrying: false`).
 * - `X-Redirect` header on connect, or an `x:redirect` event: closes and navigates.
 * - `x:refresh` event: closes and reloads the page.
 * Reserved `x:` events never reach `onMessage`.
 * `onEnd` is called once when the stream closes for good on the server's say-so
 * (4xx, X-Redirect, x:redirect, x:refresh); never after the caller's own close().
 * 
 * @param url SSE endpoint URL
 * @param onMessage Called with each event sent
 * @param onError Called with every error of the stream
 * @param onEnd Closed for good by the server's instruction, not by the caller
 *
 * @returns Function to close the connection (safe to call twice)
 *
 * eg:
 *  const close = open('/staff/updates', msg => console.log(msg), err => console.log(err), () => console.log('ended'));
 */
export function open(
    url: string,
    onMessage: (message: Message) => void,
    onError: (error: StreamError) => void,
    onEnd: () => void,
): () => void {
    let closed = false;
    let lastEventId: string | null = null;
    let delay = FIRST_DELAY;
    let serverRetry: number | null = null;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const close = (): void => {
        closed = true;
        clearTimeout(timer);
        controller?.abort();
    };

    const retry = (error: unknown, status?: number): void => {
        if (closed) {
            return;
        }
        onError({ error, status, retrying: true });
        const wait = serverRetry ?? delay;
        delay = Math.min(delay * 2, MAX_DELAY);
        timer = setTimeout(() => void connect(), wait);
    };

    const parser = createParser({
        onEvent: message => {
            // The rest of a chunk can still be parsed after close(): drop it.
            if (closed) {
                return;
            }
            if (message.event === 'x:redirect') {
                close();
                onEnd();
                location.assign(message.data);
            } else if (message.event === 'x:refresh') {
                close();
                onEnd();
                location.reload();
            } else {
                onMessage(message);
            }
        },
        onId: id => { lastEventId = id; },
        onRetry: ms => { serverRetry = ms; },
    });

    const connect = async (): Promise<void> => {
        controller = new AbortController();
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (lastEventId !== null) {
            headers['Last-Event-ID'] = lastEventId;
        }

        let response: Response;
        try {
            response = await fetch(url, { headers, signal: controller.signal });
        } catch (error) {
            retry(error);
            return;
        }
        if (closed) {
            return;
        }

        const redirect = response.headers.get('X-Redirect');
        if (redirect !== null) {
            close();
            onEnd();
            location.assign(redirect);
            return;
        }
        if (response.status >= 400 && response.status < 500) {
            close();
            onEnd();
            onError({ error: new Error(`SSE ${url} answered ${response.status}`), status: response.status, retrying: false });
            return;
        }
        if (!response.ok || response.body === null) {
            retry(new Error(`SSE ${url} answered ${response.status}`), response.status);
            return;
        }

        delay = FIRST_DELAY;
        parser.reset();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done || closed) {
                    break;
                }
                parser.feed(decoder.decode(value, { stream: true }));
            }
        } catch (error) {
            retry(error);
            return;
        }
        retry(new Error(`SSE ${url} ended`));
    };

    void connect();
    return close;
}

type ParserCallbacks = {
    onEvent: (message: Message) => void;
    onId: (id: string) => void;
    onRetry: (ms: number) => void;
};

/**
 * The SSE wire format (WHATWG HTML §9.2.6), fed in arbitrary chunks.
 * Lines end in \r\n, \n or \r; a blank line dispatches the event built so far.
 */
function createParser(callbacks: ParserCallbacks): { feed: (chunk: string) => void; reset: () => void } {
    let buffer = '';
    let event = '';
    let data = '';

    const reset = (): void => {
        buffer = '';
        event = '';
        data = '';
    };

    const line = (text: string): void => {
        if (text === '') {
            if (data !== '') {
                callbacks.onEvent({ event: event || 'message', data: data.slice(0, -1) });
            }
            event = '';
            data = '';
            return;
        }
        if (text.startsWith(':')) {
            return;
        }
        const colon = text.indexOf(':');
        const field = colon === -1 ? text : text.slice(0, colon);
        let value = colon === -1 ? '' : text.slice(colon + 1);
        if (value.startsWith(' ')) {
            value = value.slice(1);
        }
        switch (field) {
            case 'event': event = value; break;
            case 'data': data += value + '\n'; break;
            case 'id': if (!value.includes('\0')) callbacks.onId(value); break;
            case 'retry': if (/^\d+$/.test(value)) callbacks.onRetry(Number(value)); break;
        }
    };

    const feed = (chunk: string): void => {
        buffer += chunk;
        for (;;) {
            const end = buffer.search(/\r\n|\n|\r/);
            if (end === -1) {
                return;
            }
            // A lone \r at the end may be the first half of \r\n: wait for the next chunk.
            if (buffer[end] === '\r' && end === buffer.length - 1) {
                return;
            }
            const size = buffer.startsWith('\r\n', end) ? 2 : 1;
            line(buffer.slice(0, end));
            buffer = buffer.slice(end + size);
        }
    };

    return { feed, reset };
}

// ---- tests (removed from the build) ----

describe('createParser', () => {
    const parse = (...chunks: string[]): { events: Message[]; ids: string[]; retries: number[] } => {
        const out = { events: [] as Message[], ids: [] as string[], retries: [] as number[] };
        const parser = createParser({
            onEvent: m => out.events.push(m),
            onId: id => out.ids.push(id),
            onRetry: ms => out.retries.push(ms),
        });
        for (const chunk of chunks) parser.feed(chunk);
        return out;
    };

    test('a named event', () => {
        expect(parse('event: job:1\ndata: <p>a</p>\n\n').events).toEqual([{ event: 'job:1', data: '<p>a</p>' }]);
    });
    test('no event field means "message"', () => {
        expect(parse('data: x\n\n').events).toEqual([{ event: 'message', data: 'x' }]);
    });
    test('several data lines join with \\n', () => {
        expect(parse('data: <ul>\ndata: <li>a</li>\ndata: </ul>\n\n').events[0]!.data).toBe('<ul>\n<li>a</li>\n</ul>');
    });
    test('only one leading space is stripped; no space is fine', () => {
        expect(parse('data:  two\n\ndata:none\n\n').events.map(e => e.data)).toEqual([' two', 'none']);
    });
    test('no blank line yet means no event', () => {
        expect(parse('event: a\ndata: x\n').events).toEqual([]);
    });
    test('an event without data is not dispatched, and its name does not leak', () => {
        expect(parse('event: a\n\ndata: x\n\n').events).toEqual([{ event: 'message', data: 'x' }]);
    });
    test('empty data line dispatches an empty string (outerHTML delete)', () => {
        expect(parse('event: a\ndata:\n\n').events).toEqual([{ event: 'a', data: '' }]);
    });
    test('comments (heartbeats) are ignored', () => {
        expect(parse(': ping\n\n').events).toEqual([]);
    });
    test('chunks can split anywhere', () => {
        expect(parse('ev', 'ent: a\nda', 'ta: x', '\n', '\n').events).toEqual([{ event: 'a', data: 'x' }]);
    });
    test('\\r\\n and \\r line endings, \\r\\n split across chunks', () => {
        expect(parse('data: a\r\n\r\ndata: b\r\rdata: c\r', '\n\r\n').events.map(e => e.data)).toEqual(['a', 'b', 'c']);
    });
    test('id and retry', () => {
        const out = parse('id: 1700-0\nretry: 50\nretry: soon\ndata: x\n\n');
        expect(out.ids).toEqual(['1700-0']);
        expect(out.retries).toEqual([50]);
    });
    test('unknown fields are ignored', () => {
        expect(parse('foo: bar\ndata: x\n\n').events).toEqual([{ event: 'message', data: 'x' }]);
    });
});

describe('open', () => {
    let messages: Message[];
    let errors: StreamError[];
    let ends: number;
    let close: () => void;

    beforeEach(() => {
        messages = [];
        errors = [];
        ends = 0;
        close = () => {};
    });
    afterEach(() => close());

    const start = (url = '/sse'): void => {
        close = open(url, m => messages.push(m), e => errors.push(e), () => ends++);
    };
    const stream = (i = 0): FakeStream => server.streams[i]!;

    test('delivers events as they arrive', async () => {
        server.routes['/sse'] = { stream: true };
        start();
        await settle();
        stream().send('event: a\ndata: 1\n\n');
        await settle();
        stream().send('event: b\ndata: 2\n\n');
        await settle();

        expect(messages).toEqual([{ event: 'a', data: '1' }, { event: 'b', data: '2' }]);
        expect(errors).toEqual([]);
    });

    test('close() aborts the stream and nothing more arrives', async () => {
        server.routes['/sse'] = { stream: true };
        start();
        await settle();
        close();
        await settle();

        expect(stream().closed).toBe(true);
        expect(errors).toEqual([]);
        expect(ends).toBe(0);
        expect(server.requested).toEqual(['/sse']);
    });

    test('the first connect has no Last-Event-ID', async () => {
        server.routes['/sse'] = { stream: true };
        start();
        await settle();
        expect(stream().lastEventId).toBeNull();
    });

    test('reconnects after the stream ends, sending the last id', async () => {
        server.routes['/sse'] = { stream: true };
        start();
        await settle();
        stream().send('retry: 10\nid: 5-0\ndata: x\n\n');
        await settle();
        stream().end();
        await settle(10);

        expect(errors).toHaveLength(1);
        expect(errors[0]!.retrying).toBe(true);
        expect(server.streams).toHaveLength(2);
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

        expect(errors.map(e => e.retrying)).toEqual([true]);
        expect(ends).toBe(0);
        expect(server.streams).toHaveLength(2);
    });

    test('5xx and network errors retry after 1s; 4xx stops for good', async () => {
        server.routes['/sse'] = { status: 503 };
        start();
        await settle();
        expect(errors).toEqual([expect.objectContaining({ status: 503, retrying: true })]);
        expect(server.requested).toHaveLength(1);
        expect(ends).toBe(0);

        server.routes['/sse'] = { status: 403 };
        await settle(1000);
        expect(server.requested).toHaveLength(2);
        expect(errors[1]).toEqual(expect.objectContaining({ status: 403, retrying: false }));
        expect(ends).toBe(1);

        await settle(2000);
        expect(server.requested).toHaveLength(2);
    });

    test('network failure retries with no status', async () => {
        server.routes['/sse'] = { fail: true };
        start();
        await settle();
        expect(errors[0]!.status).toBeUndefined();
        expect(errors[0]!.retrying).toBe(true);
    });

    test('X-Redirect on connect navigates and does not retry', async () => {
        server.routes['/sse'] = { status: 401, headers: { 'X-Redirect': '/login' } };
        start();
        await settle();

        expect(page.navigated).toEqual(['/login']);
        expect(errors).toEqual([]);
        expect(ends).toBe(1);
    });

    test('x:redirect and x:refresh events close the stream and never reach onMessage', async () => {
        server.routes['/sse'] = { stream: true };
        start();
        await settle();
        stream().send('event: x:redirect\ndata: /login\n\ndata: after\n\n');
        await settle();
        expect(page.navigated).toEqual(['/login']);
        expect(messages).toEqual([]);
        expect(stream().closed).toBe(true);
        expect(ends).toBe(1);

        start();
        await settle();
        stream(1).send('event: x:refresh\ndata: now\n\n');
        await settle();
        expect(page.reloads).toBe(1);
        expect(messages).toEqual([]);
        expect(ends).toBe(2);
    });
});