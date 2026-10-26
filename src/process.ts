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
});
