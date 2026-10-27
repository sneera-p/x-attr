import { open, type Message, type StreamError } from './stream';

type Handler = (html: string) => void;
type ErrorHandler = (error: StreamError) => void;

type Channel = {
    close: () => void;
    /** Event name → handlers listening for it. */
    handlers: Map<string, Set<Handler>>;
    errorHandlers: Set<ErrorHandler>;
};

/** Open streams, one per URL (path + query). */
const channels = new Map<string, Channel>();

/**
 * Subscribe to one event of an SSE endpoint.
 *
 * The first subscriber to a URL opens the stream; later ones share it.
 * The last one to unsubscribe closes it. A stream that fails for good
 * (4xx, X-Redirect, x:redirect, x:refresh) is forgotten, so the next subscriber opens a fresh one.
 *
 * @param url SSE endpoint URL
 * @param event Event name to listen to
 * @param handler Called with each matching event's data (HTML)
 * @param onError Called with every error of the shared stream
 *
 * @returns Function to unsubscribe (safe to call twice)
 */
export function subscribe(url: string, event: string, handler: Handler, onError: ErrorHandler): () => void {
    let channel = channels.get(url);
    if (channel === undefined) {
        const created: Channel = { close: () => { }, handlers: new Map(), errorHandlers: new Set() };
        channels.set(url, created);
        created.close = open(
            url,
            message => dispatch(created, message),
            error => {
                for (const h of [...created.errorHandlers]) h(error);
            },
            () => {
                if (channels.get(url) === created) {
                    channels.delete(url);
                }
            },
        );
        channel = created;
    }

    // Wrapped, so subscribing the same function twice gives two independent subscriptions.
    const own: Handler = html => handler(html);
    const ownError: ErrorHandler = error => onError(error);

    let set = channel.handlers.get(event);
    if (set === undefined) {
        set = new Set();
        channel.handlers.set(event, set);
    }
    set.add(own);
    channel.errorHandlers.add(ownError);

    const subscribed = channel;
    let done = false;
    return () => {
        if (done) {
            return;
        }
        done = true;
        const handlers = subscribed.handlers.get(event);
        handlers?.delete(own);
        if (handlers?.size === 0) {
            subscribed.handlers.delete(event);
        }
        subscribed.errorHandlers.delete(ownError);

        // Close a microtask later: an outerHTML swap unsubscribes the old element
        // before its replacement subscribes, in the same task. Closing now would
        // reconnect on every self-replace and lose the Last-Event-ID.
        queueMicrotask(() => {
            if (subscribed.handlers.size === 0) {
                subscribed.close();
                if (channels.get(url) === subscribed) {
                    channels.delete(url);
                }
            }
        });
    };
}

function dispatch(channel: Channel, message: Message): void {
    // A copy: a handler may unsubscribe, or swap in an element that subscribes again,
    // while we're iterating (outerHTML self-replace would otherwise loop forever).
    for (const handler of [...(channel.handlers.get(message.event) ?? [])]) {
        handler(message.data);
    }
}

// ---- tests (removed from the build) ----

describe('subscribe', () => {
    let unsubs: (() => void)[];
    beforeEach(() => {
        unsubs = [];
        server.routes['/sse'] = { stream: true };
    });
    afterEach(() => {
        for (const u of unsubs) u();
    });

    const sub = (event: string, got: string[], errors: StreamError[] = [], url = '/sse'): () => void => {
        const u = subscribe(url, event, html => got.push(html), e => errors.push(e));
        unsubs.push(u);
        return u;
    };

    test('subscribers to one URL share one connection', async () => {
        sub('a', []);
        sub('b', []);
        await settle();
        expect(server.requested).toEqual(['/sse']);
    });

    test('different URLs (different query) get their own connection', async () => {
        server.routes['/sse?status=open'] = { stream: true };
        sub('a', []);
        sub('a', [], [], '/sse?status=open');
        await settle();
        expect(server.requested).toEqual(['/sse', '/sse?status=open']);
    });

    test('events are routed by name', async () => {
        const a: string[] = [];
        const b: string[] = [];
        sub('job:1', a);
        sub('job:2', b);
        await settle();
        server.streams[0]!.send('event: job:1\ndata: one\n\nevent: job:2\ndata: two\n\nevent: job:3\ndata: nobody\n\n');
        await settle();
        expect(a).toEqual(['one']);
        expect(b).toEqual(['two']);
    });

    test('the last unsubscribe closes the connection', async () => {
        const u1 = sub('a', []);
        const u2 = sub('b', []);
        await settle();
        u1();
        expect(server.streams[0]!.closed).toBe(false);
        u2();
        await settle();
        expect(server.streams[0]!.closed).toBe(true);

        sub('a', []);
        await settle();
        expect(server.requested).toEqual(['/sse', '/sse']);
    });

    test('unsubscribe twice does nothing more', async () => {
        const u1 = sub('a', []);
        sub('a', []);
        await settle();
        u1();
        u1();
        expect(server.streams[0]!.closed).toBe(false);
    });

    test('a handler that resubscribes then unsubscribes during dispatch (outerHTML swap) runs once', async () => {
        const got: string[] = [];
        const listen = (): void => {
            const u = subscribe('/sse', 'a', html => { got.push(html); listen(); u(); }, () => { });
            unsubs.push(u);
        };
        listen();
        await settle();
        server.streams[0]!.send('event: a\ndata: x\n\n');
        await settle();
        expect(got).toEqual(['x']);
        expect(server.requested).toEqual(['/sse']);
    });

    test('errors reach every subscriber; a final error forgets the channel', async () => {
        server.routes['/sse'] = { status: 403 };
        const e1: StreamError[] = [];
        const e2: StreamError[] = [];
        sub('a', [], e1);
        sub('b', [], e2);
        await settle();
        expect(e1.map(e => e.status)).toEqual([403]);
        expect(e2.map(e => e.status)).toEqual([403]);

        server.routes['/sse'] = { stream: true };
        sub('a', []);
        await settle();
        expect(server.requested).toEqual(['/sse', '/sse']);
    });

    test('after x:refresh the channel is forgotten: the next subscriber reconnects', async () => {
        sub('a', []);
        await settle();
        server.streams[0]!.send('event: x:refresh\ndata: stale\n\n');
        await settle();

        const got: string[] = [];
        sub('a', got);
        await settle();
        expect(server.requested).toEqual(['/sse', '/sse']);
        server.streams[1]!.send('event: a\ndata: fresh\n\n');
        await settle();
        expect(got).toEqual(['fresh']);
    });

    test('a subscriber added from inside a 4xx error handler gets a fresh connection', async () => {
        server.routes['/sse'] = { status: 403 };
        const got: string[] = [];
        let retried = false;
        subscribe('/sse', 'a', () => { }, () => {
            if (retried) return;
            retried = true;
            server.routes['/sse'] = { stream: true };
            sub('a', got);
        });
        await settle();
        expect(server.requested).toEqual(['/sse', '/sse']);
        server.streams[0]!.send('event: a\ndata: ok\n\n');
        await settle();
        expect(got).toEqual(['ok']);
    });
});