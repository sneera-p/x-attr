import { Verbs } from '../shared/attrs';
import { resolveTarget } from '../modifiers/target';
import { resolveSwap, swap } from '../modifiers/swap';
import { resolveTrigger } from '../modifiers/trigger';
import { collectValues } from '../shared/values';

/** Navigates the whole page. A variable so the tests can replace it. */
let navigate = (url: string): void => {
    location.assign(url);
};

/**
 * Wires an x-get element: on its trigger, fetch the URL (with the element's values
 * as a query string) and swap the response in.
 *
 * - `reprocess` is called for every inserted node, so x-* elements in the response
 *   become live. It's passed in (not imported) to avoid a process.ts ↔ get.ts cycle.
 * - Latest request wins: a new request aborts this element's previous one.
 * - `X-Redirect: <url>` on the response navigates the page instead of swapping.
 * - Non-2xx responses dispatch `x:responseError`; network failures `x:sendError`.
 *   Both bubble from the element, so one listener on document can handle all of them.
 */
export function get(node: Element, reprocess: (node: Node) => void): void {
    const url = node.getAttribute(Verbs.GET);
    if (url === null) {
        throw new Error('get() called on an element without x-get');
    }

    const trigger = resolveTrigger(node);
    let inflight: AbortController | undefined;

    const fire = async (): Promise<void> => {
        if (inflight) {
            inflight.abort();
        }
        const controller = new AbortController();
        inflight = controller;

        const target = resolveTarget(node);
        const mode = resolveSwap(node, target);
        const requestUrl = withQuery(url, collectValues(node));

        let response: Response;
        let html: string;
        try {
            response = await fetch(requestUrl, { signal: controller.signal });
            html = await response.text();
        } catch (error) {
            if (controller.signal.aborted) {
                return;   // replaced by a newer request: not an error
            }
            emit(node, 'x:sendError', { 
                url: requestUrl, 
                error: error 
            });
            return;
        }

        // aborted after the body arrived, or the element was removed meanwhile
        if (controller.signal.aborted || !node.isConnected) {
            return;
        }

        const redirect = response.headers.get('X-Redirect');
        if (redirect !== null) {
            navigate(redirect);
            return;
        }

        if (!response.ok) {
            emit(node, 'x:responseError', { 
                url: requestUrl, 
                status: response.status 
            });
            return;
        }

        for (const inserted of swap(target, mode, html)) {
            reprocess(inserted);
        }
    };

    switch (trigger.kind) {
        case 'load':
            void fire();
            return;

        case 'every': {
            const timer = setInterval(() => {
                if (!node.isConnected) {
                    clearInterval(timer);   // element left the page: stop polling
                    return;
                }
                void fire();
            }, trigger.interval);
            return;
        }

        case 'event': {
            let debounce: ReturnType<typeof setTimeout> | undefined;
            node.addEventListener(trigger.event, e => {
                // forms, links and submit buttons would also navigate the page
                if (trigger.event === 'submit' || node.matches('a') || isSubmitButton(node)) {
                    e.preventDefault();
                }
                
                if (trigger.delay === 0) {
                    void fire();
                } else {
                    clearTimeout(debounce);
                    debounce = setTimeout(() => void fire(), trigger.delay);
                }
            });
            return;
        }
    }
}

/** 
 * A button whose click would submit its form: 
 * <button> (type defaults to submit) or <input type=submit|image>. 
 */
function isSubmitButton(el: Element): boolean {
    if (el instanceof HTMLButtonElement) {
        return el.type === 'submit';
    }
    return el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'image');
}

/** 
 * Appends params to a URL that may already have a query string. 
 * Same-origin URLs stay relative. 
 */
function withQuery(url: string, params: URLSearchParams): string {
    if (params.size === 0) {
        return url;
    }
    const full = new URL(url, location.href);
    for (const [key, value] of params) {
        full.searchParams.append(key, value);
    }
    return full.origin === location.origin ? full.pathname + full.search : full.href;
}

function emit(el: Element, name: string, detail: object): void {
    el.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
}

// ---- tests (removed from the build) ----

describe('get', () => {
    // fetch and settle come from test/setup.ts; navigate is this module's, so it's replaced here
    const realNavigate = navigate;
    let navigated: string[] = [];   // every URL passed to navigate()

    beforeEach(() => {
        navigated = [];
        navigate = url => { navigated.push(url); };
    });

    afterEach(() => {
        navigate = realNavigate;
    });

    /** Renders `html`, wires the element matching `selector`, returns it and the nodes it reprocessed. */
    function wire(html: string, selector: string) {
        document.body.innerHTML = html;
        const el = document.querySelector<HTMLElement>(selector);
        if (el === null) {
            throw new Error(`test markup has no ${selector}`);
        }
        const reprocessed: Node[] = [];   // every node get() handed to reprocess
        get(el, node => reprocessed.push(node));
        return { el, reprocessed };
    }

    /** Collects the detail of every `name` event that bubbles to document during a test. */
    function events(name: string): unknown[] {
        const seen: unknown[] = [];
        document.addEventListener(name, e => seen.push((e as CustomEvent).detail));
        return seen;
    }

    const out = (): string => document.getElementById('out')!.innerHTML;

    describe('basics', () => {
        test('throws when the element has no x-get', () => {
            document.body.innerHTML = '<button>none</button>';
            expect(() => get(document.querySelector('button')!, () => {})).toThrow(/x-get/);
        });

        test('sends nothing until triggered', () => {
            wire('<button x-get="/a">A</button>', 'button');
            expect(server.requested).toEqual([]);
        });

        test('swaps the response into x-target', async () => {
            server.routes['/jobs/42'] = '<p>Job 42</p>';
            const { el } = wire('<button x-get="/jobs/42" x-target="#out">Show</button><div id="out">empty</div>', 'button');

            el.click();
            await settle();

            expect(server.requested).toEqual(['/jobs/42']);
            expect(out()).toBe('<p>Job 42</p>');
        });

        test('x-swap is read from the clicked element, not from the target', async () => {
            server.routes['/row'] = '<li>new</li>';
            const { el } = wire('<button x-get="/row" x-target="#list" x-swap="beforeend">Add</button><ul id="list"><li>old</li></ul>', 'button');

            el.click();
            await settle();

            expect(document.getElementById('list')!.innerHTML).toBe('<li>old</li><li>new</li>');
        });

        test('reprocess is called once per inserted node, with the live nodes', async () => {
            server.routes['/two'] = '<p id="one">1</p><p id="two">2</p>';
            const { el, reprocessed } = wire('<button x-get="/two" x-target="#out">Go</button><div id="out"></div>', 'button');

            el.click();
            await settle();

            expect(reprocessed).toEqual([document.getElementById('one')!, document.getElementById('two')!]);
            expect(reprocessed.every(n => n.isConnected)).toBe(true);
        });

        test('outerHTML: reprocess gets the replacement, not the removed element', async () => {
            server.routes['/self'] = '<button id="new">new</button>';
            const { el, reprocessed } = wire('<button id="old" x-get="/self" x-swap="outerHTML">old</button>', 'button');

            el.click();
            await settle();

            expect(el.isConnected).toBe(false);
            expect(reprocessed).toEqual([document.getElementById('new')!]);
        });
    });

    describe('1. values in the query string', () => {
        test('an input sends its own name and value', async () => {
            const { el } = wire('<input name="q" value="brake pads" x-get="/search" x-trigger="input">', 'input');

            el.dispatchEvent(new Event('input'));
            await settle();

            expect(server.requested).toEqual(['/search?q=brake+pads']);
        });

        test('a form sends all its fields', async () => {
            const { el } = wire('<form x-get="/jobs"><input name="plate" value="CAB-1"><input name="status" value="open"></form>', 'form');

            el.dispatchEvent(new Event('submit', { cancelable: true }));
            await settle();

            expect(server.requested).toEqual(['/jobs?plate=CAB-1&status=open']);
        });

        test('values are appended to a URL that already has a query', async () => {
            const { el } = wire('<button x-get="/jobs?page=2" x-vals=\'{"status":"open"}\'>go</button>', 'button');

            el.click();
            await settle();

            expect(server.requested).toEqual(['/jobs?page=2&status=open']);
        });

        test('values are read when the request fires, not when the element is wired', async () => {
            const { el } = wire('<input name="q" value="old" x-get="/search" x-trigger="input">', 'input');

            (el as HTMLInputElement).value = 'new';
            el.dispatchEvent(new Event('input'));
            await settle();

            expect(server.requested).toEqual(['/search?q=new']);
        });
    });

    describe('2. X-Redirect', () => {
        test('navigates instead of swapping, whatever the status', async () => {
            server.routes['/secret'] = { status: 204, headers: { 'X-Redirect': '/staff/login' } };
            const { el, reprocessed } = wire('<button x-get="/secret" x-target="#out">Go</button><div id="out">untouched</div>', 'button');

            el.click();
            await settle();

            expect(navigated).toEqual(['/staff/login']);
            expect(out()).toBe('untouched');
            expect(reprocessed).toEqual([]);
        });
    });

    describe('3. no page navigation', () => {
        test('a button inside a form does not submit the form', () => {
            const { el } = wire('<form><button x-get="/preview">Preview</button></form>', 'button');
            let submitted = false;
            document.querySelector('form')!.addEventListener('submit', () => { submitted = true; });

            const click = new MouseEvent('click', { bubbles: true, cancelable: true });
            el.dispatchEvent(click);

            expect(click.defaultPrevented).toBe(true);
            expect(submitted).toBe(false);
        });

        test('<input type="submit"> and links are prevented too', () => {
            for (const [html, selector] of [['<form><input type="submit" x-get="/a"></form>', 'input'], ['<a href="/page" x-get="/a">a</a>', 'a']] as const) {
                const { el } = wire(html, selector);
                const click = new MouseEvent('click', { bubbles: true, cancelable: true });
                el.dispatchEvent(click);
                expect(click.defaultPrevented).toBe(true);
            }
        });

        test('a type="button" button is left alone', () => {
            const { el } = wire('<button type="button" x-get="/a">a</button>', 'button');
            const click = new MouseEvent('click', { bubbles: true, cancelable: true });
            el.dispatchEvent(click);
            expect(click.defaultPrevented).toBe(false);
        });
    });

    describe('4. error events', () => {
        test('a non-2xx response dispatches x:responseError and swaps nothing', async () => {
            const errors = events('x:responseError');
            const { el, reprocessed } = wire('<button x-get="/missing" x-target="#out">Go</button><div id="out">empty</div>', 'button');

            el.click();
            await settle();

            expect(errors).toEqual([{ url: '/missing', status: 404 }]);
            expect(out()).toBe('empty');
            expect(reprocessed).toEqual([]);
        });

        test('a network failure dispatches x:sendError instead of an unhandled rejection', async () => {
            server.routes['/down'] = { fail: true };
            const errors = events('x:sendError');
            const { el } = wire('<button x-get="/down" x-target="#out">Go</button><div id="out">empty</div>', 'button');

            el.click();
            await settle();

            expect(errors.length).toBe(1);
            expect((errors[0] as { url: string; error: Error }).url).toBe('/down');
            expect((errors[0] as { url: string; error: Error }).error).toBeInstanceOf(TypeError);
            expect(out()).toBe('empty');
        });
    });

    describe('5. latest request wins', () => {
        test('a slow earlier response never overwrites a newer one', async () => {
            server.routes['/search?q=a'] = { body: 'results for a', delay: 50 };
            server.routes['/search?q=ab'] = 'results for ab';
            const { el } = wire('<input name="q" value="a" x-get="/search" x-trigger="input" x-target="#out"><div id="out"></div>', 'input');

            el.dispatchEvent(new Event('input'));          // slow request
            (el as HTMLInputElement).value = 'ab';
            el.dispatchEvent(new Event('input'));          // fast request, aborts the slow one
            await settle(60);

            expect(server.requested).toEqual(['/search?q=a', '/search?q=ab']);
            expect(out()).toBe('results for ab');
        });

        test('an aborted request dispatches no error event', async () => {
            server.routes['/slow'] = { body: 'x', delay: 30 };
            const errors = [...events('x:sendError'), ...events('x:responseError')];
            const { el } = wire('<button x-get="/slow">go</button>', 'button');

            el.click();
            el.click();
            await settle(40);

            expect(errors).toEqual([]);
        });

        test('a response for an element removed from the page is dropped', async () => {
            server.routes['/slow'] = { body: '<p>late</p>', delay: 20 };
            const { el } = wire('<div id="wrap"><button x-get="/slow" x-target="#out">go</button></div><div id="out">empty</div>', 'button');

            el.click();
            document.getElementById('wrap')!.remove();
            await settle(30);

            expect(out()).toBe('empty');
        });
    });

    describe('6. trigger kinds', () => {
        test('delay debounces: only the last event in a burst sends', async () => {
            const { el } = wire('<input name="q" value="" x-get="/search" x-trigger="input delay:30ms">', 'input');
            const input = el as HTMLInputElement;

            for (const value of ['b', 'br', 'bra']) {
                input.value = value;
                input.dispatchEvent(new Event('input'));
                await settle(5);   // faster than the delay
            }
            await settle(40);

            expect(server.requested).toEqual(['/search?q=bra']);
        });

        test('load sends once, immediately', async () => {
            server.routes['/panel'] = 'loaded';
            wire('<div x-get="/panel" x-trigger="load">loading…</div>', 'div');
            await settle();

            expect(server.requested).toEqual(['/panel']);
            expect(document.querySelector('div')!.innerHTML).toBe('loaded');
        });

        test('every polls, and stops once the element leaves the page', async () => {
            server.routes['/count'] = 'n';
            const { el } = wire('<div x-get="/count" x-trigger="every 20ms"></div>', 'div');

            await settle(50);              // ~2 ticks
            const whileOnPage = server.requested.length;
            el.remove();
            await settle(60);              // ~3 more ticks, but removed

            expect(whileOnPage).toBeGreaterThanOrEqual(2);
            expect(server.requested.length).toBe(whileOnPage);
        });
    });
});