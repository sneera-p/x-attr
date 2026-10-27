import { Verbs } from './shared/attrs';
import { HANDLERS } from './handlers';

/**
 * wires node with x-attr properties
*/
function init(node: Element): void {
    const matches = (Object.keys(HANDLERS) as Verbs[])
        .filter(verb => node.hasAttribute(verb));

    if (matches.length > 1) {
        throw new Error(`One verb per element, found: ${matches.join(', ')}`);
    }

    const [verb] = matches;
    if (verb !== undefined) {
        HANDLERS[verb](node, process);
    }
}


const SELECTOR = Object.values(Verbs).map(v => `[${v}]`).join(',');
const PROCESSED: unique symbol = Symbol('sneera:x-attr:processed');

type ProcessedElement = Element & {
    [PROCESSED]?: true;
}

/**
 * Wires every x-* element in `node` (itself included) that isn't wired yet.
 * Accepts any Node: swaps hand over text and comment nodes too, which are skipped.
 */
export function process(node: Node): void {
    if (!(node instanceof Element)) {
        return;
    }

    const elements = [...node.querySelectorAll(SELECTOR)];
    if (node.matches(SELECTOR)) {
        elements.unshift(node);
    }

    for (const element of elements as ProcessedElement[]) {
        if (element[PROCESSED] !== true) {
            element[PROCESSED] = true;
            init(element);
        }
    }
}

// ---- tests (removed from the build) ----

describe('process', () => {
    const isProcessed = (el: Element): boolean => (el as ProcessedElement)[PROCESSED] === true;

    function start(html: string): void {
        document.body.innerHTML = html;
                process(document.body);
    }

    function click(selector: string): void {
        const el = document.querySelector<HTMLElement>(selector);
        if (el === null) {
            throw new Error(`test markup has no ${selector}`);
        }
        el.click();
    }

    describe('discovery', () => {
        test('finds x-* elements under the root', () => {
            start(`
                <div><button x-get="/a">A</button></div>
                <span>not me</span>
                <form x-get="/b"></form>
            `);

            expect(isProcessed(document.querySelector('button')!)).toBe(true);
            expect(isProcessed(document.querySelector('form')!)).toBe(true);
            expect(isProcessed(document.querySelector('span')!)).toBe(false);
        });

        test('includes the root element itself', () => {
            document.body.innerHTML = '<button x-get="/a">A</button>';
            const button = document.querySelector('button')!;
                        process(button);

            expect(isProcessed(button)).toBe(true);
        });

        test('non-element nodes are ignored', () => {
            expect(() => process(document.createTextNode('hi'))).not.toThrow();
            expect(() => process(document.createComment('hi'))).not.toThrow();
        });
    });

    describe('binding (init)', () => {
        test('an element with no verb gets no handler', () => {
            start('<button x-target="#out">Nothing</button><div id="out"></div>');
            click('button');
            expect(server.requested).toEqual([]);
        });

        test('two verbs on one element throws, naming both', () => {
            document.body.innerHTML = '<button x-get="/a" x-post="/b">Both</button>';
            expect(() => process(document.body)).toThrow(/x-get.*x-post|x-post.*x-get/);
        });

        test('processing twice binds once', () => {
            start('<button x-get="/a">A</button>');
            process(document.body);

            click('button');

            expect(server.requested.length).toBe(1);
        });

        test('an element that threw is not retried on the next process', () => {
            document.body.innerHTML = '<button x-get="/a" x-post="/b">Both</button>';
            
            expect(() => process(document.body)).toThrow();
            expect(() => process(document.body)).not.toThrow();
        });
    });

    describe('re-processing swapped content', () => {
        test('an x-get inside the response works', async () => {
            server.routes['/first'] = '<button id="next" x-get="/second" x-target="#out">Next</button>';
            server.routes['/second'] = '<p>second</p>';
            start('<button id="go" x-get="/first" x-target="#out">Go</button><div id="out"></div>');

            click('#go');
            await settle();
            click('#next');
            await settle();

            expect(server.requested).toEqual(['/first', '/second']);
            expect(document.getElementById('out')!.innerHTML).toBe('<p>second</p>');
        });

        test('nested x-get elements in the response work too', async () => {
            server.routes['/panel'] = '<section><div><a id="deep" x-get="/deep" x-target="#out">Deep</a></div></section>';
            server.routes['/deep'] = 'deep';
            start('<button x-get="/panel" x-target="#slot">Open</button><div id="slot"></div><div id="out"></div>');

            click('button');
            await settle();
            click('#deep');
            await settle();

            expect(document.getElementById('out')!.innerHTML).toBe('deep');
        });

        test('outerHTML: the replacement element is live and bound exactly once', async () => {
            server.routes['/toggle'] = '<button id="btn" x-get="/toggle" x-swap="outerHTML">Again</button>';
            start('<button id="btn" x-get="/toggle" x-swap="outerHTML">Start</button>');

            click('#btn');
            await settle();
            expect(document.getElementById('btn')!.textContent).toBe('Again');

            click('#btn');
            await settle();

            // two clicks → two requests; a double-bound replacement would make it three
            expect(server.requested.length).toBe(2);
        });

        test('elements already on the page are not bound twice by a swap', async () => {
            server.routes['/content'] = '<p>content</p>';
            start('<button id="go" x-get="/content" x-target="#out">Go</button><div id="out"></div>');

            click('#go');
            await settle();
            click('#go');
            await settle();

            expect(server.requested.length).toBe(2);
        });
    });

    describe('infinite scroll (revealed sentinel)', () => {
        test('each sentinel loads the next page and is replaced by its rows plus the next sentinel', async () => {
            server.routes['/jobs?before=3'] =
                '<li id="j2">job 2</li><li id="j1">job 1</li>' +
                '<li id="more" x-get="/jobs?before=1" x-trigger="revealed" x-swap="outerHTML">loading…</li>';
            server.routes['/jobs?before=1'] = '<li id="j0">job 0</li>';   // last page: no sentinel

            start(
                '<ul id="jobs"><li id="j3">job 3</li>' +
                '<li id="more" x-get="/jobs?before=3" x-trigger="revealed" x-swap="outerHTML">loading…</li></ul>',
            );
            const ids = (): string[] => [...document.querySelectorAll('#jobs li')].map(li => li.id);

            viewport.reveal(document.getElementById('more')!);
            await settle();
            expect(ids()).toEqual(['j3', 'j2', 'j1', 'more']);

            viewport.reveal(document.getElementById('more')!);   // the new sentinel, from page 2
            await settle();
            expect(ids()).toEqual(['j3', 'j2', 'j1', 'j0']);

            expect(server.requested).toEqual(['/jobs?before=3', '/jobs?before=1']);
        });
    });

    describe('end to end: SSE', () => {
        // Channels outlive a test (an element removed by the test reset never hears another
        // message, so it never unsubscribes), so each test uses its own stream URL.
        const send = (text: string): void => server.streams[0]!.send(text);

        test('a job board: new rows from the stream, each row then updates itself', async () => {
            server.routes['/live1'] = { stream: true };
            start(`
                <ul id="jobs" x-get="/live1" x-trigger="sse jobs:new" x-swap="afterbegin">
                    <li id="job-1" x-get="/live1" x-trigger="sse job:1" x-swap="outerHTML">1 open</li>
                </ul>
            `);
            await settle();

            // a new job arrives, already wired to its own event
            send('event: jobs:new\ndata: <li id="job-2" x-get="/live1" x-trigger="sse job:2" x-swap="outerHTML">2 open</li>\n\n');
            await settle();
            expect(isProcessed(document.getElementById('job-2')!)).toBe(true);

            // both rows update independently, over the one connection
            send('event: job:2\ndata: <li id="job-2" x-get="/live1" x-trigger="sse job:2" x-swap="outerHTML">2 done</li>\n\n');
            send('event: job:1\ndata: <li id="job-1" x-get="/live1" x-trigger="sse job:1" x-swap="outerHTML">1 done</li>\n\n');
            await settle();
            const rows = (): string[] => [...document.querySelectorAll('#jobs li')].map(li => li.textContent!);
            expect(rows()).toEqual(['2 done', '1 done']);

            // a replaced row keeps listening
            send('event: job:1\ndata: <li id="job-1" x-get="/live1" x-trigger="sse job:1" x-swap="outerHTML">1 paid</li>\n\n');
            await settle();
            expect(rows()).toEqual(['2 done', '1 paid']);

            // deleted: empty data removes the row
            send('event: job:2\ndata:\n\n');
            await settle();
            expect(rows()).toEqual(['1 paid']);

            expect(server.requested).toEqual(['/live1']);
        });

        test('streamed HTML can carry ordinary x-get elements, and they work', async () => {
            server.routes['/live2'] = { stream: true };
            server.routes['/job/9'] = '<p>details</p>';
            start('<div id="box" x-get="/live2" x-trigger="sse note"></div><div id="out"></div>');
            await settle();

            send('event: note\ndata: <button x-get="/job/9" x-target="#out">open</button>\n\n');
            await settle();
            click('#box button');
            await settle();

            expect(document.getElementById('out')!.innerHTML).toBe('<p>details</p>');
        });

        test('reconnect replays from the last id; the hidden input covers the first connect', async () => {
            server.routes['/live3?lastEventId=10-0'] = { stream: true };
            start(`
                <input type="hidden" id="sse-from" name="lastEventId" value="10-0">
                <ul id="t" x-get="/live3" x-include="#sse-from" x-trigger="sse jobs:new" x-swap="beforeend"></ul>
            `);
            await settle();
            expect(server.streams[0]!.lastEventId).toBeNull();

            send('retry: 10\nid: 11-0\nevent: jobs:new\ndata: <li>a</li>\n\n');
            await settle();
            server.streams[0]!.end();
            await settle(10);

            expect(server.requested).toEqual(['/live3?lastEventId=10-0', '/live3?lastEventId=10-0']);
            expect(server.streams[1]!.lastEventId).toBe('11-0');
            server.streams[1]!.send('event: jobs:new\ndata: <li>b</li>\n\n');
            await settle();
            expect(document.getElementById('t')!.innerHTML).toBe('<li>a</li><li>b</li>');
        });

        test('x:refresh from the server reloads the page; x:redirect navigates', async () => {
            server.routes['/live4'] = { stream: true };
            start('<div x-get="/live4" x-trigger="sse a"></div>');
            await settle();
            send('event: x:refresh\ndata: stale\n\n');
            await settle();
            expect(page.reloads).toBe(1);
            expect(server.streams[0]!.closed).toBe(true);

            // the fake reload leaves the page here: the same URL gets a fresh connection
            start('<div x-get="/live4" x-trigger="sse a"></div>');
            await settle();
            server.streams[1]!.send('event: x:redirect\ndata: /login\n\n');
            await settle();
            expect(page.navigated).toEqual(['/login']);
        });

        test('replacing the page section closes the stream once its last listener is gone', async () => {
            server.routes['/live5'] = { stream: true };
            server.routes['/other'] = '<p>no live parts</p>';
            start('<main id="m"><p x-get="/live5" x-trigger="sse a">x</p></main><a href="/other" x-get="/other" x-target="#m">go</a>');
            await settle();

            click('a');
            await settle();
            send('event: a\ndata: late\n\n');
            await settle();

            expect(document.getElementById('m')!.innerHTML).toBe('<p>no live parts</p>');
            expect(server.streams[0]!.closed).toBe(true);
        });
    });

    describe('cleanup on swap', () => {
        test('swapping a section away closes its stream at once, without waiting for a message', async () => {
            server.routes['/live-c1'] = { stream: true };
            server.routes['/other'] = '<p>invoices</p>';
            start('<main id="m"><ul x-get="/live-c1" x-trigger="sse jobs:new"></ul></main><a href="/other" x-get="/other" x-target="#m">go</a>');
            await settle();

            click('a');
            await settle();
            expect(server.streams[0]!.closed).toBe(true);
        });

        test('outerHTML self-replace keeps the one connection and its Last-Event-ID', async () => {
            server.routes['/live-c2'] = { stream: true };
            const row = (v: string): string => `<p id="r" x-get="/live-c2" x-trigger="sse r" x-swap="outerHTML">${v}</p>`;
            start(row('v1'));
            await settle();

            server.streams[0]!.send(`id: 3-0\nevent: r\ndata: ${row('v2')}\n\n`);
            await settle();
            server.streams[0]!.send(`event: r\ndata: ${row('v3')}\n\n`);
            await settle();

            expect(document.getElementById('r')!.textContent).toBe('v3');
            expect(server.requested).toEqual(['/live-c2']);
            expect(server.streams[0]!.closed).toBe(false);
        });

        test('every: polling stops when swapped away', async () => {
            server.routes['/tick'] = 'tick';
            server.routes['/other'] = '<p>gone</p>';
            start('<main id="m"><span x-get="/tick" x-trigger="every 20ms"></span></main><a href="/other" x-get="/other" x-target="#m">go</a>');
            click('a');
            await settle();
            await settle(60);
            expect(server.requested).toEqual(['/other']);
        });

        test('revealed: the observer stops watching when swapped away', async () => {
            server.routes['/other'] = '<p>gone</p>';
            start('<main id="m"><div id="s" x-get="/more" x-trigger="revealed"></div></main><a href="/other" x-get="/other" x-target="#m">go</a>');
            const sentinel = document.getElementById('s')!;
            click('a');
            await settle();
            expect(viewport.isObserved(sentinel)).toBe(false);
        });

        test('an in-flight request of a swapped-away element is aborted, not swapped in late', async () => {
            server.routes['/slow'] = { body: '<b>late</b>', delay: 30 };
            server.routes['/other'] = '<p>now</p>';
            start('<main id="m"><div x-get="/slow" x-trigger="load"></div></main><a href="/other" x-get="/other" x-target="#m">go</a>');
            click('a');
            await settle(40);
            expect(document.getElementById('m')!.innerHTML).toBe('<p>now</p>');
        });
    });
});