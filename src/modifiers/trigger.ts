import { Modifiers } from "../shared/attrs";
import type { ElementTag } from "../shared/tag";

const baseDefaultTrigger: string = 'click';

/**
 * Assume the default trigger is 'click'
 * Now what should not have 'click' as default trigger?
 * Those are written here
 */
const defaultTrigger: Partial<Record<ElementTag, string>> = {
    form: 'submit',
    input: 'change',
    select: 'change',
    textarea: 'change',
};


/** When a request fires: on a DOM event (optionally debounced), once on load, or on a timer. */
export type Trigger =
    | { kind: 'load' }
    | { kind: 'revealed' }
    | { kind: 'sse'; event: string }
    | { kind: 'every'; interval: number }
    | { kind: 'event'; event: string; delay: number }
    ;

/** Inputs that are clicked, not changed. */
const CLICKED_INPUTS = new Set(['submit', 'button', 'reset', 'image']);

/**
 * Parses x-trigger. Read from the element itself, never inherited.
 *
 *   (absent)               → the element's default event (form: submit, input: change, …: click)
 *   "keyup"                → that event
 *   "keyup delay:300ms"    → that event, debounced: fires once events stop for 300 ms
 *   "load"                 → once, as soon as the element is processed
 *   "revealed"             → once, as the element is revealed to the window
 *   "every 5s"             → repeatedly, every 5 seconds, while the element is on the page
 *   "sse staff:update:2"   → SSE, subscribe to 'staff:update:2' event
 *
 * @throws Error on anything else, so a typo never becomes a listener that never fires
 */
export function resolveTrigger(el: Element): Trigger {
    const value = el.getAttribute(Modifiers.TRIGGER);

    /** handle defaults */
    if (value === null) {
        return {
            kind: 'event',
            event: (el instanceof HTMLInputElement && CLICKED_INPUTS.has(el.type))
                ? baseDefaultTrigger
                : defaultTrigger[el.localName as ElementTag] ?? baseDefaultTrigger,
            delay: 0
        };
    }

    const [first, ...rest] = value.trim().split(/\s+/);
    if (first === undefined || first === '') {
        throw new Error('x-trigger is empty');
    }

    switch (first) {
        case 'load':
            if (rest.length > 0) {
                throw new Error(`x-trigger "load" takes no modifiers: ${value}`);
            }
            return {
                kind: 'load'
            };

        case 'revealed':
            if (rest.length > 0) {
                throw new Error(`x-trigger "revealed" takes no modifiers: ${value}`);
            }
            return { kind: 'revealed' };

        case 'sse':
            if (rest.length !== 1) {
                throw new Error(`x-trigger "sse" needs exactly one event name, e.g. "sse job:update": ${value}`);
            }
            return { kind: 'sse', event: rest[0]! };


        case 'every':
            if (rest.length !== 1) {
                throw new Error(`x-trigger "every" needs exactly one duration, e.g. "every 5s": ${value}`);
            }
            return {
                kind: 'every',
                interval: duration(rest[0]!, value)
            };

        default: /* events */
            let delay = 0;
            for (const modifier of rest) {
                if (modifier.startsWith('delay:')) {
                    delay = duration(modifier.slice('delay:'.length), value);
                } else {
                    throw new Error(`Unknown x-trigger modifier "${modifier}": ${value}`);
                }
            }
            return {
                kind: 'event',
                event: first,
                delay: delay
            };
    }
}

/** "300ms" → 300, "2s" → 2000. The unit is required, so "300" can't be misread. */
function duration(text: string, whole: string): number {
    const match = /^(\d+)(ms|s)$/.exec(text);
    if (match === null) {
        throw new Error(`Invalid duration "${text}" (use e.g. 300ms or 2s): ${whole}`);
    }
    return Number(match[1]) * (match[2] === 's' ? 1000 : 1);
}

// ---- tests (removed from the build) ----

describe('resolve', () => {
    describe('resolveTrigger', () => {
        const on = (html: string): Element => {
            document.body.innerHTML = html;
            return document.body.firstElementChild!;
        };

        describe('defaults', () => {
            test('form → submit', () => {
                expect(resolveTrigger(on('<form></form>'))).toEqual({ kind: 'event', event: 'submit', delay: 0 });
            });
            test('text input, select, textarea → change', () => {
                for (const html of ['<input>', '<input type="search">', '<select></select>', '<textarea></textarea>']) {
                    expect(resolveTrigger(on(html))).toEqual({ kind: 'event', event: 'change', delay: 0 });
                }
            });
            test('button-like inputs → click', () => {
                for (const type of ['submit', 'button', 'reset', 'image']) {
                    expect(resolveTrigger(on(`<input type="${type}">`))).toEqual({ kind: 'event', event: 'click', delay: 0 });
                }
            });
            test('anything else → click, including tags not in the table', () => {
                expect(resolveTrigger(on('<button></button>'))).toEqual({ kind: 'event', event: 'click', delay: 0 });
                expect(resolveTrigger(on('<job-card></job-card>'))).toEqual({ kind: 'event', event: 'click', delay: 0 });
            });
        });

        describe('x-trigger values', () => {
            test('a plain event', () => {
                expect(resolveTrigger(on('<input x-trigger="keyup">'))).toEqual({ kind: 'event', event: 'keyup', delay: 0 });
            });
            test('delay in ms and s, extra whitespace ignored', () => {
                expect(resolveTrigger(on('<input x-trigger="keyup delay:300ms">'))).toEqual({ kind: 'event', event: 'keyup', delay: 300 });
                expect(resolveTrigger(on('<input x-trigger="  input   delay:2s ">'))).toEqual({ kind: 'event', event: 'input', delay: 2000 });
            });
            test('load', () => {
                expect(resolveTrigger(on('<div x-trigger="load"></div>'))).toEqual({ kind: 'load' });
            });
            test('every', () => {
                expect(resolveTrigger(on('<div x-trigger="every 5s"></div>'))).toEqual({ kind: 'every', interval: 5000 });
                expect(resolveTrigger(on('<div x-trigger="every 250ms"></div>'))).toEqual({ kind: 'every', interval: 250 });
            });
            test('revealed', () => {
                expect(resolveTrigger(on('<div x-trigger="revealed"></div>'))).toEqual({ kind: 'revealed' });
            });
            test('is not inherited from ancestors', () => {
                document.body.innerHTML = '<form x-trigger="keyup"><button>b</button></form>';
                expect(resolveTrigger(document.querySelector('button')!)).toEqual({ kind: 'event', event: 'click', delay: 0 });
            });
        });

        describe('invalid values throw', () => {
            const invalid = [
                ['', /empty/],
                ['   ', /empty/],
                ['keyup delay:300', /duration/],
                ['keyup delay:abc', /duration/],
                ['keyup throttle:1s', /modifier/],
                ['load delay:1s', /load/],
                ['every', /every/],
                ['every 5', /duration/],
                ['every 1s 2s', /every/],
                ['revealed delay:1s', /revealed/],
            ] as const;
            for (const [value, message] of invalid) {
                test(JSON.stringify(value), () => {
                    expect(() => resolveTrigger(on(`<div x-trigger="${value}"></div>`))).toThrow(message);
                });
            }
        });

        describe('sse', () => {
            const parse = (value: string): Trigger => {
                document.body.innerHTML = `<div x-trigger="${value}"></div>`;
                return resolveTrigger(document.querySelector('div')!);
            };
            test('"sse <event>" takes the event name, colons included', () => {
                expect(parse('sse job:update:1')).toEqual({ kind: 'sse', event: 'job:update:1' });
                expect(parse('  sse   a  ')).toEqual({ kind: 'sse', event: 'a' });
            });
            test('no name, two names or a modifier throws', () => {
                expect(() => parse('sse')).toThrow(/exactly one/);
                expect(() => parse('sse a b')).toThrow(/exactly one/);
                expect(() => parse('sse a delay:1s')).toThrow(/exactly one/);
            });
        });
    });
});
