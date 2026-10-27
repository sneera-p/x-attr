import { Verbs } from './attrs';

const SELECTOR = Object.values(Verbs).map(v => `[${v}]`).join(',');
const CLEANUP: unique symbol = Symbol('sneera:x-attr:cleanup');

type CleanableElement = Element & { 
    [CLEANUP]?: (() => void)[] 
};

/** Registers `fn` to run when `el` is removed by a swap (or by cleanup()). */
export function onCleanup(el: Element, fn: () => void): void {
    const own = el as CleanableElement;
    (own[CLEANUP] ??= []).push(fn);
}

/** Runs and forgets the cleanups of `node` and every x-* element inside it. */
export function cleanup(node: Node): void {
    if (!(node instanceof Element)) {
        return;
    }
    const elements = [...node.querySelectorAll(SELECTOR)];
    if (node.matches(SELECTOR)) {
        elements.unshift(node);
    }
    for (const el of elements as CleanableElement[]) {
        const fns = el[CLEANUP];
        delete el[CLEANUP];
        for (const fn of fns ?? []) fn();
    }
}

// ---- tests (removed from the build) ----

describe('cleanup', () => {
    test('runs the cleanups of the node and of x-* elements inside it, once', () => {
        document.body.innerHTML = '<div x-get="/a"><p x-get="/b"></p><span></span></div>';
        const ran: string[] = [];
        onCleanup(document.querySelector('div')!, () => ran.push('div'));
        onCleanup(document.querySelector('p')!, () => ran.push('p'));

        cleanup(document.querySelector('div')!);
        cleanup(document.querySelector('div')!);
        expect(ran).toEqual(['div', 'p']);
    });
    test('text nodes are ignored', () => {
        expect(() => cleanup(document.createTextNode('x'))).not.toThrow();
    });
});