// src/shared/attrs.ts
let Verbs = /* @__PURE__ */ function(Verbs) {
	Verbs["GET"] = "x-get";
	Verbs["POST"] = "x-post";
	Verbs["PUT"] = "x-put";
	Verbs["PATCH"] = "x-patch";
	Verbs["DELETE"] = "x-delete";
	return Verbs;
}({});
let Attributes;
(function(_Attributes) {
	function map(attrs) {
		return (Array.isArray(attrs) ? attrs : [attrs]).map((v) => `[${v}]`).join(",");
	}
	_Attributes.map = map;
	function inElement(node, attrs) {
		return (Array.isArray(attrs) ? attrs : [attrs]).reduce((acc, v) => acc && node.hasAttribute(`${v}`), true);
	}
	_Attributes.inElement = inElement;
})(Attributes || (Attributes = {}));
// src/shared/defaults.ts
const defaultTrigger = {
	a: "click",
	abbr: "click",
	address: "click",
	area: "click",
	article: "click",
	aside: "click",
	audio: "click",
	b: "click",
	base: "click",
	bdi: "click",
	bdo: "click",
	blockquote: "click",
	body: "click",
	br: "click",
	button: "click",
	canvas: "click",
	caption: "click",
	cite: "click",
	code: "click",
	col: "click",
	colgroup: "click",
	data: "click",
	datalist: "click",
	dd: "click",
	del: "click",
	details: "click",
	dfn: "click",
	dialog: "click",
	div: "click",
	dl: "click",
	dt: "click",
	em: "click",
	embed: "click",
	fieldset: "click",
	figcaption: "click",
	figure: "click",
	footer: "click",
	form: "submit",
	h1: "click",
	h2: "click",
	h3: "click",
	h4: "click",
	h5: "click",
	h6: "click",
	head: "click",
	header: "click",
	hgroup: "click",
	hr: "click",
	html: "click",
	i: "click",
	iframe: "click",
	img: "click",
	input: "change",
	ins: "click",
	kbd: "click",
	label: "click",
	legend: "click",
	li: "click",
	link: "click",
	main: "click",
	map: "click",
	mark: "click",
	menu: "click",
	meta: "click",
	meter: "click",
	nav: "click",
	noscript: "click",
	object: "click",
	ol: "click",
	optgroup: "click",
	option: "click",
	output: "click",
	p: "click",
	picture: "click",
	pre: "click",
	progress: "click",
	q: "click",
	rp: "click",
	rt: "click",
	ruby: "click",
	s: "click",
	samp: "click",
	script: "click",
	search: "click",
	section: "click",
	select: "change",
	slot: "click",
	small: "click",
	source: "click",
	span: "click",
	strong: "click",
	style: "click",
	sub: "click",
	summary: "click",
	sup: "click",
	table: "click",
	tbody: "click",
	td: "click",
	template: "click",
	textarea: "change",
	tfoot: "click",
	th: "click",
	thead: "click",
	time: "click",
	title: "click",
	tr: "click",
	track: "click",
	u: "click",
	ul: "click",
	var: "click",
	video: "click",
	wbr: "click"
};
const defaultSwap = {
	a: "innerHTML",
	abbr: "innerHTML",
	address: "innerHTML",
	area: "outerHTML",
	article: "innerHTML",
	aside: "innerHTML",
	audio: "innerHTML",
	b: "innerHTML",
	base: "outerHTML",
	bdi: "innerHTML",
	bdo: "innerHTML",
	blockquote: "innerHTML",
	body: "innerHTML",
	br: "outerHTML",
	button: "innerHTML",
	canvas: "innerHTML",
	caption: "innerHTML",
	cite: "innerHTML",
	code: "innerHTML",
	col: "outerHTML",
	colgroup: "innerHTML",
	data: "innerHTML",
	datalist: "innerHTML",
	dd: "innerHTML",
	del: "innerHTML",
	details: "innerHTML",
	dfn: "innerHTML",
	dialog: "innerHTML",
	div: "innerHTML",
	dl: "innerHTML",
	dt: "innerHTML",
	em: "innerHTML",
	embed: "outerHTML",
	fieldset: "innerHTML",
	figcaption: "innerHTML",
	figure: "innerHTML",
	footer: "innerHTML",
	form: "innerHTML",
	h1: "innerHTML",
	h2: "innerHTML",
	h3: "innerHTML",
	h4: "innerHTML",
	h5: "innerHTML",
	h6: "innerHTML",
	head: "innerHTML",
	header: "innerHTML",
	hgroup: "innerHTML",
	hr: "outerHTML",
	html: "innerHTML",
	i: "innerHTML",
	iframe: "innerHTML",
	img: "outerHTML",
	input: "outerHTML",
	ins: "innerHTML",
	kbd: "innerHTML",
	label: "innerHTML",
	legend: "innerHTML",
	li: "innerHTML",
	link: "outerHTML",
	main: "innerHTML",
	map: "innerHTML",
	mark: "innerHTML",
	menu: "innerHTML",
	meta: "outerHTML",
	meter: "innerHTML",
	nav: "innerHTML",
	noscript: "innerHTML",
	object: "innerHTML",
	ol: "innerHTML",
	optgroup: "innerHTML",
	option: "innerHTML",
	output: "innerHTML",
	p: "innerHTML",
	picture: "innerHTML",
	pre: "innerHTML",
	progress: "innerHTML",
	q: "innerHTML",
	rp: "innerHTML",
	rt: "innerHTML",
	ruby: "innerHTML",
	s: "innerHTML",
	samp: "innerHTML",
	script: "innerHTML",
	search: "innerHTML",
	section: "innerHTML",
	select: "innerHTML",
	slot: "innerHTML",
	small: "innerHTML",
	source: "outerHTML",
	span: "innerHTML",
	strong: "innerHTML",
	style: "innerHTML",
	sub: "innerHTML",
	summary: "innerHTML",
	sup: "innerHTML",
	table: "innerHTML",
	tbody: "innerHTML",
	td: "innerHTML",
	template: "innerHTML",
	textarea: "innerHTML",
	tfoot: "innerHTML",
	th: "innerHTML",
	thead: "innerHTML",
	time: "innerHTML",
	title: "innerHTML",
	tr: "innerHTML",
	track: "outerHTML",
	u: "innerHTML",
	ul: "innerHTML",
	var: "innerHTML",
	video: "innerHTML",
	wbr: "outerHTML"
};
// src/shared/resolve.ts
function resolveTrigger(el) {
	return el.getAttribute("x-trigger") ?? defaultTrigger[el.localName];
}
function resolveSwap(el) {
	return el.getAttribute("x-swap") ?? defaultSwap[el.localName];
}
/**
* Finds the element a response should be swapped into.
*
* x-target is inherited: the nearest element (self or ancestor) that has it
* is the "owner", and relative keywords are resolved from the owner.
* No x-target anywhere up the tree → the element itself.
*
* @throws Error when the value is malformed or matches nothing
*/
function resolveTarget(el) {
	const owner = el.closest("[x-target]");
	if (owner === null) return el;
	const value = owner.getAttribute("x-target").trim();
	const space = value.indexOf(" ");
	const keyword = space === -1 ? value : value.slice(0, space);
	const selector = space === -1 ? "" : value.slice(space + 1).trim();
	let found;
	switch (keyword) {
		case "this":
			found = owner;
			break;
		case "closest":
			found = owner.closest(requireSelector(value, selector));
			break;
		case "find":
			found = owner.querySelector(requireSelector(value, selector));
			break;
		case "next":
			found = sibling(owner, requireSelector(value, selector), "nextElementSibling");
			break;
		case "previous":
			found = sibling(owner, requireSelector(value, selector), "previousElementSibling");
			break;
		default: found = document.querySelector(value);
	}
	if (found === null) throw new Error(`x-target matched nothing: ${value}`);
	return found;
}
function requireSelector(value, selector) {
	if (selector === "") throw new Error(`x-target is missing a selector: ${value}`);
	return selector;
}
function sibling(start, selector, direction) {
	let current = start[direction];
	while (current !== null) {
		if (current.matches(selector)) return current;
		current = current[direction];
	}
	return null;
}
// src/handlers/get.ts
function get(node) {
	const url = node.getAttribute("x-get");
	if (url === null) throw new Error("get() called on an element without x-get");
	const trigger = resolveTrigger(node);
	node.addEventListener(trigger, async (e) => {
		if (trigger === "submit" || node.matches("a")) e.preventDefault();
		const target = resolveTarget(node);
		const swap = resolveSwap(target);
		const response = await fetch(url);
		if (!response.ok) return;
		const html = await response.text();
		switch (swap) {
			case "innerHTML":
				target.innerHTML = html;
				break;
			case "outerHTML": target.outerHTML = html;
		}
	});
}
// src/process.ts
const VERB_NAMES = Object.values(Verbs).filter((v) => typeof v === "string");
const SELECTOR = Attributes.map(VERB_NAMES);
function dummyHandler(node) {
	console.log("Not implemented yet");
}
const handlers = {
	["x-get"]: get,
	["x-post"]: dummyHandler,
	["x-put"]: dummyHandler,
	["x-patch"]: dummyHandler,
	["x-delete"]: dummyHandler
};
function process(node, processed) {
	if (!(node instanceof Element)) return;
	const elements = [...node.querySelectorAll(SELECTOR)];
	if (node.matches(SELECTOR)) elements.unshift(node);
	for (const el of elements) if (!processed.has(el)) {
		processed.add(el);
		init(el);
	}
}
function init(el) {
	for (const [attribute, handler] of Object.entries(handlers)) if (el.hasAttribute(attribute)) {
		handler(el);
		return;
	}
}
// src/index.ts
const processed = /* @__PURE__ */ new WeakSet();
/** Wires up the page. Call once, after registering SSE clients. */
function start(root = document.body) {
	process(root, processed);
}
/** Wires up HTML you inserted with your own code. */
function processNode(node) {
	process(node, processed);
}
export { processNode, start };

//# sourceMappingURL=index.js.map