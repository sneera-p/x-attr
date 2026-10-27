/**
 * Wires every x-* element in `node` (itself included) that isn't wired yet.
 * Accepts any Node: swaps hand over text and comment nodes too, which are skipped.
 */
declare function process(node: Node): void;
/** Runs and forgets the cleanups of `node` and every x-* element inside it. */
declare function cleanup(node: Node): void;
/**
 * Call to wire and setup the x-* attributes to their behaviours
 * Doing it twice won't register it twice as each elements track if it's already processed
 */
export declare function start(): void;
declare const XATTR_PROCESS: unique symbol;
declare const XATTR_CLEANUP: unique symbol;
declare const XATTR_START: unique symbol;
declare global {
  interface Window {
    [XATTR_PROCESS]: typeof process;
    [XATTR_CLEANUP]: typeof cleanup;
    [XATTR_START]: typeof start;
  }
}
export {};
//# sourceMappingURL=index.d.ts.map