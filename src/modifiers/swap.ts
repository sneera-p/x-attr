import { Modifiers } from "../shared/attrs";
import { cleanup } from "../shared/cleanup";
import type { ElementTag } from "../shared/tag";

const baseDefaultSwap: string = 'innerHTML';

/**
 * Assume the default swap is 'innerHTML'
 * Now what should not have 'innerHTML' as default swap?
 * Those are written here
 */
const defaultSwap: Partial<Record<ElementTag, string>> = {
    area: 'outerHTML',
    base: 'outerHTML',
    br: 'outerHTML',
    col: 'outerHTML',
    embed: 'outerHTML',
    hr: 'outerHTML',
    img: 'outerHTML',
    input: 'outerHTML',
    link: 'outerHTML',
    meta: 'outerHTML',
    source: 'outerHTML',
    track: 'outerHTML',
    wbr: 'outerHTML',
};

/**
 * How the response is inserted.
 *
 * x-swap is read from the clicked element, or the nearest ancestor that has it.
 * Without one, the default depends on the target: void elements (input, img, …)
 * can't have children, so they're replaced; everything else gets innerHTML.
 */
export function resolveSwap(el: Element, target: Element): string {
    const owner = el.closest(`[${Modifiers.SWAP}]`);
    return owner?.getAttribute(Modifiers.SWAP)?.trim()
        ?? defaultSwap[target.localName as ElementTag]
        ?? baseDefaultSwap;
}

/**
 * Inserts `html` relative to `target` and returns the nodes that were inserted,
 * so the caller can process() them. Returning them is the only way to reach them
 * afterwards: inserting moves them out of the template, and for outerHTML the
 * `target` reference points at a node that is no longer in the page.
 *
 * @throws Error on an unknown swap mode
 */
export function swap(target: Element, mode: string, html: string): Node[] {
    if (mode === 'none') {
        return [];
    }
    if (mode === 'delete') {
        cleanup(target);
        target.remove();
        return [];
    }

    const template = document.createElement('template');
    template.innerHTML = html;
    const inserted = [...template.content.childNodes];

    switch (mode) {
        case 'innerHTML':
            for (const child of [...target.children])
                cleanup(child);
            target.replaceChildren(template.content);
            break;
        case 'outerHTML':
            cleanup(target);
            target.replaceWith(template.content);
            break;
        case 'beforebegin':
            target.before(template.content);
            break;
        case 'afterbegin':
            target.prepend(template.content);
            break;
        case 'beforeend':
            target.append(template.content);
            break;
        case 'afterend':
            target.after(template.content);
            break;
        default:
            throw new Error(`Unknown x-swap value: ${mode}`);
    }

    return inserted;
}

// ---- tests (removed from the build) ----

describe('swap', () => {
    // Each swap test starts from:  <div id="before"></div><ul id="t"><li>old</li></ul><div id="after"></div>
    beforeEach(() => {
        document.body.innerHTML = '<div id="before"></div><ul id="t"><li>old</li></ul><div id="after"></div>';
    });

    const target = (): Element => document.getElementById('t')!;
    const body = (): string => document.body.innerHTML;

    describe('swap modes', () => {
        test('innerHTML replaces the children', () => {
            swap(target(), 'innerHTML', '<li>new</li>');
            expect(body()).toBe('<div id="before"></div><ul id="t"><li>new</li></ul><div id="after"></div>');
        });

        test('outerHTML replaces the target itself', () => {
            swap(target(), 'outerHTML', '<ol id="t2"><li>new</li></ol>');
            expect(body()).toBe('<div id="before"></div><ol id="t2"><li>new</li></ol><div id="after"></div>');
        });

        test('beforebegin inserts before the target', () => {
            swap(target(), 'beforebegin', '<p>x</p>');
            expect(body()).toBe('<div id="before"></div><p>x</p><ul id="t"><li>old</li></ul><div id="after"></div>');
        });

        test('afterbegin inserts as the first child', () => {
            swap(target(), 'afterbegin', '<li>first</li>');
            expect(body()).toBe('<div id="before"></div><ul id="t"><li>first</li><li>old</li></ul><div id="after"></div>');
        });

        test('beforeend appends as the last child', () => {
            swap(target(), 'beforeend', '<li>last</li>');
            expect(body()).toBe('<div id="before"></div><ul id="t"><li>old</li><li>last</li></ul><div id="after"></div>');
        });

        test('afterend inserts after the target', () => {
            swap(target(), 'afterend', '<p>x</p>');
            expect(body()).toBe('<div id="before"></div><ul id="t"><li>old</li></ul><p>x</p><div id="after"></div>');
        });

        test('delete removes the target and ignores the html', () => {
            expect(swap(target(), 'delete', '<p>ignored</p>')).toEqual([]);
            expect(body()).toBe('<div id="before"></div><div id="after"></div>');
        });

        test('none changes nothing', () => {
            const before = body();
            expect(swap(target(), 'none', '<p>ignored</p>')).toEqual([]);
            expect(body()).toBe(before);
        });

        test('an unknown mode throws and leaves the page unchanged', () => {
            const before = body();
            expect(() => swap(target(), 'sideways', '<p>x</p>')).toThrow(/sideways/);
            expect(body()).toBe(before);
        });
    });

    describe('returned nodes', () => {
        test('are exactly the inserted top-level nodes, text included', () => {
            const inserted = swap(target(), 'innerHTML', '<li>a</li> text <li>b</li>');

            expect(inserted.map(n => n.nodeName)).toEqual(['LI', '#text', 'LI']);
            expect(inserted.every(n => n.isConnected)).toBe(true);
        });

        test('for outerHTML they are the live replacements, not the old target', () => {
            const old = target();
            const [inserted] = swap(old, 'outerHTML', '<ol id="t2"></ol>');

            expect(old.isConnected).toBe(false);
            expect(inserted).toBe(document.getElementById('t2')!);
        });

        test('tables: a bare <tr> fragment keeps its rows', () => {
            document.body.innerHTML = '<table><tbody id="rows"></tbody></table>';
            const inserted = swap(document.getElementById('rows')!, 'beforeend', '<tr><td>1</td></tr>');

            expect(inserted.map(n => n.nodeName)).toEqual(['TR']);
            expect(document.querySelectorAll('#rows tr').length).toBe(1);
        });
    });
});