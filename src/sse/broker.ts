import { open, type StreamCallbacks, type StreamEnd, type StreamOptions } from './stream';
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
    /** Open connections by URL. */
    connections: Map<string, Connection>;
    /** The last event id seen per URL. Outlives connections, so a reopened stream resumes. */
    lastIds: Map<string, string>;
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
function endMessage(url: string, end: StreamEnd): BrokerMessage {
    switch (end.reason) {
        case 'redirect': return { type: 'redirect', url, to: end.url };
        case 'refresh': return { type: 'refresh', url };
        case 'rejected': return { type: 'rejected', url, status: end.status };
    }
}

/** Removes `connection` from the table, unless a newer connection for its URL replaced it. */
function forget(state: BrokerState, url: string, connection: Connection): void {
    if (state.connections.get(url) === connection)
        state.connections.delete(url);
}

/** Opens a stream for `url`, resuming from the last id seen, and registers it. */
function connect(state: BrokerState, url: string): Connection {
    const connection: Connection = { close: () => { }, tabs: new Set() };
    state.connections.set(url, connection);

    const lastEventId = state.lastIds.get(url);
    connection.close = state.openStream(url, {
        onMessage: ({ event, data }) => {
            post(state, { type: 'event', url, event, data });
        },
        onId: id => { 
            state.lastIds.set(url, id); 
        },
        onError: ({ message, status }) => {
            post(state, { type: 'error', url, message, status });
        },
        onEnd: end => {
            forget(state, url, connection);   // before posting: a tab that subscribes again in response gets a fresh stream
            post(state, endMessage(url, end));
        },
    }, lastEventId === undefined ? {} : { lastEventId });

    return connection;
}

/** `tab` no longer wants `url`. Closes the stream once no tab does. */
function release(state: BrokerState, url: string, tab: TabId): void {
    const connection = state.connections.get(url);
    if (connection === undefined)
        return;

    connection.tabs.delete(tab);
    if (connection.tabs.size > 0)
        return;

    // A microtask later: an outerHTML swap unsubscribes and resubscribes in the same task.
    queueMicrotask(() => {
        if (connection.tabs.size === 0 && state.connections.get(url) === connection) {
            state.connections.delete(url);
            connection.close();
        }
    });
}

/** Handles one message from a tab. */
function receive(state: BrokerState, message: SubscriberMessage): void {
    switch (message.type) {
        case 'subscribe':
            (state.connections.get(message.url) ?? connect(state, message.url)).tabs.add(message.tab);
            break;

        case 'unsubscribe':
            release(state, message.url, message.tab);
            break;

        case 'leave':
            for (const url of [...state.connections.keys()])
                release(state, url, message.tab);
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
 * Owns the SSE connections: one per URL, opened when the first tab subscribes,
 * closed when the last one leaves. Forwards everything a stream reports to the tabs.
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
        test('the first subscribe opens a stream for the URL', async () => {
            await send({ type: 'subscribe', tab: tabA, url });
            expect(streams.map(s => s.url)).toEqual([url]);
        });
        test('more subscribes to the same URL share it, from any tab', async () => {
            await send({ type: 'subscribe', tab: tabA, url });
            await send({ type: 'subscribe', tab: tabB, url });
            await send({ type: 'subscribe', tab: tabA, url });
            expect(streams).toHaveLength(1);
        });
        test('different URLs get different streams', async () => {
            await send({ type: 'subscribe', tab: tabA, url });
            await send({ type: 'subscribe', tab: tabA, url: `${url}?x=1` });
            expect(streams.map(s => s.url)).toEqual([url, `${url}?x=1`]);
        });
        test('the stream closes when the last tab unsubscribes', async () => {
            await send({ type: 'subscribe', tab: tabA, url });
            await send({ type: 'subscribe', tab: tabB, url });
            await send({ type: 'unsubscribe', tab: tabA, url });
            expect(streams[0]!.closed).toBe(false);
            await send({ type: 'unsubscribe', tab: tabB, url });
            expect(streams[0]!.closed).toBe(true);
        });
        test('unsubscribe then subscribe in the same task keeps the stream (outerHTML self-replace)', async () => {
            deliver({ type: 'subscribe', tab: tabA, url });
            deliver({ type: 'unsubscribe', tab: tabA, url });   // the old element's cleanup
            deliver({ type: 'subscribe', tab: tabA, url });     // its replacement, same task
            await settle();
            expect(streams).toHaveLength(1);
            expect(streams[0]!.closed).toBe(false);
        });
        test('leave drops the tab from every URL and closes what nobody else uses', async () => {
            await send({ type: 'subscribe', tab: tabA, url: 'a' });
            await send({ type: 'subscribe', tab: tabA, url: 'b' });
            await send({ type: 'subscribe', tab: tabB, url: 'b' });
            await send({ type: 'leave', tab: tabA });
            expect(streams.map(s => [s.url, s.closed])).toEqual([['a', true], ['b', false]]);
        });
        test('unsubscribing something never subscribed is ignored', async () => {
            await send({ type: 'unsubscribe', tab: tabA, url });
            await send({ type: 'leave', tab: tabB });
            expect(streams).toEqual([]);
        });
    });

    describe('forwarding', () => {
        test('events become event messages for that URL', async () => {
            await send({ type: 'subscribe', tab: tabA, url });
            streams[0]!.callbacks.onMessage({ event: 'jobs:new', data: '<li>1</li>' });
            expect(posted).toEqual([{ type: 'event', url, event: 'jobs:new', data: '<li>1</li>' }]);
        });
        test('errors become error messages, the stream stays', async () => {
            await send({ type: 'subscribe', tab: tabA, url });
            streams[0]!.callbacks.onError({ message: 'down', status: 503 });
            expect(posted).toEqual([{ type: 'error', url, message: 'down', status: 503 }]);
            await send({ type: 'subscribe', tab: tabB, url });
            expect(streams).toHaveLength(1);
        });
        test('each end reason becomes its own message', async () => {
            for (const [i, end] of ([
                { reason: 'redirect', url: '/login' },
                { reason: 'refresh' },
                { reason: 'rejected', status: 403 },
            ] as StreamEnd[]).entries()) {
                await send({ type: 'subscribe', tab: tabA, url: `u${i}` });
                streams[i]!.callbacks.onEnd(end);
            }
            expect(posted).toEqual([
                { type: 'redirect', url: 'u0', to: '/login' },
                { type: 'refresh', url: 'u1' },
                { type: 'rejected', url: 'u2', status: 403 },
            ]);
        });
        test('ids are kept, not posted', async () => {
            await send({ type: 'subscribe', tab: tabA, url });
            streams[0]!.callbacks.onId('5-0');
            expect(posted).toEqual([]);
        });
    });

    describe('after a stream ends', () => {
        test('the URL is forgotten: the next subscribe opens a fresh stream', async () => {
            await send({ type: 'subscribe', tab: tabA, url });
            streams[0]!.callbacks.onEnd({ reason: 'refresh' });
            await send({ type: 'subscribe', tab: tabA, url });
            expect(streams).toHaveLength(2);
        });
        test('the fresh stream resumes from the last id seen', async () => {
            await send({ type: 'subscribe', tab: tabA, url });
            expect(streams[0]!.options).toEqual({});
            streams[0]!.callbacks.onId('9-0');
            streams[0]!.callbacks.onEnd({ reason: 'rejected', status: 401 });
            await send({ type: 'subscribe', tab: tabA, url });
            expect(streams[1]!.options).toEqual({ lastEventId: '9-0' });
        });
        test('an unsubscribe for the ended stream does not touch the fresh one', async () => {
            await send({ type: 'subscribe', tab: tabA, url });
            streams[0]!.callbacks.onEnd({ reason: 'refresh' });
            await send({ type: 'subscribe', tab: tabB, url });
            await send({ type: 'unsubscribe', tab: tabA, url });
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
        deliver({ type: 'subscribe', tab: tabA, url: 'x' });
        streams.at(-1)!.callbacks.onMessage({ event: 'e', data: 'd' });
        expect(one).toEqual(two);
        expect(one).toHaveLength(1);
        local.close();
    });
});