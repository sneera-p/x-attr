import { Verbs } from "../shared/attrs"
import { resolveSwap, resolveTarget, resolveTrigger } from "../shared/resolve";

export function get(node: Element): void {

    const url = node.getAttribute(Verbs.GET);
    if (url === null) {
        throw new Error('get() called on an element without x-get');
    }

    const trigger = resolveTrigger(node);

    node.addEventListener(trigger, async e => {
        if (trigger === 'submit' || node.matches('a')) {
            e.preventDefault();
        }

        const target = resolveTarget(node);
        const swap = resolveSwap(target);

        const response = await fetch(url);
        if (!response.ok) {
            return;
        }

        const html = await response.text();
        switch (swap) {
            case 'innerHTML':
                target.innerHTML = html;
                break;
            case 'outerHTML':
                target.outerHTML = html;
                break;
        }
    })
}