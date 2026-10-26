export enum Verbs {
    // methods
    GET = 'x-get',
    POST = 'x-post',
    PUT = 'x-put', 
    PATCH = 'x-patch', 
    DELETE = 'x-delete',
}

export enum Modifiers {
    TRIGGER = 'x-trigger',
    TARGET = 'x-target',
    SWAP = 'x-swap',
    INCLUDE = 'x-include',
    VALS = 'x-vals',
}

type ArrayOrSingle<T> = T | T[];

export namespace Attributes {
    export function map(attrs: ArrayOrSingle<Verbs> | ArrayOrSingle<Modifiers>): string {
        const v = Array.isArray(attrs) ? attrs : [attrs];
        return v
            .map(v => `[${v}]`)
            .join(',');
    }

    export function inElement(node: Element, attrs: ArrayOrSingle<Verbs> | ArrayOrSingle<Modifiers>): boolean {
        const v = Array.isArray(attrs) ? attrs : [attrs];
        return v.reduce<boolean>(
            (acc, v) => acc && node.hasAttribute(`${v}`), 
            true
        );
    }
}
