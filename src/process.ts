import { get } from './handlers/get';
import { Attributes, Verbs } from './shared/attrs';

const VERB_NAMES = Object.values(Verbs).filter((v): v is Verbs => typeof v === 'string');
const SELECTOR = Attributes.map(VERB_NAMES);

function dummyHandler(node: Element): void {
    console.log('Not implemented yet')
}

// x-* attribute → function that wires it up. Add post/put/patch/delete here.
const handlers: Record<Verbs, (el: Element) => void> = {
    [Verbs.GET]: get,
    [Verbs.POST]: dummyHandler,
    [Verbs.PUT]: dummyHandler,
    [Verbs.PATCH]: dummyHandler,
    [Verbs.DELETE]: dummyHandler,
};

export function process(node: Node, processed: WeakSet<Element>): void {
    if (!(node instanceof Element)) {
        return;   // text and comment nodes from a swap
    }

    const elements = [...node.querySelectorAll(SELECTOR)];
    if (node.matches(SELECTOR)) {
        elements.unshift(node);
    }

    for (const el of elements) {
        if (!processed.has(el)) {
            processed.add(el);
            init(el);
        }
    }
}

function init(el: Element): void {
    for (const [attribute, handler] of Object.entries(handlers)) {
        if (el.hasAttribute(attribute)) {
            handler(el);
            return;
        }
    }
}