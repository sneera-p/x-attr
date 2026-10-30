import { isControl, readControl, readForm, type Entry } from './form';

/** 
 * The enclosing form's fields, or outside a form, the element's own value. 
 */
function ownValues(el: Element): Entry[] {
    const form = el.closest('form');
    if (form !== null) {
        return readForm(form);
    }
    return isControl(el) ? readControl(el) : [];
}

/**
 * The values a request sends, in this order:
 *
 *   1. the enclosing <form>'s fields, or, outside a form, the element's own name/value
 *   2. `include`, added after 1 (a name in both is sent twice, like a form would)
 *   3. `vals`, which replaces every value of a name it shares with 1 or 2
 *
 * The caller extracts `include` and `vals` (modifiers/), so shared/ depends on nothing outside it.
 *
 * @throws Error on a file field in the form or the element
 */
export function collectValues(el: Element, include: Entry[], vals: Entry[]): Entry[] {
    const replaced = new Set(vals.map(([name]) => name));
    const entries = [...ownValues(el), ...include].filter(([name]) => !replaced.has(name));
    return [...entries, ...vals];
}

/**
 * For GET/DELETE: the entries as a query string.
 * @throws Error on a file: files can't go in a URL
 */
export function toQuery(entries: Entry[]): URLSearchParams {
    const params = new URLSearchParams();
    for (const [name, value] of entries) {
        if (typeof value !== 'string') {
            throw new Error(`Field "${name}" is a file; files can't be sent in a query string`);
        }
        params.append(name, value);
    }
    return params;
}

/** 
 * For POST/PUT/PATCH: the entries as a request body (multipart, so files work). 
 */
export function toFormData(entries: Entry[]): FormData {
    const data = new FormData();
    for (const [name, value] of entries) {
        data.append(name, value);
    }
    return data;
}


// ---- tests (removed from the build) ----

describe('values', () => {
    describe('collectValues', () => {
        const collect = (html: string, selector: string, include: Entry[] = [], vals: Entry[] = []): Entry[] => {
            document.body.innerHTML = html;
            return collectValues(document.querySelector(selector)!, include, vals);
        };

        describe('own values, outside a form', () => {
            test('a named control gives its value', () => {
                expect(collect('<input name="q" value="brake pads">', 'input')).toEqual([['q', 'brake pads']]);
            });
            test('a non-control (div, a) gives nothing', () => {
                expect(collect('<div name="q">x</div>', 'div')).toEqual([]);
                expect(collect('<a href="/x">x</a>', 'a')).toEqual([]);
            });
            test('the control rules apply: unnamed, disabled, unchecked give nothing', () => {
                expect(collect('<input value="x">', 'input')).toEqual([]);
                expect(collect('<input name="q" value="x" disabled>', 'input')).toEqual([]);
                expect(collect('<input type="checkbox" name="u" value="1">', 'input')).toEqual([]);
            });
        });

        describe('own values, inside a form', () => {
            const form = '<form><input name="plate" value="CAB-1"><select name="status"><option value="open" selected>open</option></select><button>go</button></form>';

            test('the whole form, whichever element triggered', () => {
                expect(collect(form, 'button')).toEqual([['plate', 'CAB-1'], ['status', 'open']]);
                expect(collect(form, 'form')).toEqual([['plate', 'CAB-1'], ['status', 'open']]);
                expect(collect(form, 'input')).toEqual([['plate', 'CAB-1'], ['status', 'open']]);
            });
            test('the form wins over the element: a control inside it is not added twice', () => {
                expect(collect('<form><input name="q" value="1"></form>', 'input')).toEqual([['q', '1']]);
            });
            test('repeated names keep every value', () => {
                const html = '<form><input type="checkbox" name="s[]" value="3" checked><input type="checkbox" name="s[]" value="7" checked><button>go</button></form>';
                expect(collect(html, 'button')).toEqual([['s[]', '3'], ['s[]', '7']]);
            });
        });

        describe('include', () => {
            test('is added after the own values', () => {
                expect(collect('<input name="q" value="1">', 'input', [['extra', '2']])).toEqual([['q', '1'], ['extra', '2']]);
            });
            test('a name in both is kept twice, like a form would send it', () => {
                expect(collect('<input name="q" value="1">', 'input', [['q', '2']])).toEqual([['q', '1'], ['q', '2']]);
            });
            test('works with no own values', () => {
                expect(collect('<div>x</div>', 'div', [['a', '1']])).toEqual([['a', '1']]);
            });
        });

        describe('vals', () => {
            test('are added last', () => {
                expect(collect('<input name="q" value="1">', 'input', [['i', '2']], [['v', '3']]))
                    .toEqual([['q', '1'], ['i', '2'], ['v', '3']]);
            });
            test('replace every value of a shared name, from the form and from include', () => {
                const html = '<form><input type="checkbox" name="s" value="1" checked><input type="checkbox" name="s" value="2" checked><input name="keep" value="k"><button>go</button></form>';
                expect(collect(html, 'button', [['s', '3']], [['s', '9']]))
                    .toEqual([['keep', 'k'], ['s', '9']]);
            });
            test('a name only in vals is simply added', () => {
                expect(collect('<div>x</div>', 'div', [], [['page', '2']])).toEqual([['page', '2']]);
            });
            test('vals can carry several values for one name, and they all replace the earlier ones', () => {
                expect(collect('<input name="s" value="1">', 'input', [['s', '2']], [['s', '8'], ['s', '9']]))
                    .toEqual([['s', '8'], ['s', '9']]);
            });
        });

        test('nothing anywhere gives nothing', () => {
            expect(collect('<div>x</div>', 'div')).toEqual([]);
        });

        test('files pass through untouched (rejecting them is toQuery\'s job)', () => {
            const file = new File(['x'], 'a.png', { type: 'image/png' });
            expect(collect('<div>x</div>', 'div', [['photo', file]])).toEqual([['photo', file]]);
        });
    });

    describe('toQuery', () => {
        const file = new File(['x'], 'a.png', { type: 'image/png' });

        test('keeps order and repeated names', () => {
            expect(toQuery([['a', '1'], ['s', '2'], ['s', '3']]).toString()).toBe('a=1&s=2&s=3');
        });
        test('encodes like a query string', () => {
            expect(toQuery([['q', 'brake pads & discs'], ['s[]', '1']]).toString()).toBe('q=brake+pads+%26+discs&s%5B%5D=1');
        });
        test('no entries give an empty query', () => {
            expect(toQuery([]).size).toBe(0);
        });
        test('a file throws, naming the field', () => {
            expect(() => toQuery([['a', '1'], ['photo', file]])).toThrow(/"photo"/);
        });
    });

    describe('toFormData', () => {
        const file = new File(['x'], 'a.png', { type: 'image/png' });

        test('keeps strings, files and repeated names, in order', () => {
            const data = toFormData([['a', '1'], ['photo', file], ['a', '2']]);
            expect([...data.keys()]).toEqual(['a', 'photo', 'a']);
            expect(data.getAll('a')).toEqual(['1', '2']);
            expect((data.get('photo') as File).name).toBe('a.png');
        });
        test('no entries give an empty body', () => {
            expect([...toFormData([])]).toEqual([]);
        });
    });
});