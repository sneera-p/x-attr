# x-attributes

A small library that adds HTML attributes for server-driven pages, in the spirit of htmx.
Elements fetch HTML from the server and swap it into the page; Server-Sent Events push
updates into it. No framework, no virtual DOM, no client-side templates: the server renders
HTML, the browser inserts it.

```html
<button x-get="/jobs/42" x-target="#details">Show job</button>
<div id="details"></div>
```

Clicking the button requests `GET /jobs/42` and puts the returned HTML inside `#details`.

---

## Contents

- [Loading](#loading)
- [How it works](#how-it-works)
- [Attributes](#attributes)
  - [x-get](#x-get)
  - [x-target](#x-target)
  - [x-swap](#x-swap)
  - [x-trigger](#x-trigger)
  - [x-include](#x-include)
  - [x-vals](#x-vals)
- [Responses](#responses)
- [Server-Sent Events](#server-sent-events)
- [Events](#events)
- [JavaScript API](#javascript-api)
- [Errors](#errors)
- [Development](#development)

---

## Loading

```html
<head>
    <script src="/x-attributes.js" defer></script>
</head>
```

The script starts by itself: once the page is parsed, it wires every `x-*` element in `<body>`.
`defer` lets the browser download it without blocking the page; the script also works
without it.

To run your own setup first, add `hold` and start it yourself:

```html
<script src="/x-attributes.js" hold></script>
<script>
    // your setup …
    window[Symbol.for('sneera:x-attr:start')]();
</script>
```

Auto-start only happens for a classic `<script>` tag without `hold`:

| Loaded by | Starts by itself |
|---|---|
| `<script src="…">` (with or without `defer`) | yes |
| `<script src="…" hold>` | no |
| `<script type="module" src="…">` | no (`document.currentScript` is `null` in modules) |
| bundled into your own app | depends on your app's `<script>` tag: call `start()` yourself |

Calling `start()` more than once is harmless: elements that are already wired are skipped.

---

## How it works

1. **Start.** `start()` finds every element with an `x-*` verb (`x-get`, …) in `<body>` and
   wires it once: it reads its `x-trigger` and attaches the listener, timer, observer or
   stream subscription it needs.
2. **Trigger.** When the trigger fires, the element collects its values, sends the request
   and waits for HTML.
3. **Swap.** The response is inserted relative to the element's target (`x-target`), the way
   `x-swap` says.
4. **Re-process.** Only the inserted nodes are scanned for new `x-*` elements, which are
   wired in turn. So HTML from the server can contain more `x-*` elements, and they work.
5. **Clean up.** Before a swap removes elements, it stops what they started: open requests
   are aborted, timers cleared, observers disconnected, streams unsubscribed.

There is no MutationObserver: the library only knows about changes it makes itself.
If your own JavaScript adds or removes `x-*` elements, tell it (see
[JavaScript API](#javascript-api)).

---

## Attributes

### x-get

```html
<a href="/jobs" x-get="/jobs" x-target="main">Jobs</a>
```

Sends `GET <url>` with the element's values as a query string (see
[x-include](#x-include)), and swaps the response in.

- One verb per element. Two verbs on one element is an error.
- `x-post`, `x-put`, `x-patch` and `x-delete` are reserved and **not implemented yet**: using
  them throws.
- For links, forms and submit buttons the browser's own navigation is prevented, so the
  `href` or `action` only matters without JavaScript.
- **Latest request wins.** If the element fires again before its previous request has
  finished, the previous one is aborted and ignored.

### x-target

Where the response goes. **Inherited:** the nearest element (itself or an ancestor) with
`x-target` decides, and relative keywords are resolved from that element.
Without `x-target` anywhere up the tree, the target is the element itself.

| Value | Target |
|---|---|
| *(none)* | the element itself |
| `this` | the element that has the `x-target` attribute |
| `<selector>` | the first match in the whole document: `#details`, `main`, … |
| `closest <selector>` | the nearest ancestor (or itself) matching the selector |
| `find <selector>` | the first descendant matching the selector |
| `next <selector>` | the nearest following sibling matching the selector |
| `previous <selector>` | the nearest preceding sibling matching the selector |

```html
<table x-target="closest tr">
    <tr><td>CAB-1234</td><td><button x-get="/jobs/1/row">Refresh</button></td></tr>
</table>
```

A target that matches nothing, or a keyword without a selector, is an error.

### x-swap

How the response is inserted. **Inherited**, like `x-target`.

| Value | Effect |
|---|---|
| `innerHTML` | replace the target's children |
| `outerHTML` | replace the target itself |
| `beforebegin` | insert before the target |
| `afterbegin` | insert as the target's first child |
| `beforeend` | insert as the target's last child |
| `afterend` | insert after the target |
| `delete` | remove the target (the response is ignored) |
| `none` | change nothing |

**Default:** `outerHTML` when the target is a void element (`input`, `img`, `br`, `hr`, …),
because those can't have children; `innerHTML` for everything else.

An unknown value is an error, and the page is left unchanged.

### x-trigger

When the request fires. Read from the element itself, **never inherited**.

| Value | Fires |
|---|---|
| *(none)* | on the element's natural event: `submit` for forms, `change` for `input`/`select`/`textarea`, `click` for everything else (including submit/button/reset/image inputs) |
| `<event>` | on that DOM event: `click`, `keyup`, `input`, … |
| `<event> delay:<time>` | on that event, debounced: once the events stop for that long |
| `load` | once, as soon as the element is wired |
| `every <time>` | repeatedly, while the element is on the page |
| `revealed` | once, the first time the element scrolls into view |
| `sse <event>` | every time the stream at `x-get` sends that event (see [Server-Sent Events](#server-sent-events)) |

Times need a unit: `300ms` or `2s`. A bare number, an unknown modifier, an empty value, or
`load`/`revealed` with anything after them are errors, so a typo never becomes a listener
that silently never fires.

```html
<!-- live search -->
<input name="q" x-get="/jobs/search" x-trigger="input delay:300ms" x-target="#results">

<!-- poll -->
<span x-get="/queue/size" x-trigger="every 10s">3</span>

<!-- infinite scroll: the sentinel replaces itself with the next page and a new sentinel -->
<div x-get="/jobs?before=120" x-trigger="revealed" x-swap="outerHTML">Loading…</div>
```

### x-include

Values to send, from elsewhere on the page. A CSS selector, matched against the whole
document. Each match must be a `<form>` (all its fields are sent) or a form control (its
own value is sent).

```html
<form id="filters">
    <select name="status">…</select>
</form>
<button x-get="/jobs" x-include="#filters" x-target="#jobs">Apply</button>
```

### x-vals

Fixed values, as a flat JSON object of strings, numbers and booleans. They override
values with the same name from the other sources.

```html
<button x-get="/jobs" x-vals='{"status": "open", "page": 2}'>Open jobs</button>
```

Invalid JSON, a non-object, or nested/`null` values are errors.

#### Which values are sent, in order

1. the enclosing `<form>`'s fields, or, outside a form, the element's own `name`/`value`;
2. everything matched by `x-include`;
3. `x-vals`, overriding names from 1 and 2.

Browser form rules apply: disabled and unnamed controls and unchecked checkboxes/radios are
skipped; multi-selects and repeated names (`status[]`) give several values. File inputs are
an error with `x-get`, since files can't go in a query string.

---

## Responses

| Response | What happens |
|---|---|
| `X-Redirect: <url>` header | the page navigates to `<url>` (`location.assign`); nothing is swapped. Any status. |
| 2xx | the body is swapped into the target |
| any other status | nothing is swapped; `x:responseError` is dispatched on the element |
| network failure | `x:sendError` is dispatched on the element |

If the element was removed from the page while the request was in flight, the response is
ignored.

**Respond with fragments.** A request from `x-get` wants only the HTML that goes into the
target, not a full page. Return exactly the markup to insert.

**Use `X-Redirect` for session expiry and similar.** A normal HTTP redirect (`302`) is
followed by `fetch` itself, so the login page would be swapped into the target. With
`X-Redirect` the whole page goes there instead.

---

## Server-Sent Events

The server pushes HTML; elements listen for named events.

```html
<ul id="jobs" x-get="/live" x-trigger="sse jobs:new" x-swap="afterbegin">
    <li x-get="/live" x-trigger="sse job:41" x-swap="outerHTML">#41 · open</li>
    <li x-get="/live" x-trigger="sse job:40" x-swap="outerHTML">#40 · done</li>
</ul>
```

```text
event: jobs:new
data: <li x-get="/live" x-trigger="sse job:42" x-swap="outerHTML">#42 · open</li>

event: job:41
data: <li x-get="/live" x-trigger="sse job:41" x-swap="outerHTML">#41 · in progress</li>

event: job:40
data:
```

- **`x-get`** is the stream URL; **`x-trigger="sse <event>"`** names exactly one event. Colons
  are fine in names; no modifiers.
- Each message's `data` is HTML, swapped in with the element's `x-target` and `x-swap` and then
  wired, like a response. Several `data:` lines are joined with newlines.
- Empty `data` with `outerHTML` removes the element.
- Elements with the same URL **share one connection**. Messages are routed by event name.
  The connection opens with the first element and closes when the last one is gone.
- `x-include` and `x-vals` are read **once**, when the element is wired, and become the stream
  URL's query string. Changing them later does nothing. Elements whose values differ get
  different URLs, and so separate connections.
- An element replaced by `outerHTML` with an element listening on the same URL keeps the
  connection: it isn't closed and reopened.

### Connection behaviour

| Situation | Behaviour |
|---|---|
| stream ends, network fails, or 5xx | reconnects after 1 s, doubling up to 30 s (or the server's `retry:` value); a successful connect resets the wait. `x:sendError` with `retrying: true` |
| 4xx | stops for good; `x:responseError` with the status |
| `X-Redirect` header on connect | navigates there; stops |
| `event: x:redirect`, `data: <url>` | navigates there; stops |
| `event: x:refresh` | reloads the page; stops |

The `x:` event names are reserved and never reach elements.

### Not missing anything: Last-Event-ID

Give every message an `id:`. On a reconnect the library sends the last id it saw in the
`Last-Event-ID` request header, so the server can replay what was missed.

The first connect has no last id. To cover the gap between rendering the page and the
stream opening, put the id the page was rendered at in a hidden input and include it:

```html
<input type="hidden" id="sse-from" name="lastEventId" value="1730000000000-0">
<ul x-get="/live" x-include="#sse-from" x-trigger="sse jobs:new" x-swap="afterbegin">…</ul>
```

The server should then use, in order: the `Last-Event-ID` header (a reconnect), the
`lastEventId` query value (first connect), or "from now". If the id is too old to replay,
send `event: x:refresh` so the page reloads with fresh state.

### Server side (PHP sketch)

```php
header('Content-Type: text/event-stream');
header('Cache-Control: no-store');
header('X-Accel-Buffering: no');

$from = $_SERVER['HTTP_LAST_EVENT_ID'] ?? $_GET['lastEventId'] ?? '$';

// read and send everything after $from, then block for new entries
foreach ($stream->after($from) as $id => $entry) {
    echo "id: {$id}\n";
    echo "event: {$entry['event']}\n";
    foreach (explode("\n", $entry['html']) as $line) {
        echo "data: {$line}\n";
    }
    echo "\n";
    flush();
}
```

Send a comment (`: ping`) every 15–30 s while idle, so proxies don't close the connection.
Over HTTP/1.1 browsers allow only 6 connections per origin, open streams included; serve over
HTTP/2 (Caddy does by default with HTTPS).

---

## Events

All bubble, so one listener on `document` handles every element.

| Event | `detail` | When |
|---|---|---|
| `x:responseError` | `{ url, status }` | non-2xx response; for streams, a 4xx (the stream has stopped) |
| `x:sendError` | `{ url, error }`; for streams also `status` and `retrying` | network failure; for streams, also 5xx and dropped connections |

```js
document.addEventListener('x:responseError', e => {
    console.warn(`${e.detail.url} answered ${e.detail.status}`);
});
```

---

## JavaScript API

With a `<script>` tag, the functions are on `window` under registered symbols:

```js
const x = {
    start:   window[Symbol.for('sneera:x-attr:start')],
    process: window[Symbol.for('sneera:x-attr:process')],
    cleanup: window[Symbol.for('sneera:x-attr:cleanup')],
};
```

| Function | Use |
|---|---|
| `start()` | wire everything in `<body>`. Automatic unless `hold` |
| `process(node)` | wire the `x-*` elements in `node` (itself included) after **your** JS inserted it. Already-wired elements are skipped; non-elements are ignored |
| `cleanup(node)` | stop the requests, timers, observers and streams of `node` and the `x-*` elements inside it, **before your JS deletes it**. The elements are dead afterwards: don't re-insert them |

Moving an element with your own JS (`append`, drag-and-drop sorting) needs neither: it keeps
working.

If you forget `cleanup`, an element still notices it was removed, but only lazily: on its
next timer tick, observer callback or stream message.

---

## Errors

Mistakes in the markup throw an `Error` when the element is wired or fires, with the
offending value in the message, instead of silently doing nothing:

- two verbs on one element, or a verb that isn't implemented yet;
- an invalid `x-trigger`, `x-swap` or `x-vals`;
- an `x-target` or `x-include` that matches nothing;
- a file input in an `x-get` request.

An error in one element wired from a stream message is reported (thrown asynchronously, so
it appears in the console) without breaking the stream for other elements.

---

## Development

Needs [Bun](https://bun.sh).

```sh
bun install
bun run test        # unit tests (happy-dom)
bun run typecheck   # tsc -b
bun run build       # tsdown → dist/
```

- Tests live **in the source files**, below a `// ---- tests (removed from the build) ----`
  line. They use globals (`test`, `describe`, `expect`, `beforeEach`, `afterEach`), never an
  import from `bun:test`, and the build strips them.
- `test/setup.ts` is preloaded for every test file. It provides happy-dom and fakes:
  - `server`: the fake `fetch`. `server.routes[url]` is an HTML string, or
    `{ body, status, headers, delay, fail, stream }`; unknown URLs answer 404.
    `server.requested` lists every URL fetched; `server.streams` lists every open stream,
    with `send(text)`, `end()`, `fail()`, `closed` and `lastEventId`.
  - `viewport`: drives the fake IntersectionObserver (`reveal(el)`, `hide(el)`, `isObserved(el)`).
  - `page`: records `location.assign` (`page.navigated`) and `location.reload` (`page.reloads`).
  - `settle(ms)`: waits for timers and pending fetches.
- Stream connections are module state and outlive a test, so each SSE test should use its own
  URL.