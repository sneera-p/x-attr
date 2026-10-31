import { streamKey, type StreamHeaders, type StreamKey } from './stream';
import type { TabId, SubscriberTransport, BrokerMessage } from './transport';

/** What a subscription's onError receives. */
export type SubscriptionError = {
    message: string;
    /** HTTP status, when the server answered at all. */
    status?: number;
    /** true: the stream is reconnecting, the subscription stays. false: the server refused, it is gone. */
    retrying: boolean;
};

/** One element's interest in one event of one stream. */
type Subscription = {
    stream: StreamKey;
    url: string;
    event: string;
    handler: (data: string) => void;
    onError: (error: SubscriptionError) => void;
};

/** Everything this tab's subscriber knows. One object, passed to each function below. */
type SubscriberState = {
    tab: TabId;
    transport: SubscriberTransport;
    subscriptions: Set<Subscription>;
    /** How many subscriptions this tab has per stream; the broker only hears about 0 → 1 and 1 → 0. */
    counts: Map<StreamKey, number>;
};

export type Subscriber = {
    /**
     * Listens for `event` on the stream at `url`, opened with `headers`.
     * Returns a function that stops listening (safe to call twice).
     */
    subscribe: (url: string, headers: StreamHeaders, event: string, handler: (data: string) => void, onError: (error: SubscriptionError) => void) => () => void;
    /** This tab is going away: the broker drops everything it wanted. */
    leave: () => void;
};

/** The URL as the broker sees it: absolute, so it means the same in every tab and in a worker. */
function absolute(url: string): string {
    return new URL(url, location.href).href;
}

/** Every subscription on `stream`. A copy, so callers may add or remove while iterating. */
function on(state: SubscriberState, stream: StreamKey): Subscription[] {
    return [...state.subscriptions].filter(subscription => subscription.stream === stream);
}

/** The stream is gone: drop its subscriptions here, without telling the broker (it already forgot it). */
function drop(state: SubscriberState, stream: StreamKey): Subscription[] {
    const dropped = on(state, stream);
    for (const subscription of dropped)
        state.subscriptions.delete(subscription);
    state.counts.delete(stream);
    return dropped;
}

function add(state: SubscriberState, subscription: Subscription, headers: StreamHeaders): void {
    state.subscriptions.add(subscription);
    const count = (state.counts.get(subscription.stream) ?? 0) + 1;
    state.counts.set(subscription.stream, count);
    if (count === 1)
        state.transport.postMessage({ type: 'subscribe', tab: state.tab, stream: subscription.stream, url: subscription.url, headers });
}

function remove(state: SubscriberState, subscription: Subscription): void {
    // Already gone: unsubscribed before, or dropped when its stream ended.
    if (!state.subscriptions.delete(subscription))
        return;

    const count = (state.counts.get(subscription.stream) ?? 1) - 1;
    if (count > 0) {
        state.counts.set(subscription.stream, count);
        return;
    }
    state.counts.delete(subscription.stream);
    state.transport.postMessage({ type: 'unsubscribe', tab: state.tab, stream: subscription.stream });
}

/** Handles one message from the broker. */
function receive(state: SubscriberState, message: BrokerMessage): void {
    switch (message.type) {
        case 'event':
            for (const subscription of on(state, message.stream))
                if (subscription.event === message.event)
                    subscription.handler(message.data);
            break;

        case 'error':
            for (const subscription of on(state, message.stream))
                subscription.onError({ message: message.message, status: message.status, retrying: true });
            break;

        case 'rejected':
            for (const subscription of drop(state, message.stream))
                subscription.onError({ message: `${subscription.url} answered ${message.status}`, status: message.status, retrying: false });
            break;

        case 'redirect':
            drop(state, message.stream);
            location.assign(message.to);
            break;

        case 'refresh':
            drop(state, message.stream);
            location.reload();
            break;
    }
}

/**
 * This tab's side of SSE: keeps the handlers, tells the broker which streams the tab
 * needs, calls the right handlers when events arrive, and does what only a page
 * can do (navigate, reload).
 */
export function createSubscriber(transport: SubscriberTransport, tab: TabId = crypto.randomUUID()): Subscriber {
    const state: SubscriberState = {
        tab,
        transport,
        subscriptions: new Set(),
        counts: new Map(),
    };

    transport.onMessage(message => receive(state, message));

    return {
        subscribe: (url, headers, event, handler, onError) => {
            const absoluteUrl = absolute(url);
            const subscription: Subscription = { stream: streamKey(absoluteUrl, headers), url: absoluteUrl, event, handler, onError };
            add(state, subscription, headers);
            return () => remove(state, subscription);
        },
        leave: () => {
            state.transport.postMessage({ type: 'leave', tab: state.tab });
        },
    };
}

// ---- tests (removed from the build) ----

describe('subscriber', () => {
    const tab = '00000000-0000-0000-0000-00000000000a' as TabId;
    const url = 'http://localhost/live';
    const stream = streamKey(url, {});
 
    /** A fake transport: records what the subscriber posts; the test delivers broker messages. */
    let posted: unknown[];
    let deliver: (message: BrokerMessage) => void;
    let subscriber: Subscriber;
 
    beforeEach(() => {
        posted = [];
        subscriber = createSubscriber({
            postMessage: message => { posted.push(message); },
            onMessage: listener => { deliver = listener; },
        }, tab);
    });
 
    const noop = (): void => {};
    const subscribe = (u: string, event: string, handler: (data: string) => void = noop, onError: (e: SubscriptionError) => void = noop, headers: StreamHeaders = {}): (() => void) =>
        subscriber.subscribe(u, headers, event, handler, onError);
 
    describe('telling the broker', () => {
        test('the first subscription to a stream subscribes the tab, with its URL and headers', () => {
            subscribe(url, 'a', noop, noop, { 'X-Tenant': '7' });
            expect(posted).toEqual([{ type: 'subscribe', tab, stream: streamKey(url, { 'X-Tenant': '7' }), url, headers: { 'X-Tenant': '7' } }]);
        });
        test('more subscriptions to the same stream tell the broker nothing, whatever the event', () => {
            subscribe(url, 'a');
            subscribe(url, 'a');
            subscribe(url, 'b');
            expect(posted).toHaveLength(1);
        });
        test('the same URL with different headers is a separate stream', () => {
            subscribe(url, 'a', noop, noop, { 'X-Tenant': '7' });
            subscribe(url, 'a', noop, noop, { 'X-Tenant': '9' });
            expect(posted).toHaveLength(2);
        });
        test('only the last unsubscribe from a stream unsubscribes the tab', () => {
            const one = subscribe(url, 'a');
            const two = subscribe(url, 'b');
            one();
            expect(posted).toHaveLength(1);
            two();
            expect(posted.at(-1)).toEqual({ type: 'unsubscribe', tab, stream });
        });
        test('unsubscribing twice counts once', () => {
            const one = subscribe(url, 'a');
            subscribe(url, 'a');
            one();
            one();
            expect(posted).toHaveLength(1);
        });
        test('relative URLs are made absolute, so equal URLs are one stream', () => {
            subscribe('/live', 'a');
            subscribe('http://localhost/live', 'a');
            expect(posted).toEqual([{ type: 'subscribe', tab, stream, url, headers: {} }]);
        });
        test('leave tells the broker the whole tab is going', () => {
            subscriber.leave();
            expect(posted).toEqual([{ type: 'leave', tab }]);
        });
    });
 
    describe('events', () => {
        test('go to the subscriptions with that stream and event only', () => {
            const got: string[] = [];
            subscribe(url, 'a', data => got.push(`a1 ${data}`));
            subscribe(url, 'a', data => got.push(`a2 ${data}`));
            subscribe(url, 'b', data => got.push(`b ${data}`));
            subscribe(`${url}?x=1`, 'a', data => got.push(`other url ${data}`));
            subscribe(url, 'a', data => got.push(`other headers ${data}`), noop, { 'X-A': '1' });
 
            deliver({ type: 'event', stream, event: 'a', data: 'x' });
            expect(got).toEqual(['a1 x', 'a2 x']);
        });
        test('an unsubscribed handler is not called', () => {
            const got: string[] = [];
            const off = subscribe(url, 'a', data => got.push(data));
            off();
            deliver({ type: 'event', stream, event: 'a', data: 'x' });
            expect(got).toEqual([]);
        });
        test('a handler that replaces itself (outerHTML) runs once, and the new one waits for the next event', () => {
            const got: string[] = [];
            const listen = (): void => {
                const off = subscribe(url, 'a', data => { got.push(data); listen(); off(); });
            };
            listen();
            deliver({ type: 'event', stream, event: 'a', data: '1' });
            deliver({ type: 'event', stream, event: 'a', data: '2' });
            expect(got).toEqual(['1', '2']);
            expect(posted).toHaveLength(1);
        });
    });
 
    describe('errors and ends', () => {
        test('error: every subscription on the stream hears it, retrying, and stays', () => {
            const errors: SubscriptionError[] = [];
            const got: string[] = [];
            subscribe(url, 'a', data => got.push(data), e => errors.push(e));
            subscribe(url, 'b', noop, e => errors.push(e));
 
            deliver({ type: 'error', stream, message: 'down', status: 503 });
            expect(errors).toEqual([
                { message: 'down', status: 503, retrying: true },
                { message: 'down', status: 503, retrying: true },
            ]);
            deliver({ type: 'event', stream, event: 'a', data: 'back' });
            expect(got).toEqual(['back']);
        });
        test('rejected: every subscription on the stream hears it, not retrying, and is dropped', () => {
            const errors: SubscriptionError[] = [];
            const got: string[] = [];
            subscribe(url, 'a', data => got.push(data), e => errors.push(e));
 
            deliver({ type: 'rejected', stream, status: 403 });
            expect(errors).toEqual([{ message: `${url} answered 403`, status: 403, retrying: false }]);
            deliver({ type: 'event', stream, event: 'a', data: 'late' });
            expect(got).toEqual([]);
        });
        test('after rejected, a new subscription to the stream subscribes the tab again', () => {
            const off = subscribe(url, 'a');
            deliver({ type: 'rejected', stream, status: 401 });
            subscribe(url, 'a');
            off();   // the dropped one: a no-op, it must not unsubscribe the new one
            expect(posted.map(m => (m as { type: string }).type)).toEqual(['subscribe', 'subscribe']);
        });
        test('redirect navigates the page', () => {
            subscribe(url, 'a');
            deliver({ type: 'redirect', stream, to: '/login' });
            expect(page.navigated).toEqual(['/login']);
        });
        test('refresh reloads the page', () => {
            subscribe(url, 'a');
            deliver({ type: 'refresh', stream });
            expect(page.reloads).toBe(1);
        });
        test('after redirect or refresh, the stream starts over', () => {
            subscribe(url, 'a');
            deliver({ type: 'refresh', stream });
            subscribe(url, 'a');
            expect(posted).toHaveLength(2);
        });
        test('messages for a stream this tab never used are ignored', () => {
            deliver({ type: 'event', stream, event: 'a', data: 'x' });
            deliver({ type: 'rejected', stream, status: 403 });
            expect(posted).toEqual([]);
        });
    });
});
