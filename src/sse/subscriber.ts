import type { BrokerMessage, SubscriberTransport, TabId } from './transport';

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
    /** How many subscriptions this tab has per URL; the broker only hears about 0 → 1 and 1 → 0. */
    counts: Map<string, number>;
};

export type Subscriber = {
    /** Listens for `event` on the stream at `url`. Returns a function that stops listening (safe to call twice). */
    subscribe: (url: string, event: string, handler: (data: string) => void, onError: (error: SubscriptionError) => void) => () => void;
    /** This tab is going away: the broker drops everything it wanted. */
    leave: () => void;
};

/** The URL as the broker keys it: absolute, so it means the same in every tab and in a worker. */
function absolute(url: string): string {
    return new URL(url, location.href).href;
}

/** Every subscription on `url`. A copy, so callers may add or remove while iterating. */
function on(state: SubscriberState, url: string): Subscription[] {
    return [...state.subscriptions].filter(subscription => subscription.url === url);
}

/** The stream at `url` is gone: drop its subscriptions here, without telling the broker (it already forgot it). */
function drop(state: SubscriberState, url: string): Subscription[] {
    const dropped = on(state, url);
    for (const subscription of dropped) {
        state.subscriptions.delete(subscription);
    }
    state.counts.delete(url);
    return dropped;
}

function add(state: SubscriberState, subscription: Subscription): void {
    state.subscriptions.add(subscription);
    const count = (state.counts.get(subscription.url) ?? 0) + 1;
    state.counts.set(subscription.url, count);
    if (count === 1) {
        state.transport.postMessage({ type: 'subscribe', tab: state.tab, url: subscription.url });
    }
}

function remove(state: SubscriberState, subscription: Subscription): void {
    // Already gone: unsubscribed before, or dropped when its stream ended.
    if (!state.subscriptions.delete(subscription)) {
        return;
    }
    const count = (state.counts.get(subscription.url) ?? 1) - 1;
    if (count > 0) {
        state.counts.set(subscription.url, count);
        return;
    }
    state.counts.delete(subscription.url);
    state.transport.postMessage({ type: 'unsubscribe', tab: state.tab, url: subscription.url });
}

/** Handles one message from the broker. */
function receive(state: SubscriberState, message: BrokerMessage): void {
    switch (message.type) {
        case 'event':
            for (const subscription of on(state, message.url)) {
                if (subscription.event === message.event) {
                    subscription.handler(message.data);
                }
            }
            break;

        case 'error':
            for (const subscription of on(state, message.url)) {
                subscription.onError({ message: message.message, status: message.status, retrying: true });
            }
            break;

        case 'rejected':
            for (const subscription of drop(state, message.url)) {
                subscription.onError({ message: `${message.url} answered ${message.status}`, status: message.status, retrying: false });
            }
            break;

        case 'redirect':
            drop(state, message.url);
            location.assign(message.to);
            break;

        case 'refresh':
            drop(state, message.url);
            location.reload();
            break;
    }
}

/**
 * This tab's side of SSE: keeps the handlers, tells the broker which URLs the tab
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
        subscribe: (url, event, handler, onError) => {
            const subscription: Subscription = { url: absolute(url), event, handler, onError };
            add(state, subscription);
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

    describe('telling the broker', () => {
        test('the first subscription to a URL subscribes the tab', () => {
            subscriber.subscribe(url, 'a', noop, noop);
            expect(posted).toEqual([{ type: 'subscribe', tab, url }]);
        });
        test('more subscriptions to the same URL tell the broker nothing, whatever the event', () => {
            subscriber.subscribe(url, 'a', noop, noop);
            subscriber.subscribe(url, 'a', noop, noop);
            subscriber.subscribe(url, 'b', noop, noop);
            expect(posted).toHaveLength(1);
        });
        test('only the last unsubscribe from a URL unsubscribes the tab', () => {
            const one = subscriber.subscribe(url, 'a', noop, noop);
            const two = subscriber.subscribe(url, 'b', noop, noop);
            one();
            expect(posted).toHaveLength(1);
            two();
            expect(posted).toEqual([{ type: 'subscribe', tab, url }, { type: 'unsubscribe', tab, url }]);
        });
        test('unsubscribing twice counts once', () => {
            const one = subscriber.subscribe(url, 'a', noop, noop);
            subscriber.subscribe(url, 'a', noop, noop);
            one();
            one();
            expect(posted).toHaveLength(1);
        });
        test('relative URLs are made absolute, so equal URLs are one key', () => {
            subscriber.subscribe('/live', 'a', noop, noop);
            subscriber.subscribe('http://localhost/live', 'a', noop, noop);
            expect(posted).toEqual([{ type: 'subscribe', tab, url: 'http://localhost/live' }]);
        });
        test('leave tells the broker the whole tab is going', () => {
            subscriber.leave();
            expect(posted).toEqual([{ type: 'leave', tab }]);
        });
    });

    describe('events', () => {
        test('go to the subscriptions with that URL and event only', () => {
            const got: string[] = [];
            subscriber.subscribe(url, 'a', data => got.push(`a1 ${data}`), noop);
            subscriber.subscribe(url, 'a', data => got.push(`a2 ${data}`), noop);
            subscriber.subscribe(url, 'b', data => got.push(`b ${data}`), noop);
            subscriber.subscribe(`${url}?x=1`, 'a', data => got.push(`other ${data}`), noop);

            deliver({ type: 'event', url, event: 'a', data: 'x' });
            expect(got).toEqual(['a1 x', 'a2 x']);
        });
        test('an unsubscribed handler is not called', () => {
            const got: string[] = [];
            const off = subscriber.subscribe(url, 'a', data => got.push(data), noop);
            off();
            deliver({ type: 'event', url, event: 'a', data: 'x' });
            expect(got).toEqual([]);
        });
        test('a handler that replaces itself (outerHTML) runs once, and the new one waits for the next event', () => {
            const got: string[] = [];
            const listen = (): void => {
                const off = subscriber.subscribe(url, 'a', data => { got.push(data); listen(); off(); }, noop);
            };
            listen();
            deliver({ type: 'event', url, event: 'a', data: '1' });
            deliver({ type: 'event', url, event: 'a', data: '2' });
            expect(got).toEqual(['1', '2']);
            expect(posted).toEqual([{ type: 'subscribe', tab, url }]);
        });
    });

    describe('errors and ends', () => {
        test('error: every subscription on the URL hears it, retrying, and stays', () => {
            const errors: SubscriptionError[] = [];
            const got: string[] = [];
            subscriber.subscribe(url, 'a', data => got.push(data), e => errors.push(e));
            subscriber.subscribe(url, 'b', noop, e => errors.push(e));

            deliver({ type: 'error', url, message: 'down', status: 503 });
            expect(errors).toEqual([
                { message: 'down', status: 503, retrying: true },
                { message: 'down', status: 503, retrying: true },
            ]);
            deliver({ type: 'event', url, event: 'a', data: 'back' });
            expect(got).toEqual(['back']);
        });
        test('rejected: every subscription on the URL hears it, not retrying, and is dropped', () => {
            const errors: SubscriptionError[] = [];
            const got: string[] = [];
            subscriber.subscribe(url, 'a', data => got.push(data), e => errors.push(e));

            deliver({ type: 'rejected', url, status: 403 });
            expect(errors).toEqual([{ message: `${url} answered 403`, status: 403, retrying: false }]);
            deliver({ type: 'event', url, event: 'a', data: 'late' });
            expect(got).toEqual([]);
        });
        test('after rejected, a new subscription to the URL subscribes the tab again', () => {
            const off = subscriber.subscribe(url, 'a', noop, noop);
            deliver({ type: 'rejected', url, status: 401 });
            subscriber.subscribe(url, 'a', noop, noop);
            off();   // the dropped one: a no-op, it must not unsubscribe the new one
            expect(posted).toEqual([{ type: 'subscribe', tab, url }, { type: 'subscribe', tab, url }]);
        });
        test('redirect navigates the page', () => {
            subscriber.subscribe(url, 'a', noop, noop);
            deliver({ type: 'redirect', url, to: '/login' });
            expect(page.navigated).toEqual(['/login']);
        });
        test('refresh reloads the page', () => {
            subscriber.subscribe(url, 'a', noop, noop);
            deliver({ type: 'refresh', url });
            expect(page.reloads).toBe(1);
        });
        test('after redirect or refresh, the URL starts over', () => {
            subscriber.subscribe(url, 'a', noop, noop);
            deliver({ type: 'refresh', url });
            subscriber.subscribe(url, 'a', noop, noop);
            expect(posted).toEqual([{ type: 'subscribe', tab, url }, { type: 'subscribe', tab, url }]);
        });
        test('messages for a URL this tab never used are ignored', () => {
            deliver({ type: 'event', url, event: 'a', data: 'x' });
            deliver({ type: 'rejected', url, status: 403 });
            expect(posted).toEqual([]);
        });
    });
});