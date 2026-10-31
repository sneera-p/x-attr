import { open, streamKey } from './stream';
import type { StreamCallbacks, StreamEnd, StreamOptions, StreamHeaders, StreamKey } from './stream';
import type { BrokerMessage, BrokerTransport, SubscriberMessage, TabId } from './transport';

type OneOrTwo<T> = [T] | [T, T];

/** One open SSE connection, and the tabs that still want it. */
type Connection = {
    close: () => void;
    tabs: Set<TabId>;
};

/** Everything the broker knows. One object, passed to each function below. */
type BrokerState = {
    transports: OneOrTwo<BrokerTransport>;
    openStream: typeof open;
    /** Open connections by stream key (URL + headers). */
    connections: Map<StreamKey, Connection>;
    /** The last event id seen per stream. Outlives connections, so a reopened stream resumes. */
    lastIds: Map<StreamKey, string>;
};

export type Broker = {
    /** Closes every connection. For tests and teardown; tabs are not told. */
    close: () => void;
};

/** Sends a message to the tabs on every transport. */
function post(state: BrokerState, message: BrokerMessage): void {
    for (const transport of state.transports)
        transport.postMessage(message);
}

/** How a stream's end is told to the tabs. */
function endMessage(stream: StreamKey, end: StreamEnd): BrokerMessage {
    switch (end.reason) {
        case 'redirect': return { type: 'redirect', stream, to: end.url };
        case 'refresh': return { type: 'refresh', stream };
        case 'rejected': return { type: 'rejected', stream, status: end.status };
    }
}

/** Removes `connection` from the table, unless a newer connection for its stream replaced it. */
function forget(state: BrokerState, stream: StreamKey, connection: Connection): void {
    if (state.connections.get(stream) === connection)
        state.connections.delete(stream);
}

/** Opens `url` with `headers`, resuming from the last id seen on that stream, and registers it. */
function connect(state: BrokerState, stream: StreamKey, url: string, headers: StreamHeaders): Connection {
    const connection: Connection = { close: () => { }, tabs: new Set() };
    state.connections.set(stream, connection);

    const lastEventId = state.lastIds.get(stream);
    connection.close = state.openStream(url, {
        onMessage: ({ event, data }) => {
            post(state, { type: 'event', stream, event, data });
        },
        onId: id => {
            state.lastIds.set(stream, id);
        },
        onError: ({ message, status }) => {
            post(state, { type: 'error', stream, message, status });
        },
        onEnd: end => {
            forget(state, stream, connection);   // before posting: a tab that subscribes again in response gets a fresh stream
            post(state, endMessage(stream, end));
        },
    }, lastEventId === undefined ? { headers } : { headers, lastEventId });

    return connection;
}

/** `tab` no longer wants `stream`. Closes it once no tab does. */
function release(state: BrokerState, stream: StreamKey, tab: TabId): void {
    const connection = state.connections.get(stream);
    if (connection === undefined)
        return;

    connection.tabs.delete(tab);
    if (connection.tabs.size > 0)
        return;

    // A microtask later: an outerHTML swap unsubscribes and resubscribes in the same task.
    queueMicrotask(() => {
        if (connection.tabs.size === 0 && state.connections.get(stream) === connection) {
            state.connections.delete(stream);
            connection.close();
        }
    });
}

/** Handles one message from a tab. */
function receive(state: BrokerState, message: SubscriberMessage): void {
    switch (message.type) {
        case 'subscribe':
            (state.connections.get(message.stream) ?? connect(state, message.stream, message.url, message.headers)).tabs.add(message.tab);
            break;

        case 'unsubscribe':
            release(state, message.stream, message.tab);
            break;

        case 'leave':
            for (const stream of [...state.connections.keys()])
                release(state, stream, message.tab);
            break;
    }
}

/** Closes every connection at once. */
function close(state: BrokerState): void {
    for (const connection of state.connections.values())
        connection.close();
    state.connections.clear();
}

/**
 * Owns the SSE connections: one per stream (URL + headers), opened when the first tab
 * subscribes, closed when the last one leaves. Forwards everything a stream reports to the tabs.
 *
 * Never touches the page (no DOM, no location) and holds no functions from tabs,
 * so it can run in the page, in a leader tab, or in a worker.
 */
export function createBroker(transports: OneOrTwo<BrokerTransport>, openStream: typeof open = open): Broker {
    const state: BrokerState = {
        transports,
        openStream,
        connections: new Map(),
        lastIds: new Map(),
    };

    for (const transport of transports)
        transport.onMessage(message => receive(state, message));

    return {
        close: () => close(state),
    };
}

// ---- tests (removed from the build) ----

describe('broker', () => {
    const tabA = '00000000-0000-0000-0000-00000000000a' as TabId;
    const tabB = '00000000-0000-0000-0000-00000000000b' as TabId;
    const url = 'http://localhost/live';
    const key = (u: string = url, headers: StreamHeaders = {}): StreamKey => streamKey(u, headers);
    const stream = key();
    const sub = (tab: TabId, s: StreamKey = stream, u: string = url, headers: StreamHeaders = {}): SubscriberMessage =>
        ({ type: 'subscribe', tab, stream: s, url: u, headers });
 
    /** A fake open(): records every stream, lets the test drive its callbacks. */
    type FakeStream = { url: string; callbacks: StreamCallbacks; options: StreamOptions | undefined; closed: boolean };
    let streams: FakeStream[];
    const fakeOpen: typeof open = (url, callbacks, options) => {
        const stream: FakeStream = { url, callbacks, options, closed: false };
        streams.push(stream);
        return () => { stream.closed = true; };
    };
 
    /** A fake transport: the test delivers into the broker and reads what it posts back. */
    let deliver: (message: SubscriberMessage) => void;
    let send: (message: SubscriberMessage) => Promise<void>;
    let posted: BrokerMessage[];
    let broker: Broker;
 
    beforeEach(() => {
        streams = [];
        posted = [];
        const transport: BrokerTransport = {
            postMessage: message => { posted.push(message); },
            onMessage: listener => { deliver = listener; },
        };
        send = async message => { deliver(message); await settle(); };
        broker = createBroker([transport], fakeOpen);
    });
    afterEach(() => broker.close());
 
    describe('connections', () => {
        test('the first subscribe opens the stream with its URL and headers', async () => {
            await send(sub(tabA, key(url, { 'X-Tenant': '7' }), url, { 'X-Tenant': '7' }));
            expect(streams.map(s => s.url)).toEqual([url]);
            expect(streams[0]!.options).toEqual({ headers: { 'X-Tenant': '7' } });
        });
        test('more subscribes to the same stream share it, from any tab', async () => {
            await send(sub(tabA));
            await send(sub(tabB));
            await send(sub(tabA));
            expect(streams).toHaveLength(1);
        });
        test('the same URL with different headers is a different stream', async () => {
            await send(sub(tabA, key(url, { 'X-Tenant': '7' }), url, { 'X-Tenant': '7' }));
            await send(sub(tabA, key(url, { 'X-Tenant': '9' }), url, { 'X-Tenant': '9' }));
            expect(streams).toHaveLength(2);
        });
        test('the stream closes when the last tab unsubscribes', async () => {
            await send(sub(tabA));
            await send(sub(tabB));
            await send({ type: 'unsubscribe', tab: tabA, stream });
            expect(streams[0]!.closed).toBe(false);
            await send({ type: 'unsubscribe', tab: tabB, stream });
            expect(streams[0]!.closed).toBe(true);
        });
        test('unsubscribe then subscribe in the same task keeps the stream (outerHTML self-replace)', async () => {
            deliver(sub(tabA));
            deliver({ type: 'unsubscribe', tab: tabA, stream });   // the old element's cleanup
            deliver(sub(tabA));                                     // its replacement, same task
            await settle();
            expect(streams).toHaveLength(1);
            expect(streams[0]!.closed).toBe(false);
        });
        test('leave drops the tab from every stream and closes what nobody else uses', async () => {
            const a = key('a');
            const b = key('b');
            await send(sub(tabA, a, 'a'));
            await send(sub(tabA, b, 'b'));
            await send(sub(tabB, b, 'b'));
            await send({ type: 'leave', tab: tabA });
            expect(streams.map(s => [s.url, s.closed])).toEqual([['a', true], ['b', false]]);
        });
        test('unsubscribing something never subscribed is ignored', async () => {
            await send({ type: 'unsubscribe', tab: tabA, stream });
            await send({ type: 'leave', tab: tabB });
            expect(streams).toEqual([]);
        });
    });
 
    describe('forwarding', () => {
        test('events become event messages for that stream', async () => {
            await send(sub(tabA));
            streams[0]!.callbacks.onMessage({ event: 'jobs:new', data: '<li>1</li>' });
            expect(posted).toEqual([{ type: 'event', stream, event: 'jobs:new', data: '<li>1</li>' }]);
        });
        test('errors become error messages, the stream stays', async () => {
            await send(sub(tabA));
            streams[0]!.callbacks.onError({ message: 'down', status: 503 });
            expect(posted).toEqual([{ type: 'error', stream, message: 'down', status: 503 }]);
            await send(sub(tabB));
            expect(streams).toHaveLength(1);
        });
        test('each end reason becomes its own message', async () => {
            const keys = [key('u0'), key('u1'), key('u2')];
            for (const [i, end] of ([
                { reason: 'redirect', url: '/login' },
                { reason: 'refresh' },
                { reason: 'rejected', status: 403 },
            ] as StreamEnd[]).entries()) {
                await send(sub(tabA, keys[i]!, `u${i}`));
                streams[i]!.callbacks.onEnd(end);
            }
            expect(posted).toEqual([
                { type: 'redirect', stream: keys[0], to: '/login' },
                { type: 'refresh', stream: keys[1] },
                { type: 'rejected', stream: keys[2], status: 403 },
            ]);
        });
        test('ids are kept, not posted', async () => {
            await send(sub(tabA));
            streams[0]!.callbacks.onId('5-0');
            expect(posted).toEqual([]);
        });
    });
 
    describe('after a stream ends', () => {
        test('the stream is forgotten: the next subscribe opens a fresh one', async () => {
            await send(sub(tabA));
            streams[0]!.callbacks.onEnd({ reason: 'refresh' });
            await send(sub(tabA));
            expect(streams).toHaveLength(2);
        });
        test('the fresh one resumes from the last id seen, with the same headers', async () => {
            const s = key(url, { 'X-A': '1' });
            await send(sub(tabA, s, url, { 'X-A': '1' }));
            expect(streams[0]!.options).toEqual({ headers: { 'X-A': '1' } });
            streams[0]!.callbacks.onId('9-0');
            streams[0]!.callbacks.onEnd({ reason: 'rejected', status: 401 });
            await send(sub(tabA, s, url, { 'X-A': '1' }));
            expect(streams[1]!.options).toEqual({ headers: { 'X-A': '1' }, lastEventId: '9-0' });
        });
        test('an unsubscribe for the ended stream does not touch the fresh one', async () => {
            await send(sub(tabA));
            streams[0]!.callbacks.onEnd({ reason: 'refresh' });
            await send(sub(tabB));
            await send({ type: 'unsubscribe', tab: tabA, stream });
            expect(streams[1]!.closed).toBe(false);
        });
    });
 
    test('posts to every transport', async () => {
        const one: BrokerMessage[] = [];
        const two: BrokerMessage[] = [];
        let deliver: (m: SubscriberMessage) => void = () => {};
        const local = createBroker([
            { postMessage: m => { one.push(m); }, onMessage: l => { deliver = l; } },
            { postMessage: m => { two.push(m); }, onMessage: () => {} },
        ], fakeOpen);
        deliver(sub(tabA, key('x'), 'x'));
        streams.at(-1)!.callbacks.onMessage({ event: 'e', data: 'd' });
        expect(one).toEqual(two);
        expect(one).toHaveLength(1);
        local.close();
    });
});
