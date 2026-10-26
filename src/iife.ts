// Entry for the <script>-tag build only. The ESM build (index.ts) never runs on import;
// this one starts itself, because a script tag has no other place to call start().
import { process } from './index';

const XATTR: unique symbol = Symbol('sneera:x-attr:process');

declare global {
    interface Window {
        [XATTR]: typeof process;
    }
}

window[XATTR] = process;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => process(document.body));
} else {
    process(document.body);
}