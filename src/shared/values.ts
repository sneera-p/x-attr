import { Modifiers } from './attrs';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;

/**
 * The values a request sends, in this order (later sources add to earlier ones,
 * except x-vals, which overrides):
 *
 *   1. the enclosing <form>'s fields, or, outside a form, the element's own name/value
 *   2. every form or named control matched by x-include (a page-wide CSS selector)
 *   3. the keys of x-vals (a JSON object of strings, numbers and booleans)
 *
 * Follows browser form rules: disabled and unnamed controls and unchecked
 * checkboxes/radios are skipped; multi-selects and repeated names give several values.
 *
 * @throws Error when a value is a File (it can't go in a query string), when
 *         x-include matches nothing, or when x-vals isn't a flat JSON object
 */
export function collectValues(el: Element): URLSearchParams {
    const params = new URLSearchParams();

    const form = el.closest('form');
    if (form !== null) {
        appendForm(params, form);
    } else if (isControl(el)) {
        appendControl(params, el);
    }

    const include = el.getAttribute(Modifiers.INCLUDE);
    if (include !== null) {
        const matched = document.querySelectorAll(include);
        if (matched.length === 0) {
            throw new Error(`x-include matched nothing: ${include}`);
        }
        for (const source of matched) {
            if (source instanceof HTMLFormElement) {
                appendForm(params, source);
            } else if (isControl(source)) {
                appendControl(params, source);
            } else {
                throw new Error(`x-include must match forms or form controls, got <${source.localName}>: ${include}`);
            }
        }
    }

    const vals = el.getAttribute(Modifiers.VALS);
    if (vals !== null) {
        for (const [key, value] of Object.entries(parseVals(vals))) {
            params.set(key, String(value));
        }
    }

    return params;
}

function isControl(el: Element): el is Control {
    return el instanceof HTMLInputElement
        || el instanceof HTMLSelectElement
        || el instanceof HTMLTextAreaElement
        || el instanceof HTMLButtonElement;
}

function appendForm(params: URLSearchParams, form: HTMLFormElement): void {
    for (const [name, value] of new FormData(form)) {
        if (typeof value !== 'string') {
            throw new Error(`Field "${name}" is a file; files can't be sent with x-get`);
        }
        params.append(name, value);
    }
}

function appendControl(params: URLSearchParams, el: Control): void {
    if (el.name === '' || el.disabled) {
        return;
    }
    if (el instanceof HTMLInputElement) {
        if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) {
            return;
        }
        if (el.type === 'file') {
            throw new Error(`Field "${el.name}" is a file; files can't be sent with x-get`);
        }
    }
    if (el instanceof HTMLSelectElement && el.multiple) {
        for (const option of el.selectedOptions) {
            params.append(el.name, option.value);
        }
        return;
    }
    params.append(el.name, el.value);
}

function parseVals(text: string): Record<string, string | number | boolean> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`x-vals is not valid JSON: ${text}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`x-vals must be a JSON object: ${text}`);
    }
    for (const [key, value] of Object.entries(parsed)) {
        if (!['string', 'number', 'boolean'].includes(typeof value)) {
            throw new Error(`x-vals "${key}" must be a string, number or boolean: ${text}`);
        }
    }
    return parsed as Record<string, string | number | boolean>;
}

// ---- tests (removed from the build) ----

describe('collectValues', () => {
    const values = (html: string, selector: string): string => {
        document.body.innerHTML = html;
        return collectValues(document.querySelector(selector)!).toString();
    };

    describe('own value, outside a form', () => {
        test('a named input sends its value', () => {
            expect(values('<input name="q" value="brake pads">', 'input')).toBe('q=brake+pads');
        });
        test('an unnamed element sends nothing', () => {
            expect(values('<input value="x">', 'input')).toBe('');
            expect(values('<button>go</button>', 'button')).toBe('');
        });
        test('disabled controls and unchecked checkboxes send nothing', () => {
            expect(values('<input name="q" value="x" disabled>', 'input')).toBe('');
            expect(values('<input type="checkbox" name="urgent" value="1">', 'input')).toBe('');
        });
        test('a checked checkbox sends its value', () => {
            expect(values('<input type="checkbox" name="urgent" value="1" checked>', 'input')).toBe('urgent=1');
        });
        test('a multi-select sends every selected option', () => {
            const html = '<select name="s" multiple><option value="a" selected>a</option><option value="b">b</option><option value="c" selected>c</option></select>';
            expect(values(html, 'select')).toBe('s=a&s=c');
        });
    });

    describe('inside a form', () => {
        test('sends the whole form, whichever element triggered', () => {
            const html = '<form><input name="plate" value="CAB-1"><select name="status"><option value="open" selected>open</option></select><button>go</button></form>';
            expect(values(html, 'button')).toBe('plate=CAB-1&status=open');
            expect(values(html, 'form')).toBe('plate=CAB-1&status=open');
        });
        test('repeated names (checkbox groups) give several values', () => {
            const html = '<form><input type="checkbox" name="s[]" value="3" checked><input type="checkbox" name="s[]" value="5"><input type="checkbox" name="s[]" value="7" checked><button>go</button></form>';
            expect(values(html, 'button')).toBe('s%5B%5D=3&s%5B%5D=7');
        });
    });

    describe('x-include', () => {
        test('adds matched controls from anywhere on the page', () => {
            const html = '<input id="f" name="plate" value="CAB-1"><button x-include="#f">go</button>';
            expect(values(html, 'button')).toBe('plate=CAB-1');
        });
        test('a matched form adds all its fields', () => {
            const html = '<form id="filters"><input name="a" value="1"><input name="b" value="2"></form><button x-include="#filters">go</button>';
            expect(values(html, 'button')).toBe('a=1&b=2');
        });
        test('comes after the element\'s own values', () => {
            const html = '<input id="f" name="extra" value="2"><input name="q" value="1" x-include="#f">';
            expect(values(html, 'input[name=q]')).toBe('q=1&extra=2');
        });
        test('matching nothing throws', () => {
            expect(() => values('<button x-include="#missing">go</button>', 'button')).toThrow(/#missing/);
        });
        test('matching a non-control throws', () => {
            expect(() => values('<div id="d"></div><button x-include="#d">go</button>', 'button')).toThrow(/<div>/);
        });
    });

    describe('x-vals', () => {
        test('adds strings, numbers and booleans', () => {
            const html = `<button x-vals='{"status":"open","page":2,"urgent":true}'>go</button>`;
            expect(values(html, 'button')).toBe('status=open&page=2&urgent=true');
        });
        test('overrides a field with the same name', () => {
            const html = `<form><input name="status" value="closed"><button x-vals='{"status":"open"}'>go</button></form>`;
            expect(values(html, 'button')).toBe('status=open');
        });
        test('invalid JSON, non-objects and nested values throw', () => {
            expect(() => values(`<button x-vals='{status:open}'>go</button>`, 'button')).toThrow(/JSON/);
            expect(() => values(`<button x-vals='["a"]'>go</button>`, 'button')).toThrow(/object/);
            expect(() => values(`<button x-vals='{"a":{"b":1}}'>go</button>`, 'button')).toThrow(/"a"/);
            expect(() => values(`<button x-vals='{"a":null}'>go</button>`, 'button')).toThrow(/"a"/);
        });
    });
});