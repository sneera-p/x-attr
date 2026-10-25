// Entry for the <script>-tag build only. The ESM build (index.ts) never runs on import;
// this one starts itself, because a script tag has no other place to call start().
import { processNode, start } from './index';

declare global {
    interface Window {
        x: { start: typeof start; processNode: typeof processNode };
    }
}

window.x = { start, processNode };

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => start());
} else {
    start();
}