/**
 * Combination of HTML, SVG, and MathML tag name maps.
 */
type ElementTagNameMap = HTMLElementTagNameMap & SVGElementTagNameMap & MathMLElementTagNameMap;

/**
 * Infer the element type from a tag
 * with a fallback for arbitrary strings
 */
export type ElementForTag<K extends ElementTag> =
    K extends keyof ElementTagNameMap
        ? ElementTagNameMap[K]
        : Element;

/**
 * A known HTML, SVG, or MathML tag name, or a custom tag name.
 */
export type ElementTag = keyof ElementTagNameMap | (string & {});