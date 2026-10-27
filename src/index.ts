import { process } from "./process";
import { cleanup } from "./shared/cleanup";

/**
 * Call to wire and setup the x-* attributes to their behaviours
 * Doing it twice won't register it twice as each elements track if it's already processed
 */
export function start(): void {
    process(document.body);
}

const XATTR_PROCESS: unique symbol = Symbol.for('sneera:x-attr:process');
const XATTR_CLEANUP: unique symbol = Symbol.for('sneera:x-attr:cleanup');
const XATTR_START: unique symbol = Symbol.for('sneera:x-attr:start');

declare global {
    interface Window {
        [XATTR_PROCESS]: typeof process;
        [XATTR_CLEANUP]: typeof cleanup;
        [XATTR_START]: typeof start;
    }
}

window[XATTR_PROCESS] = process;
window[XATTR_CLEANUP] = cleanup;
window[XATTR_START] = start;

/**
 * Auto-runs only when loaded by a classic <script> without "hold".
 *
 * - <script src='x-attrs.js'></script>             -> runs start
 * - <script src='x-attrs.js' hold></script>        -> doesn't (call window[Symbol.for('sneera:x-attr:start')]())
 * - <script type="module" src='x-attrs.js'>        -> doesn't (currentScript is null in modules)
 * - bundled into an app                             -> depends on the app's own <script> tag; call start() yourself
 */
if (document.currentScript !== null && !document.currentScript.hasAttribute('hold')) {
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', start);
    else
        start();
}
