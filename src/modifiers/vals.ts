import { Modifiers } from '../shared/attrs';
import type { Entry } from '../shared/form';

/** 
 * @throws Error on invalid JSON, a non-object, or a nested / null value
 */
function parseJsonVals(text: string): Entry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`x-vals is not valid JSON: ${text}`);
    }

    
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`x-vals must be a JSON object: ${text}`);
    }

    return Object.entries(parsed).map(([key, value]) => {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
            throw new Error(`x-vals "${key}" must be a string, number or boolean: ${text}`);
        }
        return [key, String(value)];
    });
}

export function extractVals(el: Element): Entry[] {
    const text = el.getAttribute(Modifiers.VALS)?.trim();
    if (text === undefined || text === '') {
        return [];
    }
    return text.startsWith('{') 
        ? parseJsonVals(text) 
        : [...new URLSearchParams(text)];
}

// ---- tests (removed from the build) ----

// ---- tests (removed from the build) ----

describe('vals', () => {
    const vals = (attr: string | null): Entry[] => {
        document.body.innerHTML = '<button>go</button>';
        const button = document.querySelector('button')!;
        if (attr !== null) button.setAttribute('x-vals', attr);
        return extractVals(button);
    };

    describe('no values', () => {
        test('no x-vals', () => {
            expect(vals(null)).toEqual([]);
        });
        test('an empty or blank x-vals', () => {
            expect(vals('')).toEqual([]);
            expect(vals('   ')).toEqual([]);
        });
    });

    describe('query string', () => {
        test('name=value pairs, in order', () => {
            expect(vals('status=open&page=2')).toEqual([['status', 'open'], ['page', '2']]);
        });
        test('repeated names keep every value', () => {
            expect(vals('s[]=3&s[]=7')).toEqual([['s[]', '3'], ['s[]', '7']]);
        });
        test('percent-encoding and + are decoded', () => {
            expect(vals('q=brake+pads%20%26%20discs&eq=a%3Db')).toEqual([['q', 'brake pads & discs'], ['eq', 'a=b']]);
        });
        test('a name without = has an empty value', () => {
            expect(vals('flag&page=2')).toEqual([['flag', ''], ['page', '2']]);
        });
        test('a leading ? is ignored', () => {
            expect(vals('?page=2')).toEqual([['page', '2']]);
        });
        test('surrounding whitespace is ignored', () => {
            expect(vals('  page=2  ')).toEqual([['page', '2']]);
        });
        test('an encoded { does not switch to JSON', () => {
            expect(vals('%7Bkey=v')).toEqual([['{key', 'v']]);
        });
    });

    describe('JSON (starts with "{")', () => {
        test('strings, numbers and booleans become strings, in order', () => {
            expect(vals('{"status":"open","page":2,"urgent":true}'))
                .toEqual([['status', 'open'], ['page', '2'], ['urgent', 'true']]);
        });
        test('leading whitespace before { still means JSON', () => {
            expect(vals('  {"page": 2}')).toEqual([['page', '2']]);
        });
        test('an empty object gives nothing', () => {
            expect(vals('{}')).toEqual([]);
        });
        test('invalid JSON throws', () => {
            expect(() => vals('{status:open}')).toThrow(/JSON/);
        });
        test('nested, null and array values throw, naming the key', () => {
            expect(() => vals('{"a":{"b":1}}')).toThrow(/"a"/);
            expect(() => vals('{"a":null}')).toThrow(/"a"/);
            expect(() => vals('{"a":[1]}')).toThrow(/"a"/);
        });
    });

    test('an array is a query string, not JSON (it does not start with {)', () => {
        expect(vals('["a"]')).toEqual([['["a"]', '']]);
    });
});