import { Verbs } from "../shared/attrs";
import { get } from "./get";

type Handler = (el: Element, reprocess: (node: Node) => void) => void;

export const HANDLERS: Record<Verbs, Handler> = {
    [Verbs.GET]: get,
    [Verbs.POST]: notImplemented,
    [Verbs.PUT]: notImplemented,
    [Verbs.PATCH]: notImplemented,
    [Verbs.DELETE]: notImplemented,
};

// TEMPORARY: until post/put/patch/delete exist
function notImplemented(el: Element): void {
    throw new Error(`${el.localName}: this verb isn't implemented yet`);
}