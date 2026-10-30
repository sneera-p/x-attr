/** Form controls that carry a name and value. */
export type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;

/**
 * One name/value pair, as FormData has them: a string, or a File from a file input.
 * A list of them (not a Map) keeps repeated names: checkbox groups, multi-selects, multiple files.
 */
export type Entry = [name: string, value: FormDataEntryValue];

export function isControl(el: Element): el is Control {
    return el instanceof HTMLInputElement
        || el instanceof HTMLSelectElement
        || el instanceof HTMLTextAreaElement
        || el instanceof HTMLButtonElement;
}

/** A form's fields, by the browser's own rules (FormData), files included. */
export function readForm(form: HTMLFormElement): Entry[] {
    return [...new FormData(form)];
}

/** One control's value(s), by the same rules a form submission uses. */
export function readControl(el: Control): Entry[] {
    if (el.name === '' || el.disabled) {
        return [];
    }

    if (el instanceof HTMLInputElement) {
        if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) {
            return [];
        }
        if (el.type === 'file') {
            return [...(el.files ?? [])].map(file => [el.name, file]);
        }
    }

    if (el instanceof HTMLSelectElement && el.multiple) {
        return [...el.selectedOptions].map(option => [el.name, option.value]);
    }
    return [[el.name, el.value]];
}

// ---- tests (removed from the build) ----

describe('isControl', () => {
    test('input, select, textarea and button are controls', () => {
        document.body.innerHTML = '<input><select></select><textarea></textarea><button></button>';
        expect([...document.body.children].every(isControl)).toBe(true);
    });
    test('forms, fieldsets and other elements are not', () => {
        document.body.innerHTML = '<form></form><fieldset></fieldset><div></div><output></output>';
        expect([...document.body.children].some(isControl)).toBe(false);
    });
});

describe('readControl', () => {
    const read = (html: string): Entry[] => {
        document.body.innerHTML = html;
        return readControl(document.body.firstElementChild as Control);
    };

    test('a named control gives its value', () => {
        expect(read('<input name="q" value="brake pads">')).toEqual([['q', 'brake pads']]);
        expect(read('<textarea name="note">hi</textarea>')).toEqual([['note', 'hi']]);
        expect(read('<button name="action" value="save">Save</button>')).toEqual([['action', 'save']]);
    });
    test('an empty value is still sent', () => {
        expect(read('<input name="q" value="">')).toEqual([['q', '']]);
    });
    test('unnamed or disabled gives nothing', () => {
        expect(read('<input value="x">')).toEqual([]);
        expect(read('<input name="q" value="x" disabled>')).toEqual([]);
    });
    test('checkboxes and radios only when checked', () => {
        expect(read('<input type="checkbox" name="u" value="1">')).toEqual([]);
        expect(read('<input type="checkbox" name="u" value="1" checked>')).toEqual([['u', '1']]);
        expect(read('<input type="radio" name="r" value="a">')).toEqual([]);
        expect(read('<input type="radio" name="r" value="a" checked>')).toEqual([['r', 'a']]);
    });
    test('a checked checkbox without a value sends "on", like the browser', () => {
        expect(read('<input type="checkbox" name="u" checked>')).toEqual([['u', 'on']]);
    });
    test('a single select gives the selected option', () => {
        expect(read('<select name="s"><option value="a">a</option><option value="b" selected>b</option></select>')).toEqual([['s', 'b']]);
    });
    test('a multi-select gives every selected option, in order', () => {
        expect(read('<select name="s" multiple><option value="a" selected>a</option><option value="b">b</option><option value="c" selected>c</option></select>'))
            .toEqual([['s', 'a'], ['s', 'c']]);
    });
    test('a multi-select with nothing selected gives nothing', () => {
        expect(read('<select name="s" multiple><option value="a">a</option></select>')).toEqual([]);
    });
    test('a file input with no file chosen gives nothing', () => {
        expect(read('<input type="file" name="photo">')).toEqual([]);
    });
});

describe('readForm', () => {
    const read = (html: string): Entry[] => {
        document.body.innerHTML = html;
        return readForm(document.querySelector('form')!);
    };

    test('every field, in document order', () => {
        expect(read('<form><input name="plate" value="CAB-1"><select name="status"><option value="open" selected>open</option></select><textarea name="note">x</textarea></form>'))
            .toEqual([['plate', 'CAB-1'], ['status', 'open'], ['note', 'x']]);
    });
    test('repeated names keep every value', () => {
        expect(read('<form><input type="checkbox" name="s[]" value="3" checked><input type="checkbox" name="s[]" value="5"><input type="checkbox" name="s[]" value="7" checked></form>'))
            .toEqual([['s[]', '3'], ['s[]', '7']]);
    });
    test('skips unnamed, disabled and unchecked fields, and buttons', () => {
        expect(read('<form><input value="x"><input name="d" value="x" disabled><input type="checkbox" name="c" value="1"><button name="b" value="1">go</button><input name="q" value="1"></form>'))
            .toEqual([['q', '1']]);
    });
    test('an empty form gives nothing', () => {
        expect(read('<form></form>')).toEqual([]);
    });
});