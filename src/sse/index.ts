import { createBroker } from './broker';
import { createSubscriber, type Subscriber, type SubscriptionError } from './subscriber';
import { localTransport } from './transport';

export type { SubscriptionError };

let tab: Subscriber | undefined;

/** This tab's subscriber, created on first use: a page with no SSE elements never builds one. */
function subscriber(): Subscriber {
    if (tab === undefined) {
        const [subscriber, broker] = localTransport();
        createBroker([broker]);
        tab = createSubscriber(subscriber);
        addEventListener('pagehide', tab.leave);
    }
    return tab;
}

export const subscribe: Subscriber['subscribe'] = (...args) => subscriber().subscribe(...args);
