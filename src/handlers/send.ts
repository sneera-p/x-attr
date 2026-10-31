import { bind } from '../fire/bind';
import { createFire, type Method } from '../fire/request';
import { resolveTrigger } from '../modifiers/trigger';
import { Verbs } from '../shared/attrs';
import { cleanup, onCleanup } from '../shared/cleanup';

type Handler = (node: Element, reprocess: (node: Node) => void) => void;

/**
 * The handler for a verb that sends a request: on its trigger, send `method` to the URL
 * in `attr` and swap the response in. POST, PUT and PATCH send the values as a multipart
 * body; DELETE sends them in the query string. Triggers, targets, swaps, x-headers,
 * redirects and error events work exactly as for x-get.
 *
 * @throws Error (from the handler) on an element without `attr`, or on an sse trigger:
 *         a stream is always a GET
 */
function sender(attr: Verbs, method: Exclude<Method, 'GET'>): Handler {
    return (node, reprocess) => {
        const url = node.getAttribute(attr);
        if (url === null)
            throw new Error(`${attr} handler called on an element without ${attr}`);

        const trigger = resolveTrigger(node);
        if (trigger.kind === 'sse')
            throw new Error(`${attr} cannot use an sse trigger (streams are GET; use x-get): ${url}`);

        const { fire, abort } = createFire(node, url, method, reprocess);
        onCleanup(node, abort);
        bind(node, trigger, () => void fire());
    };
}

export const post: Handler = sender(Verbs.POST, 'POST');
export const put: Handler = sender(Verbs.PUT, 'PUT');
export const patch: Handler = sender(Verbs.PATCH, 'PATCH');
export const del: Handler = sender(Verbs.DELETE, 'DELETE');   // `delete` is a reserved word

// ---- tests (removed from the build) ----

describe('send handlers', () => {
    /** Records the method and body of every request, then lets the fake server answer it. */
    let sent: { method: string; body: FormData | null }[];
    let realFetch: typeof fetch;
    beforeEach(() => {
        sent = [];
        realFetch = globalThis.fetch;
        globalThis.fetch = ((input: string, init?: RequestInit) => {
            sent.push({ method: init?.method ?? 'GET', body: init?.body instanceof FormData ? init.body : null });
            return realFetch(input, init);
        }) as typeof fetch;
    });
    afterEach(() => { globalThis.fetch = realFetch; });

    const wire = (handler: Handler, html: string, selector: string): HTMLElement => {
        document.body.innerHTML = html;
        const el = document.querySelector<HTMLElement>(selector)!;
        handler(el, () => {});
        return el;
    };

    const verbs: [string, Handler, string][] = [
        ['x-post', post, 'POST'],
        ['x-put', put, 'PUT'],
        ['x-patch', patch, 'PATCH'],
        ['x-delete', del, 'DELETE'],
    ];

    for (const [attr, handler, method] of verbs) {
        describe(attr, () => {
            test(`throws when the element has no ${attr}`, () => {
                document.body.innerHTML = '<button>none</button>';
                expect(() => handler(document.querySelector('button')!, () => {})).toThrow(attr);
            });

            test('an sse trigger throws', () => {
                document.body.innerHTML = `<div ${attr}="/a" x-trigger="sse jobs"></div>`;
                expect(() => handler(document.querySelector('div')!, () => {})).toThrow(/sse/);
            });

            test('sends nothing until triggered', () => {
                wire(handler, `<button ${attr}="/jobs/1">go</button>`, 'button');
                expect(sent).toEqual([]);
            });

            test(`its trigger sends ${method} to its URL and swaps the response in`, async () => {
                server.routes['/jobs/1'] = '<p>done</p>';
                const button = wire(handler, `<button ${attr}="/jobs/1" x-target="#out">go</button><div id="out"></div>`, 'button');

                button.click();
                await settle();

                expect(server.requested).toEqual(['/jobs/1']);
                expect(sent[0]!.method).toBe(method);
                expect(document.getElementById('out')!.innerHTML).toBe('<p>done</p>');
            });

            test('cleanup aborts a request in flight', async () => {
                server.routes['/slow'] = { body: '<p>late</p>', delay: 10 };
                const button = wire(handler, `<main id="m"><button ${attr}="/slow" x-target="#out">go</button></main><div id="out">empty</div>`, 'button');

                button.click();
                cleanup(document.getElementById('m')!);
                await settle(20);

                expect(document.getElementById('out')!.innerHTML).toBe('empty');
            });
        });
    }

    describe('where the values go', () => {
        test('POST, PUT and PATCH send them as the body', async () => {
            for (const [attr, handler] of verbs.filter(([, , m]) => m !== 'DELETE')) {
                sent = [];
                server.requested = [];
                const button = wire(handler, `<form><input name="plate" value="CAB-1"><button ${attr}="/jobs/1">go</button></form>`, 'button');
                button.click();
                await settle();
                expect(server.requested).toEqual(['/jobs/1']);
                expect([...sent[0]!.body!]).toEqual([['plate', 'CAB-1']]);
            }
        });

        test('DELETE sends them in the query string, with no body', async () => {
            const button = wire(del, '<button x-delete="/jobs/1" x-vals="reason=dup">delete</button>', 'button');
            button.click();
            await settle();
            expect(server.requested).toEqual(['/jobs/1?reason=dup']);
            expect(sent[0]!.body).toBeNull();
        });

        test('a form submit sends without navigating', () => {
            const form = wire(put, '<form x-put="/jobs/1"></form>', 'form');
            const submit = new Event('submit', { cancelable: true });
            form.dispatchEvent(submit);
            expect(submit.defaultPrevented).toBe(true);
        });

        test('x-headers are sent too', async () => {
            const button = wire(patch, '<div x-headers="X-Csrf-Token=abc"><button x-patch="/jobs/1">go</button></div>', 'button');
            button.click();
            await settle();
            expect(server.headers[0]!.get('X-Csrf-Token')).toBe('abc');
        });
    });
});