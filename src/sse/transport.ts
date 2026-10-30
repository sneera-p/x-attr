export type TabId = ReturnType<typeof crypto.randomUUID>;

export type SubscriberMessage =
    | { type: 'subscribe', tab: TabId, url: string }
    | { type: 'unsubscribe', tab: TabId, url: string }
    | { type: 'leave', tab: TabId };

export type BrokerMessage =
    | { type: 'event', url: string, event: string, data: string }
    | { type: 'error', url: string, message: string, status?: number }
    | { type: 'redirect', url: string, to: string }
    | { type: 'refresh', url: string }
    | { type: 'rejected', url: string, status: number };


type Transport<Outgoing, Incoming> = {
    postMessage(message: Outgoing): void;
    onMessage(listener: (message: Incoming) => void): void;
}

export type SubscriberTransport = Transport<SubscriberMessage, BrokerMessage>;
export type BrokerTransport = Transport<BrokerMessage, SubscriberMessage>;


/** 
 * One end of a local pair: delivers what it is sent to its own listeners. 
 */
type End<Incoming> = {
    listeners: ((message: Incoming) => void)[];
    deliver(message: Incoming): void;
};

function createEnd<Incoming>(): End<Incoming> {
    const end: End<Incoming> = {
        listeners: [],
        deliver(message) {
            // Copy, like a real postMessage: a non-cloneable value throws here, not later in a worker.
            const copy = structuredClone(message);
            // Later, like a real postMessage: the sender's code finishes first.
            queueMicrotask(() => {
                for (const listener of [...end.listeners])
                    listener(copy);
            });
        },
    };
    return end;
}

/**
 * A subscriber and a broker in the same tab, connected directly.
 * Each end receives only what the other end posts, asynchronously and as a copy,
 * the same way postMessage would deliver it between threads.
 */
export function localTransport(): [SubscriberTransport, BrokerTransport ] {
    const toBroker = createEnd<SubscriberMessage>();
    const toSubscriber = createEnd<BrokerMessage>();

    return [
        {
            postMessage: message => toBroker.deliver(message),
            onMessage: listener => { toSubscriber.listeners.push(listener); },
        },
        {
            postMessage: message => toSubscriber.deliver(message),
            onMessage: listener => { toBroker.listeners.push(listener); },
        },
    ];
}


// ---- tests (removed from the build) ----

describe('transport', () => {
    describe('localTransport', () => {
        const tab = '00000000-0000-0000-0000-000000000001' as TabId;

        test('the broker receives what the subscriber posts', async () => {
            const [subscriber, broker] = localTransport();
            const got: SubscriberMessage[] = [];
            broker.onMessage(m => got.push(m));

            subscriber.postMessage({ type: 'subscribe', tab, url: 'http://localhost/live' });
            await settle();
            expect(got).toEqual([{ type: 'subscribe', tab, url: 'http://localhost/live' }]);
        });

        test('the subscriber receives what the broker posts', async () => {
            const [subscriber, broker] = localTransport();
            const got: BrokerMessage[] = [];
            subscriber.onMessage(m => got.push(m));

            broker.postMessage({ type: 'refresh', url: 'http://localhost/live' });
            await settle();
            expect(got).toEqual([{ type: 'refresh', url: 'http://localhost/live' }]);
        });

        test('an end never receives its own messages', async () => {
            const [subscriber, broker] = localTransport();
            const toSubscriber: BrokerMessage[] = [];
            const toBroker: SubscriberMessage[] = [];
            subscriber.onMessage(m => toSubscriber.push(m));
            broker.onMessage(m => toBroker.push(m));

            subscriber.postMessage({ type: 'leave', tab });
            await settle();
            expect(toSubscriber).toEqual([]);
            expect(toBroker).toHaveLength(1);
        });

        test('delivery is asynchronous: nothing arrives before the sender finishes', async () => {
            const [subscriber, broker] = localTransport();
            const got: SubscriberMessage[] = [];
            broker.onMessage(m => got.push(m));

            subscriber.postMessage({ type: 'leave', tab });
            expect(got).toEqual([]);
            await settle();
            expect(got).toHaveLength(1);
        });

        test('messages arrive in the order they were posted', async () => {
            const [subscriber, broker] = localTransport();
            const got: string[] = [];
            broker.onMessage(m => got.push(m.type === 'leave' ? 'leave' : `${m.type} ${m.url}`));

            subscriber.postMessage({ type: 'subscribe', tab, url: 'a' });
            subscriber.postMessage({ type: 'subscribe', tab, url: 'b' });
            subscriber.postMessage({ type: 'unsubscribe', tab, url: 'a' });
            await settle();
            expect(got).toEqual(['subscribe a', 'subscribe b', 'unsubscribe a']);
        });

        test('every listener on an end receives each message', async () => {
            const [subscriber, broker] = localTransport();
            let first = 0;
            let second = 0;
            subscriber.onMessage(() => first++);
            subscriber.onMessage(() => second++);

            broker.postMessage({ type: 'refresh', url: 'a' });
            await settle();
            expect([first, second]).toEqual([1, 1]);
        });

        test('the receiver gets a copy: changing it does not change the sender\'s object', async () => {
            const [subscriber, broker] = localTransport();
            const sent: SubscriberMessage = { type: 'subscribe', tab, url: 'a' };
            broker.onMessage(m => { if (m.type === 'subscribe') m.url = 'changed'; });

            subscriber.postMessage(sent);
            await settle();
            expect(sent.url).toBe('a');
        });

        test('a value that could not cross a real thread boundary throws when posted', () => {
            const [subscriber] = localTransport();
            const bad = { type: 'subscribe', tab, url: () => 'a' } as unknown as SubscriberMessage;
            expect(() => subscriber.postMessage(bad)).toThrow();
        });

        test('two pairs are independent', async () => {
            const [oneSubscriber] = localTransport();
            const [_, twoBroker] = localTransport();
            const got: SubscriberMessage[] = [];

            twoBroker.onMessage(m => got.push(m));
            oneSubscriber.postMessage({ type: 'leave', tab });
            await settle();
            expect(got).toEqual([]);
        });
    });
});