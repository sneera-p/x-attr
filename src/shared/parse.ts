import { Modifiers } from '../shared/attrs';
import type { Entry } from '../shared/form';

/** 
 * @throws Error on invalid JSON, a non-object, or a nested / null value
 */
function parseJsonVals(text: string, attr: Modifiers): Entry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`${attr} is not valid JSON: ${text}`);
    }


    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error(`${attr} must be a JSON object: ${text}`);

    return Object.entries(parsed).map(([key, value]) => {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
            throw new Error(`${attr} "${key}" must be a string, number or boolean: ${text}`);
        
        return [key, String(value)];
    });
}


/**
 * Name/value pairs in either x-vals format: a query string, or (starting with "{")
 * a flat JSON object of strings, numbers and booleans. Missing or blank → none.
 * `attr` names the attribute in error messages. Shared with x-headers.
 *
 * @throws Error on invalid JSON, a non-object, or a nested / null value
 */
export function parsePairs(text: string, attr: Modifiers): Entry[] {
    const trimmed = text.trim();
    if (trimmed === '')
        return [];
    
    return trimmed.startsWith('{') 
        ? parseJsonVals(trimmed, attr) 
        : [...new URLSearchParams(trimmed)];
}


// ---- tests (removed from the build) ----

describe('parsePairs', () => {
    const parse = (text: string): Entry[] => parsePairs(text, Modifiers.VALS);

    describe('nothing', () => {
        test('an empty or blank value gives no pairs', () => {
            expect(parse('')).toEqual([]);
            expect(parse('   ')).toEqual([]);
        });
    });

    describe('query string', () => {
        test('name=value pairs, in order', () => {
            expect(parse('status=open&page=2')).toEqual([['status', 'open'], ['page', '2']]);
        });
        test('repeated names keep every value', () => {
            expect(parse('s[]=3&s[]=7')).toEqual([['s[]', '3'], ['s[]', '7']]);
        });
        test('percent-encoding and + are decoded', () => {
            expect(parse('q=brake+pads%20%26%20discs&eq=a%3Db')).toEqual([['q', 'brake pads & discs'], ['eq', 'a=b']]);
        });
        test('a name without = has an empty value', () => {
            expect(parse('flag&page=2')).toEqual([['flag', ''], ['page', '2']]);
        });
        test('a leading ? is ignored', () => {
            expect(parse('?page=2')).toEqual([['page', '2']]);
        });
        test('surrounding whitespace is ignored', () => {
            expect(parse('  page=2  ')).toEqual([['page', '2']]);
        });
        test('an encoded { stays a query string', () => {
            expect(parse('%7Bkey=v')).toEqual([['{key', 'v']]);
        });
        test('an array does not start with {, so it is a query string, not JSON', () => {
            expect(parse('["a"]')).toEqual([['["a"]', '']]);
        });
    });

    describe('JSON (starts with "{")', () => {
        test('strings, numbers and booleans become strings, in order', () => {
            expect(parse('{"status":"open","page":2,"urgent":true,"done":false}'))
                .toEqual([['status', 'open'], ['page', '2'], ['urgent', 'true'], ['done', 'false']]);
        });
        test('leading whitespace before { still means JSON', () => {
            expect(parse('  {"page": 2}')).toEqual([['page', '2']]);
        });
        test('an empty object gives no pairs', () => {
            expect(parse('{}')).toEqual([]);
        });
        test('invalid JSON throws', () => {
            expect(() => parse('{status:open}')).toThrow(/not valid JSON/);
            expect(() => parse('{"a":1} trailing')).toThrow(/not valid JSON/);
        });
        test('nested objects, arrays and null throw, naming the key', () => {
            expect(() => parse('{"a":{"b":1}}')).toThrow(/"a" must be a string, number or boolean/);
            expect(() => parse('{"a":[1]}')).toThrow(/"a"/);
            expect(() => parse('{"a":null}')).toThrow(/"a"/);
        });
    });

    describe('errors name the attribute', () => {
        test('x-vals', () => {
            expect(() => parsePairs('{bad', Modifiers.VALS)).toThrow(/^x-vals is not valid JSON/);
        });
        test('x-headers', () => {
            expect(() => parsePairs('{"X-A":null}', Modifiers.HEADERS)).toThrow(/^x-headers "X-A"/);
        });
        test('the original text is in the message', () => {
            expect(() => parse('{"a":null}')).toThrow('{"a":null}');
        });
    });
});