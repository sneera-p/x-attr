import { Modifiers } from '../shared/attrs';
import { isControl, readControl, readForm, type Entry } from '../shared/form';

/** @throws Error when x-include matches nothing, or matches something that isn't a form or control */
export function extractInclude(el: Element): Entry[] {
    const include = el.getAttribute(Modifiers.INCLUDE);
    if (include === null) {
        return [];
    }

    const matched = document.querySelectorAll(include);
    if (matched.length === 0) {
        throw new Error(`x-include matched nothing: ${include}`);
    }
    
    const entries: Entry[] = [];
    for (const source of matched) {
        if (source instanceof HTMLFormElement) {
            entries.push(...readForm(source));
        } else if (isControl(source)) {
            entries.push(...readControl(source));
        } else {
            throw new Error(`x-include must match forms or form controls, got <${source.localName}>: ${include}`);
        }
    }
    return entries;
}

// ---- tests (removed from the build) ----

describe('include', () => {
    describe('extractInclude', () => {
        const include = (html: string, selector: string): Entry[] => {
            document.body.innerHTML = html;
            return extractInclude(document.querySelector(selector)!);
        };

        test('no x-include gives nothing', () => {
            expect(include('<button>go</button>', 'button')).toEqual([]);
        });
        test('a matched control gives its value', () => {
            expect(include('<input id="f" name="plate" value="CAB-1"><button x-include="#f">go</button>', 'button'))
                .toEqual([['plate', 'CAB-1']]);
        });
        test('a matched form gives all its fields', () => {
            expect(include('<form id="filters"><input name="a" value="1"><input name="b" value="2"></form><button x-include="#filters">go</button>', 'button'))
                .toEqual([['a', '1'], ['b', '2']]);
        });
        test('several matches keep repeated names', () => {
            expect(include('<input class="s" name="s" value="1"><input class="s" name="s" value="2"><button x-include=".s">go</button>', 'button'))
                .toEqual([['s', '1'], ['s', '2']]);
        });
        test('matching nothing throws', () => {
            expect(() => include('<button x-include="#missing">go</button>', 'button')).toThrow(/#missing/);
        });
        test('matching a non-control throws', () => {
            expect(() => include('<div id="d"></div><button x-include="#d">go</button>', 'button')).toThrow(/<div>/);
        });
    });
});