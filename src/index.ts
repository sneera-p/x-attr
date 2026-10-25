import { process } from "./process";

const processed = new WeakSet<Element>();

/** Wires up the page. Call once, after registering SSE clients. */
export function start(root: Element = document.body): void {
    process(root, processed);
}

/** Wires up HTML you inserted with your own code. */
export function processNode(node: Node): void {
    process(node, processed);
}