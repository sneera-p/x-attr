import { Modifiers } from "./attrs";
import { defaultSwap, defaultTrigger } from "./defaults";
import type { Tag } from "./tag";

export function resolveTrigger(el: Element): string {
    return el.getAttribute(Modifiers.TRIGGER)
        ?? defaultTrigger[el.localName as Tag];
}

export function resolveSwap(el: Element): string {
    return el.getAttribute(Modifiers.SWAP)
        ?? defaultSwap[el.localName as Tag];
}

/**
 * Finds the element a response should be swapped into.
 *
 * x-target is inherited: the nearest element (self or ancestor) that has it
 * is the "owner", and relative keywords are resolved from the owner.
 * No x-target anywhere up the tree → the element itself.
 *
 * @throws Error when the value is malformed or matches nothing
 */
export function resolveTarget(el: Element): Element {
    const owner = el.closest('[x-target]');
    if (owner === null) {
        return el;
    }

    const value = owner.getAttribute('x-target')!.trim();
    const space = value.indexOf(' ');
    const keyword = space === -1 ? value : value.slice(0, space);
    const selector = space === -1 ? '' : value.slice(space + 1).trim();

    let found: Element | null;

    switch (keyword) {
        case 'this':
            found = owner;
            break;
        case 'closest':
            found = owner.closest(requireSelector(value, selector));
            break;
        case 'find':
            found = owner.querySelector(requireSelector(value, selector));
            break;
        case 'next':
            found = sibling(owner, requireSelector(value, selector), 'nextElementSibling');
            break;
        case 'previous':
            found = sibling(owner, requireSelector(value, selector), 'previousElementSibling');
            break;
        default:
            found = document.querySelector(value);
    }

    if (found === null) {
        throw new Error(`x-target matched nothing: ${value}`);
    }
    return found;
}

function requireSelector(value: string, selector: string): string {
    if (selector === '') {
        throw new Error(`x-target is missing a selector: ${value}`);
    }
    return selector;
}

function sibling(start: Element, selector: string, direction: 'nextElementSibling' | 'previousElementSibling'): Element | null {
    let current = start[direction];
    while (current !== null) {
        if (current.matches(selector)) {
            return current;
        }
        current = current[direction];
    }
    return null;
}