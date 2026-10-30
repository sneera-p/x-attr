export type Message = {
    event: string;
    data: string;
};

export type Parser = {
    feed: (chunk: string) => void;
    reset: () => void;
};

type ParserCallbacks = {
    onEvent: (message: Message) => void;
    onId: (id: string) => void;
    onRetry: (ms: number) => void;
};

type ParserState = {
    buffer: string;
    event: string;
    data: string;
};

function splitLine(text: string): [string, string] {
    const colon = text.indexOf(':');
    if (colon === -1) {
        return [text, ''];
    }

    const field = text.slice(0, colon);

    let value = text.slice(colon + 1);
    if (value.startsWith(' '))
        value = value.slice(1);

    return [field, value];
}

function feedLine(text: string, state: ParserState, { onEvent, onId, onRetry }: ParserCallbacks): void {
    if (text === '' /* was '\n' before EOL got removed */) {
        if (state.data !== '') {
            onEvent({
                event: state.event || 'message',
                data: state.data.slice(0, -1)
            });
        }
        state.event = '';
        state.data = '';
        return;
    }

    if (text.startsWith(':')) {
        // The line was a comment
        return;
    }

    const [field, value] = splitLine(text);
    switch (field) {
        case 'event':
            state.event = value;
            break;

        case 'data':
            state.data += value + '\n';
            break;

        case 'id':
            if (!value.includes('\0'))
                onId(value);
            break;

        case 'retry':
            if (/^\d+$/.test(value))
                onRetry(Number(value));
            break;
    }
}

function feedChunk(chunk: string, state: ParserState, feedLine: (text: string) => void): void {
    state.buffer += chunk;
    while (true) {
        const end = state.buffer.search(/\r\n|\n|\r/);
        if (end === -1) {
            return;
        }
        // A lone \r at the end may be the first half of \r\n: wait for the next chunk.
        if (state.buffer[end] === '\r' && end === state.buffer.length - 1) {
            return;
        }

        const size = state.buffer.startsWith('\r\n', end) ? 2 : 1;
        feedLine(state.buffer.slice(0, end));
        state.buffer = state.buffer.slice(end + size);
    }
}

function resetParser(state: ParserState): void {
    state.buffer = '';
    state.event = '';
    state.data = '';
}

/**
 * The SSE wire format (WHATWG HTML §9.2.6), fed in arbitrary chunks.
 * Lines end in \r\n, \n or \r; a blank line dispatches the event built so far.
 */
export function createParser(callbacks: ParserCallbacks): Parser {
    const state: ParserState = {
        buffer: '',
        event: '',
        data: '',
    };

    const line = (text: string) => feedLine(text, state, callbacks);
    const feed = (chunk: string) => feedChunk(chunk, state, line);
    const reset = () => resetParser(state);

    return { feed, reset };
}


// ---- tests (removed from the build) ----

describe('parser', () => {
    /** Records every callback, so a test can assert on what the parser reported. */
    function recorder(): ParserCallbacks & { events: Message[]; ids: string[]; retries: number[] } {
        const out = { events: [] as Message[], ids: [] as string[], retries: [] as number[] };
        return {
            ...out,
            onEvent: m => out.events.push(m),
            onId: id => out.ids.push(id),
            onRetry: ms => out.retries.push(ms),
        };
    }

    const emptyState = (): ParserState => ({ buffer: '', event: '', data: '' });

    describe('splitLine', () => {
        test('splits at the colon and strips one leading space', () => {
            expect(splitLine('event: job:1')).toEqual(['event', 'job:1']);
        });
        test('exactly one leading space is stripped', () => {
            expect(splitLine('data:  two')).toEqual(['data', ' two']);
        });
        test('no space after the colon is fine', () => {
            expect(splitLine('data:none')).toEqual(['data', 'none']);
        });
        test('only the first colon splits: the value can contain colons', () => {
            expect(splitLine('data: a:b:c')).toEqual(['data', 'a:b:c']);
        });
        test('no colon: the whole line is the field, the value is empty', () => {
            expect(splitLine('data')).toEqual(['data', '']);
        });
        test('a colon at the end gives an empty value', () => {
            expect(splitLine('data:')).toEqual(['data', '']);
            expect(splitLine('data: ')).toEqual(['data', '']);
        });
        test('only a space is stripped, not a tab', () => {
            expect(splitLine('data:\tx')).toEqual(['data', '\tx']);
        });
        test('a leading colon gives an empty field (feedLine treats it as a comment first)', () => {
            expect(splitLine(': ping')).toEqual(['', 'ping']);
        });
    });

    describe('feedLine', () => {
        const run = (...lines: string[]): { state: ParserState; got: ReturnType<typeof recorder> } => {
            const state = emptyState();
            const got = recorder();
            for (const line of lines)
                feedLine(line, state, got);
            return { state, got };
        };

        describe('fields', () => {
            test('event sets the name', () => {
                expect(run('event: job:1').state.event).toBe('job:1');
            });
            test('data appends the value and a \\n', () => {
                expect(run('data: a', 'data: b').state.data).toBe('a\nb\n');
            });
            test('id is reported, unless it contains NUL', () => {
                expect(run('id: 17-0', 'id: bad\0id').got.ids).toEqual(['17-0']);
            });
            test('retry is reported only when it is all digits', () => {
                expect(run('retry: 50', 'retry: soon', 'retry: 5s', 'retry: -1').got.retries).toEqual([50]);
            });
            test('unknown fields change nothing', () => {
                expect(run('foo: bar').state).toEqual(emptyState());
            });
        });

        describe('values', () => {
            test('uses splitLine: the value after "field: " is what gets stored', () => {
                expect(run('data: a:b:c').state.data).toBe('a:b:c\n');
            });
        });

        describe('comments', () => {
            test('a line starting with ":" changes nothing', () => {
                const { state, got } = run(': ping');
                expect(state).toEqual(emptyState());
                expect(got.events).toEqual([]);
            });
        });

        describe('blank line', () => {
            test('dispatches the event without the last \\n, then clears event and data', () => {
                const { state, got } = run('event: a', 'data: x', 'data: y', '');
                expect(got.events).toEqual([{ event: 'a', data: 'x\ny' }]);
                expect(state.event).toBe('');
                expect(state.data).toBe('');
            });
            test('no event name means "message"', () => {
                expect(run('data: x', '').got.events).toEqual([{ event: 'message', data: 'x' }]);
            });
            test('no data: nothing is dispatched, and the name is still cleared', () => {
                const { state, got } = run('event: a', '');
                expect(got.events).toEqual([]);
                expect(state.event).toBe('');
            });
            test('an empty data line dispatches an empty string', () => {
                expect(run('data:', '').got.events).toEqual([{ event: 'message', data: '' }]);
            });
            test('the buffer is not touched', () => {
                const state = { ...emptyState(), buffer: 'partial' };
                feedLine('', state, recorder());
                expect(state.buffer).toBe('partial');
            });
        });
    });

    describe('feedChunk', () => {
        const run = (...chunks: string[]): { state: ParserState; lines: string[] } => {
            const state = emptyState();
            const lines: string[] = [];
            for (const chunk of chunks) feedChunk(chunk, state, line => lines.push(line));
            return { state, lines };
        };

        test('splits on \\n, \\r\\n and \\r', () => {
            expect(run('a\nb\r\nc\rd\n').lines).toEqual(['a', 'b', 'c', 'd']);
        });
        test('blank lines come through as ""', () => {
            expect(run('a\n\nb\r\n\r\n').lines).toEqual(['a', '', 'b', '']);
        });
        test('a partial line waits in the buffer', () => {
            const { state, lines } = run('a\npart');
            expect(lines).toEqual(['a']);
            expect(state.buffer).toBe('part');
        });
        test('the buffered part is joined with the next chunk', () => {
            expect(run('da', 'ta: x', '\n').lines).toEqual(['data: x']);
        });
        test('a trailing \\r waits: it may be half of \\r\\n', () => {
            const { state, lines } = run('a\r');
            expect(lines).toEqual([]);
            expect(state.buffer).toBe('a\r');
        });
        test('\\r\\n split across chunks is one line ending, not two', () => {
            expect(run('a\r', '\nb\n').lines).toEqual(['a', 'b']);
        });
        test('a trailing \\r followed by other text is a line ending of its own', () => {
            expect(run('a\r', 'b\n').lines).toEqual(['a', 'b']);
        });
        test('an empty chunk changes nothing', () => {
            expect(run('').lines).toEqual([]);
        });
    });

    describe('resetParser', () => {
        test('clears buffer, event and data', () => {
            const state = { buffer: 'da', event: 'a', data: 'x\n' };
            resetParser(state);
            expect(state).toEqual(emptyState());
        });
    });

    describe('createParser', () => {
        const parse = (...chunks: string[]): ReturnType<typeof recorder> => {
            const got = recorder();
            const parser = createParser(got);
            for (const chunk of chunks) parser.feed(chunk);
            return got;
        };

        test('a full event, end to end', () => {
            expect(parse('event: job:1\ndata: <li>\ndata: open</li>\nid: 17-0\n\n').events)
                .toEqual([{ event: 'job:1', data: '<li>\nopen</li>' }]);
        });
        test('several events in one chunk', () => {
            expect(parse('data: a\n\ndata: b\n\n').events.map(e => e.data)).toEqual(['a', 'b']);
        });
        test('an event split anywhere across chunks', () => {
            expect(parse('ev', 'ent: a\nda', 'ta: x', '\n', '\n').events).toEqual([{ event: 'a', data: 'x' }]);
        });
        test('\\r\\n split across chunks does not dispatch early', () => {
            expect(parse('data: a\r', '\n\r\n').events).toEqual([{ event: 'message', data: 'a' }]);
        });
        test('two parsers do not share state', () => {
            const a = recorder();
            const b = recorder();
            const pa = createParser(a);
            const pb = createParser(b);
            pa.feed('data: from a\n');
            pb.feed('data: from b\n\n');
            pa.feed('\n');
            expect(a.events.map(e => e.data)).toEqual(['from a']);
            expect(b.events.map(e => e.data)).toEqual(['from b']);
        });
        test('reset() drops a half-built event and a partial line', () => {
            const got = recorder();
            const parser = createParser(got);
            parser.feed('event: old\ndata: half\nda');
            parser.reset();
            parser.feed('ta: lost\n\n');                     // "da" is gone: this is an unknown field "ta"
            expect(got.events).toEqual([]);
            parser.feed('data: new\n\n');
            expect(got.events).toEqual([{ event: 'message', data: 'new' }]);   // no "old" name, no "half" data
        });
    });
});