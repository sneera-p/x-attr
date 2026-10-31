import { Modifiers } from '../shared/attrs';
import { parsePairs } from '../shared/parse';

/** Headers the library sets itself; x-headers may not touch them. */
const RESERVED: ReadonlySet<string> = new Set([
    'accept', 
    'content-type', 
    'x-attr-request', 
    'last-event-id'
]);

/** A valid header name (an HTTP token). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** One element's own x-headers, checked. */
function ownHeaders(el: Element): [string, string][] {
    const text = el.getAttribute(Modifiers.HEADERS);
    if (text === null)
        return [];

    const seen = new Set<string>();
    const pairs: [string, string][] = [];
    for (const [name, value] of parsePairs(text, Modifiers.HEADERS)) {
        const key = name.toLowerCase();
        if (!TOKEN.test(name)) 
            throw new Error(`x-headers: "${name}" is not a valid header name: ${text}`);
        
        if (RESERVED.has(key)) 
            throw new Error(`x-headers: "${name}" is set by the library and cannot be changed: ${text}`);
        
        if (seen.has(key)) 
            throw new Error(`x-headers: "${name}" is given twice: ${text}`);
        
        seen.add(key);
        pairs.push([name, value as string]);
    }
    return pairs;
}

/**
 * The headers a request from `el` sends: every x-headers from the outermost ancestor
 * down to `el` itself, merged. A closer one replaces a farther one with the same name
 * (names are case-insensitive). No x-headers anywhere → empty.
 *
 * @throws Error on a bad header name, a reserved name, a name given twice in one
 *         attribute, or anything x-vals would reject
 */
export function extractHeaders(el: Element): Record<string, string> {
    const chain: Element[] = [];
    for (
        let at: Element | null = el.closest(`[${Modifiers.HEADERS}]`); 
        at !== null; 
        at = at.parentElement?.closest(`[${Modifiers.HEADERS}]`) ?? null
    ) chain.push(at);
    
    const merged = new Map<string, [string, string]>();   // lower-case name → [name as written, value]
    for (const owner of chain.reverse())                  // outermost first, so closer ones overwrite
        for (const [name, value] of ownHeaders(owner)) 
            if (value === '')
                merged.delete(name.toLowerCase());
            else
                merged.set(name.toLowerCase(), [name, value]);
        
    return Object.fromEntries(merged.values());
}

// ---- tests (removed from the build) ----

describe('extractHeaders', () => {
    const headers = (html: string, selector: string): Record<string, string> => {
        document.body.innerHTML = html;
        return extractHeaders(document.querySelector(selector)!);
    };

    describe('formats', () => {
        test('no x-headers anywhere gives none', () => {
            expect(headers('<button>go</button>', 'button')).toEqual({});
        });
        test('query string', () => {
            expect(headers('<button x-headers="X-Csrf-Token=abc&X-Tenant=7">go</button>', 'button'))
                .toEqual({ 'X-Csrf-Token': 'abc', 'X-Tenant': '7' });
        });
        test('JSON', () => {
            expect(headers(`<button x-headers='{"X-Tenant": 7}'>go</button>`, 'button')).toEqual({ 'X-Tenant': '7' });
        });
        test('values are percent-decoded', () => {
            expect(headers('<button x-headers="X-Note=a%20b%26c">go</button>', 'button')).toEqual({ 'X-Note': 'a b&c' });
        });
    });

    describe('inheritance', () => {
        test('ancestors add their headers', () => {
            const html = '<body-wrap x-headers="X-Csrf-Token=abc"><section x-headers="X-Tenant=7"><button>go</button></section></body-wrap>';
            expect(headers(html, 'button')).toEqual({ 'X-Csrf-Token': 'abc', 'X-Tenant': '7' });
        });
        test('a closer one replaces a farther one, whatever the case of the name', () => {
            const html = '<div x-headers="X-Tenant=7&X-Csrf-Token=abc"><button x-headers="x-tenant=9">go</button></div>';
            expect(headers(html, 'button')).toEqual({ 'X-Csrf-Token': 'abc', 'x-tenant': '9' });
        });
        test('an element without x-headers still gets its ancestors\'', () => {
            expect(headers('<div x-headers="X-A=1"><p><button>go</button></p></div>', 'button')).toEqual({ 'X-A': '1' });
        });
        test('siblings and descendants do not count', () => {
            const html = '<div><span x-headers="X-A=1"></span><button>go<i x-headers="X-B=2"></i></button></div>';
            expect(headers(html, 'button')).toEqual({});
        });
    });

    describe('errors', () => {
        test('a reserved name throws, in any case', () => {
            for (const name of ['Accept', 'content-type', 'X-Attr-Request', 'LAST-EVENT-ID']) {
                expect(() => headers(`<button x-headers="${name}=x">go</button>`, 'button')).toThrow(/set by the library/);
            }
        });
        test('an invalid header name throws', () => {
            expect(() => headers('<button x-headers="Bad Name=x">go</button>', 'button')).toThrow(/not a valid header name/);
        });
        test('a name given twice in one attribute throws, whatever the case', () => {
            expect(() => headers('<button x-headers="X-A=1&x-a=2">go</button>', 'button')).toThrow(/given twice/);
        });
        test('a bad attribute on an ancestor throws for every element below it', () => {
            expect(() => headers('<div x-headers="Accept=x"><button>go</button></div>', 'button')).toThrow(/Accept/);
        });
        test('JSON errors are reported as x-headers', () => {
            expect(() => headers(`<button x-headers='{"X-A": null}'>go</button>`, 'button')).toThrow(/x-headers "X-A"/);
        });
    });
});