import type { Trigger } from '../modifiers/trigger';
import { onCleanup } from '../shared/cleanup';

/** A trigger that fires a request: everything except `sse`, which is a subscription instead. */
export type FiringTrigger = Exclude<Trigger, { kind: 'sse' }>;

/** A button whose click would submit its form: <button> (type defaults to submit) or <input type=submit|image>. */
function isSubmitButton(el: Element): boolean {
    if (el instanceof HTMLButtonElement) {
        return el.type === 'submit';
    }
    return el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'image');
}

/** Fires once, now. */
function bindLoad(fire: () => void): void {
    fire();
}

/** Fires every `interval` ms while the element is on the page. */
function bindEvery(node: Element, interval: number, fire: () => void): void {
    const timer = setInterval(() => {
        if (!node.isConnected) {
            clearInterval(timer);   // removed without cleanup(): stop on the next tick
            return;
        }
        fire();
    }, interval);
    onCleanup(node, () => clearInterval(timer));
}

/** Fires on a DOM event, debounced by `delay` ms when it is not 0. Stops forms, links and submit buttons navigating. */
function bindEvent(node: Element, event: string, delay: number, fire: () => void): void {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    onCleanup(node, () => clearTimeout(debounce));

    node.addEventListener(event, e => {
        if (event === 'submit' || node.matches('a') || isSubmitButton(node)) {
            e.preventDefault();
        }
        if (delay === 0) {
            fire();
            return;
        }
        clearTimeout(debounce);
        debounce = setTimeout(fire, delay);
    });
}

/** Fires once, the first time the element is in view (at once, if it already is). */
function bindRevealed(node: Element, fire: () => void): void {
    const observer = new IntersectionObserver(entries => {
        if (!node.isConnected) {
            observer.disconnect();   // removed before it was ever revealed
            return;
        }
        if (entries.some(entry => entry.isIntersecting)) {
            observer.disconnect();
            fire();
        }
    });
    observer.observe(node);
    onCleanup(node, () => observer.disconnect());
}

/**
 * Carries out a parsed x-trigger: calls `fire` at the moments it describes,
 * and registers whatever it set up for cleanup when the element is swapped away.
 */
export function bind(node: Element, trigger: FiringTrigger, fire: () => void): void {
    switch (trigger.kind) {
        case 'load':
            bindLoad(fire);
            return;
        case 'every':
            bindEvery(node, trigger.interval, fire);
            return;
        case 'event':
            bindEvent(node, trigger.event, trigger.delay, fire);
            return;
        case 'revealed':
            bindRevealed(node, fire);
            return;
        default: {
            // a new Trigger kind without a case here is a compile error, not a silent no-op
            const unhandled: never = trigger;
            throw new Error(`Unhandled trigger: ${JSON.stringify(unhandled)}`);
        }
    }
}

// ---- tests (removed from the build) ----

describe('bind', () => {
    let fired: number;
    const fire = (): void => { fired++; };
    beforeEach(() => { fired = 0; });

    const element = (html: string): Element => {
        document.body.innerHTML = html;
        return document.body.firstElementChild!;
    };

    describe('load', () => {
        test('fires once, straight away', () => {
            bind(element('<div></div>'), { kind: 'load' }, fire);
            expect(fired).toBe(1);
        });
    });

    describe('every', () => {
        test('fires on every tick', async () => {
            bind(element('<div></div>'), { kind: 'every', interval: 10 }, fire);
            await settle(35);
            expect(fired).toBeGreaterThanOrEqual(2);
        });
        test('stops when the element leaves the page', async () => {
            const el = element('<div></div>');
            bind(el, { kind: 'every', interval: 10 }, fire);
            el.remove();
            await settle(30);
            expect(fired).toBe(0);
        });
    });

    describe('event', () => {
        test('fires on each event', () => {
            const el = element('<input>');
            bind(el, { kind: 'event', event: 'input', delay: 0 }, fire);
            el.dispatchEvent(new Event('input'));
            el.dispatchEvent(new Event('input'));
            expect(fired).toBe(2);
        });
        test('delay debounces: one fire after the burst', async () => {
            const el = element('<input>');
            bind(el, { kind: 'event', event: 'input', delay: 20 }, fire);
            for (let i = 0; i < 3; i++) {
                el.dispatchEvent(new Event('input'));
                await settle(2);
            }
            expect(fired).toBe(0);
            await settle(25);
            expect(fired).toBe(1);
        });
        test('submit, links and submit buttons do not navigate', () => {
            const cases: [string, string][] = [
                ['<form></form>', 'submit'],
                ['<a href="/x"></a>', 'click'],
                ['<button></button>', 'click'],
                ['<input type="submit">', 'click'],
            ];
            for (const [html, event] of cases) {
                const el = element(html);
                bind(el, { kind: 'event', event, delay: 0 }, fire);
                const e = new Event(event, { cancelable: true });
                el.dispatchEvent(e);
                expect(e.defaultPrevented).toBe(true);
            }
        });
        test('a type="button" button is left alone', () => {
            const el = element('<button type="button"></button>');
            bind(el, { kind: 'event', event: 'click', delay: 0 }, fire);
            const e = new Event('click', { cancelable: true });
            el.dispatchEvent(e);
            expect(e.defaultPrevented).toBe(false);
        });
    });

    describe('revealed', () => {
        test('fires once, the first time it is in view', () => {
            const el = element('<div></div>');
            bind(el, { kind: 'revealed' }, fire);
            expect(fired).toBe(0);
            viewport.reveal(el);
            viewport.hide(el);
            viewport.reveal(el);
            expect(fired).toBe(1);
            expect(viewport.isObserved(el)).toBe(false);
        });
        test('an element removed before it was revealed never fires', () => {
            const el = element('<div></div>');
            bind(el, { kind: 'revealed' }, fire);
            el.remove();
            viewport.reveal(el);
            expect(fired).toBe(0);
            expect(viewport.isObserved(el)).toBe(false);
        });
    });
});