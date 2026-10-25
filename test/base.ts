import { test, expect, beforeEach } from 'bun:test';
import { process } from '../src/process';

beforeEach(() => { document.body.innerHTML = ''; });

test('finds x-* elements under the root', () => {
    const processed = new WeakSet<HTMLElement>();
    document.body.innerHTML = `
        <div><button x-get="/a">A</button></div>
        <span>not me</span>
        <form x-post="/b"></form>
    `;
    process(document.body, processed);

    expect(processed.has(document.querySelector('button')!)).toBe(true);
    expect(processed.has(document.querySelector('form')!)).toBe(true);
    expect(processed.has(document.querySelector('span')!)).toBe(false);
});

test('includes the root element itself', () => {
    const processed = new WeakSet<HTMLElement>();
    document.body.innerHTML = `
        <button x-get="/a">A</button>
    `;
    const button = document.querySelector('button')!;
    process(button, processed);

    expect(processed.has(button)).toBe(true);
});

test('processing twice does not bind twice', () => {
    const processed = new WeakSet<HTMLElement>();
    document.body.innerHTML = `
        <button x-get="/a">A</button>
    `;
    
    const button = document.querySelector('button')!;
    let clicks = 0;
    button.addEventListener('x:test-click', () => clicks++);   // init dispatches this on click

    process(document.body, processed);
    process(document.body, processed);
    button.click();

    expect(clicks).toBe(1);
});