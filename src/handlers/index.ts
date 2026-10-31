import { Verbs } from "../shared/attrs";
import { get } from "./get";
import { post, put, patch, del } from "./send";

type Handler = (el: Element, reprocess: (node: Node) => void) => void;

export const HANDLERS: Record<Verbs, Handler> = {
    [Verbs.GET]: get,
    [Verbs.POST]: post,
    [Verbs.PUT]: put,
    [Verbs.PATCH]: patch,
    [Verbs.DELETE]: del,
};