# x-attributes

A small library that adds HTML attributes for server-driven pages, in the spirit of htmx.
Elements send requests and swap the HTML that comes back into the page; Server-Sent Events
push updates into it. No framework, no virtual DOM, no client-side templates: the server
renders HTML, the browser inserts it.

```html
<button x-get="/jobs/42" x-target="#details">Show job</button>
<div id="details"></div>
```

Clicking the button requests `GET /jobs/42` and puts the returned HTML inside `#details`.

---

## Contents

- [Loading](#loading)
- [How it works](#how-it-works)
- [Verbs](#verbs)
  - [x-get](#x-get)
  - [x-post, x-put, x-patch](#x-post-x-put-x-patch)
  - [x-delete](#x-delete)
- [Modifiers](#modifiers)
  - [x-target](#x-target)
  - [x-swap](#x-swap)
  - [x-trigger](#x-trigger)
  - [x-include](#x-include)
  - [x-vals](#x-vals)
  - [x-headers](#x-headers)
  - [Which values are sent](#which-values-are-sent)
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
| `<script type="module" src="…">` | no (`document.currentScript` is `null` in modules): call `start()` |
| bundled into your own app | depends on your app's `<script>` tag: call `start()` yourself |

If your bundler splits shared code into chunks, its output is an ES module: load it with
`type="module"` and call `start()`. Calling `start()` more than once is harmless: elements
that are already wired are skipped.

---

## How it works

1. **Start.** `start()` finds every element with a verb (`x-get`, `x-post`, …) in `<body>` and
   wires it once: it reads its `x-trigger` and attaches the listener, timer, observer or
   stream subscription it needs.
2. **Trigger.** When the trigger fires, the element collects its values and headers, sends
   the request and waits for HTML.
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

## Verbs

A verb says **what request** an element sends, and to which URL. One verb per element; two
on one element is an error.

| Verb | Method | Values go in | Can use `sse` |
|---|---|---|---|
| `x-get` | `GET` | the query string | yes |
| `x-post` | `POST` | the body (multipart) | no |
| `x-put` | `PUT` | the body (multipart) | no |
| `x-patch` | `PATCH` | the body (multipart) | no |
| `x-delete` | `DELETE` | the query string | no |

What every verb shares:

- **The modifiers below work the same for all of them:** target, swap, trigger, values,
  headers.
- **Every request carries** `X-Attr-Request: true` and `Accept: text/html`, so the server can
  tell it from a page load.
- **Latest request wins.** If the element fires again before its previous request has
  finished, the previous one is aborted and ignored.
- **For links, forms and submit buttons the browser's own navigation is prevented**, so an
  `href` or `action` only matters without JavaScript.

### x-get

```html
<a href="/jobs" x-get="/jobs" x-target="main">Jobs</a>
```

| Parameter | Meaning |
|---|---|
| a URL | the page or fragment to request: `/jobs`, `/jobs?status=open`, `https://…` |

Sends `GET <url>` with the element's values appended to the query string, and swaps the
response in. A URL that already has a query keeps it; values are added after.

`x-get` is the only verb that can be a **stream**: with `x-trigger="sse <event>"` the URL is
an SSE endpoint, and each event's HTML is swapped in. See [Server-Sent Events](#server-sent-events).

### x-post, x-put, x-patch

```html
<form x-post="/jobs" x-target="#jobs" x-swap="afterbegin">
    <input name="plate">
    <input type="file" name="photo">
    <button>Create</button>
</form>
```

| Parameter | Meaning |
|---|---|
| a URL | where to send the request |

Sends the values as a **`multipart/form-data` body**, so file inputs work. The URL is used
as written. These verbs cannot use an `sse` trigger: a stream is a read, and an automatic
reconnect would repeat the action.

PHP reads the body with `$_POST` / `$_FILES` for POST, and `request_parse_body()` for PUT and
PATCH.

### x-delete

```html
<button x-delete="/jobs/42" x-vals="reason=duplicate" x-target="closest li" x-swap="delete">Remove</button>
```

| Parameter | Meaning |
|---|---|
| a URL | the thing to delete |

Sends `DELETE` with the values in the **query string** (some proxies drop DELETE bodies). File
inputs are an error, as for `x-get`.

---

## Modifiers

Modifiers say **where** the response goes, **how** it is inserted, **when** the request is
sent, and **what** goes with it. They work with every verb.

| Modifier | Decides | Inherited |
|---|---|---|
| `x-target` | where the response goes | yes: nearest one wins |
| `x-swap` | how it is inserted | yes: nearest one wins |
| `x-trigger` | when the request is sent | no |
| `x-include` | values from elsewhere on the page | no |
| `x-vals` | fixed values | no |
| `x-headers` | extra request headers | yes: all levels are merged |

**Inherited** means the element uses the attribute from itself or its nearest ancestor that has
it, so one attribute on a container covers everything inside. `x-headers` goes further: every
ancestor's headers are combined.

### x-target

Where the response goes. **Inherited:** the nearest element (itself or an ancestor) with
`x-target` decides, and relative keywords are resolved from that element. Without
`x-target` anywhere up the tree, the target is the element itself.

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

When the request is sent. Read from the element itself, **never inherited**.

| Value | Fires |
|---|---|
| *(none)* | on the element's natural event: `submit` for forms, `change` for `input`/`select`/`textarea`, `click` for everything else (including submit/button/reset/image inputs) |
| `<event>` | on that DOM event: `click`, `keyup`, `input`, … |
| `<event> delay:<time>` | on that event, debounced: once the events stop for that long |
| `load` | once, as soon as the element is wired |
| `every <time>` | repeatedly, while the element is on the page |
| `revealed` | once, the first time the element scrolls into view |
| `sse <event>` | every time the stream at `x-get` sends that event (`x-get` only; see [Server-Sent Events](#server-sent-events)) |

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

Values to send from elsewhere on the page. **Not inherited.**

| Value | Sends |
|---|---|
| a CSS selector | every match, from anywhere in the document: a matched `<form>` sends all its fields, a matched control (`input`, `select`, `textarea`, `button`) sends its own value |

```html
<form id="filters">
    <select name="status">…</select>
</form>
<button x-get="/jobs" x-include="#filters" x-target="#jobs">Apply</button>
```

A selector that matches nothing, or matches something that isn't a form or control, is an
error.

### x-vals

Fixed values. **Not inherited.** They replace every value with the same name from the other
sources.

| Value | Format |
|---|---|
| a query string | `status=open&page=2&s[]=3&s[]=7`: repeated names allowed, percent-encoded |
| a JSON object (starts with `{`) | `{"status": "open", "page": 2}`: flat, strings, numbers and booleans only |

```html
<button x-get="/jobs" x-vals="status=open&page=2">Open jobs</button>
<button x-get="/jobs" x-vals='{"status": "open", "page": 2}'>Open jobs</button>
```

From PHP, build the query-string form with `htmlspecialchars(http_build_query([...]))`: values
are percent-encoded and the attribute stays valid. In JSON, invalid JSON or nested/`null` values
are errors, and a name can appear only once.

### x-headers

Extra request headers. **Inherited and merged:** every ancestor's `x-headers`, from the
outermost down to the element, are combined; a closer one replaces a farther one with the same
name (names compare without case).

| Value | Format |
|---|---|
| a query string | `X-Csrf-Token=abc&X-Tenant=7` |
| a JSON object (starts with `{`) | `{"X-Tenant": 7}` |
| `Name=` (empty value) | removes a header set by an ancestor |

```html
<body x-headers="X-Csrf-Token=<?= $csrf ?>&X-Tenant=7">
    <button x-post="/jobs/42/close">Close</button>                       <!-- both headers -->
    <button x-post="/jobs/42/note" x-headers="X-Tenant=9">Note</button>  <!-- token, X-Tenant: 9 -->
    <ul x-get="/live" x-trigger="sse jobs:new" x-headers="X-Csrf-Token="></ul>  <!-- X-Tenant only -->
</body>
```

- Sent with **every verb**, read each time a request fires. CSRF tokens go here: one
  `x-headers` on `<body>` covers the whole page.
- On a **stream** they are read once, when the element subscribes, and become part of the
  connection's identity: elements with different headers get separate connections. Keep
  per-render values (a fresh CSRF token in a fragment) off streams with `Name=`.
- **Errors:** a reserved name (`Accept`, `Content-Type`, `X-Attr-Request`, `Last-Event-ID`,
  which the library sets itself), an invalid header name, or the same name twice in one
  attribute.

### Which values are sent

1. the enclosing `<form>`'s fields, or, outside a form, the element's own `name`/`value`;
2. everything matched by `x-include`, added after 1 (a name in both is sent twice);
3. `x-vals`, replacing every value of a name it shares with 1 or 2.

Browser form rules apply: disabled and unnamed controls and unchecked checkboxes/radios are
skipped; multi-selects and repeated names (`status[]`) give several values; a checked
checkbox without a `value` sends `on`. Files are sent by POST, PUT and PATCH, and are an error
for GET and DELETE, which can't put them in a query string.

---

## Responses

| Response | What happens |
|---|---|
| `X-Attr-Redirect: <url>` header | the page navigates to `<url>` (`location.assign`); nothing is swapped. Any status except 3xx; `204` is usual. |
| a plain 3xx redirect | not followed: the page reloads, so the page route's own redirect takes over |
| 2xx | the body is swapped into the target |
| any other status | nothing is swapped; `x-attr:response-error` is dispatched on the element |
| network failure | `x-attr:request-error` is dispatched on the element |

If the element was removed from the page while the request was in flight, the response is
ignored.

**Respond with fragments.** A request from the library wants only the HTML that goes into the
target, not a full page. Return exactly the markup to insert.

**Send `X-Attr-Redirect` to library requests, `302` to page loads.** Middleware that redirects
(an expired session, say) can tell the two apart by the `X-Attr-Request` header:

```php
if (isset($request->headers[RequestHeaders::XAttrRequest])) {
    return Response::empty(HttpStatus::NoContent, [ResponseHeaders::XAttrRedirect->value => ['/login']]);
}
return Response::redirect('/login');
```

A plain `302` sent to a library request still ends well (the page reloads and the page
route redirects), but costs an extra round trip and lands wherever the page route sends it,
not necessarily where the `302` pointed.

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
- Elements with the same URL and headers **share one connection**; messages are routed by
  event name. The connection opens with the first element and closes when the last one is gone.
- `x-include`, `x-vals` and `x-headers` are read **once**, when the element is wired. Values
  become the stream URL's query string. Changing them later does nothing.
- An element replaced by `outerHTML` with an element listening on the same stream keeps the
  connection: it isn't closed and reopened.
- One broken element (a target that matches nothing, say) reports its error without breaking
  the stream for the others.

**Put in the URL only what defines the stream** (`?status=open`, `?format=html`), never values
specific to one page load: those make every tab and fragment a different URL, so nothing is
shared.

### Connection behaviour

| Situation | Behaviour |
|---|---|
| stream ends, network fails, or 5xx | reconnects after 1 s, doubling up to 30 s (or the server's `retry:` value, which then stays); a successful connect resets the wait. `x-attr:request-error` with `retrying: true` |
| 4xx | stops for good; `x-attr:response-error` with the status |
| `X-Attr-Redirect` header on connect | navigates there; stops |
| a plain 3xx on connect | reloads the page; stops |
| `event: x-attr:redirect`, `data: <url>` | navigates there; stops |
| `event: x-attr:refresh` | reloads the page; stops |

The `x-attr:redirect` and `x-attr:refresh` event names are reserved and never reach elements.
Stream connects carry `Accept: text/event-stream`, `X-Attr-Request: true` and the element's
`x-headers`.

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
send `event: x-attr:refresh` so the page reloads with fresh state.

The id can also come from `x-vals` (`x-vals="lastEventId=…"`), but only on page-level markup:
a fragment rendered later would carry a newer id, which is a different URL and so a separate
connection.

### Server side (PHP sketch)

Every `data:` line must be prefixed: a multi-line fragment sent as one `data:` line loses
everything after its first line break.

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
| `x-attr:response-error` | `{ url, status }` | non-2xx response; for streams, a 4xx (the stream has stopped) |
| `x-attr:request-error` | `{ url, message }`; for streams also `status` and `retrying` | network failure; for streams, also 5xx and dropped connections |

```js
document.addEventListener('x-attr:response-error', e => {
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

- two verbs on one element, or an `sse` trigger on a verb other than `x-get`;
- an invalid `x-trigger`, `x-swap`, `x-vals` or `x-headers`;
- an `x-target` or `x-include` that matches nothing;
- a file input in a GET or DELETE request (files can't go in a query string).

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

Run `typecheck` along with the tests: some mistakes (a missing argument that shifts the others,
a missing field in an object) compile into code that runs but misbehaves, and only the type
checker reports them where they are.

- Tests live **in the source files**, below a `// ---- tests (removed from the build) ----`
  line. They use globals (`test`, `describe`, `expect`, `beforeEach`, `afterEach`), never an
  import from `bun:test`, and the build strips them.
- `test/setup.ts` is preloaded for every test file. It provides happy-dom and fakes:
  - `server`: the fake `fetch`. `server.routes[url]` is an HTML string, or
    `{ body, status, headers, delay, fail, stream, redirect }`; unknown URLs answer 404.
    `redirect` answers like a plain 3xx under `redirect: 'manual'` (an opaque redirect).
    Same-origin absolute URLs are matched and recorded by path.
    `server.requested` lists every URL fetched, `server.headers` their request headers;
    `server.streams` lists every open stream, with `send(text)`, `end()`, `fail()`, `closed`
    and `lastEventId`.
  - `viewport`: drives the fake IntersectionObserver (`reveal(el)`, `hide(el)`, `isObserved(el)`).
  - `page`: records `location.assign` (`page.navigated`) and `location.reload` (`page.reloads`).
  - `settle(ms)`: waits for timers and pending fetches.
- SSE connections are shared, module-level state and outlive a test. A test that wires SSE
  elements cleans up after itself with `cleanup(document.body)` (and a `settle()`) in
  `afterEach`, so its streams close before the next test.

### Source layout

| Folder | Holds |
|---|---|
| `handlers/` | one wiring function per verb: `get.ts` (with streams), `send.ts` (POST, PUT, PATCH, DELETE) |
| `fire/` | shared by every verb: `request.ts` (build, send, handle the response) and `bind.ts` (carry out `x-trigger`) |
| `modifiers/` | the attribute readers: target, swap, trigger, include, vals, headers |
| `shared/` | building blocks with no dependencies outside `shared/`: values, form reading, the `x-vals`/`x-headers` parser, cleanup, header and event names |
| `sse/` | `parse.ts` (wire format), `stream.ts` (one connection, page-free), `transport.ts` (messages), `broker.ts` (owns connections), `subscriber.ts` (the tab side), `index.ts` (wires them, lazily) |
