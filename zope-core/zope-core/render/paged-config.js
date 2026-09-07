/**
 * Injected BEFORE paged.polyfill.js. Paged.js reads window.PagedConfig at load
 * time, so ordering matters — configure after the polyfill loads and it has
 * already started laying out with defaults.
 */
window.__pagedDone = false;
window.__pagedPages = 0;

window.PagedConfig = {
  // We call preview ourselves only after fonts are ready; auto must be off or
  // Paged.js starts on DOMContentLoaded and may paginate against fallbacks.
  auto: true,

  before: function () {
    // Chapter openers must not carry a running head. Paged.js can't select
    // "the page a given element started on" from CSS, so tag it here and let
    // the generated @page chapter-opening rule do the rest.
    document.querySelectorAll(".block--chapter, .block--part").forEach(function (el) {
      el.style.setProperty("page", "chapter-opening");
    });
  },

  after: function (flow) {
    window.__pagedPages = flow.total;
    window.__pagedDone = true;
  },
};

/**
 * Paged.js hooks worth knowing about when you extend this:
 *
 *   afterPageLayout(pageFragment, page, breakToken)
 *     Fires per page. This is where a custom footnote handler would live if
 *     you replace the built-in one — which you probably will, since
 *     `float: footnote` mishandles notes longer than the remaining space.
 *
 *   afterParsed(parsed)
 *     The content tree before layout. Good place to inject the generated
 *     table of contents, because target-counter() can then resolve against
 *     anchors that exist at layout time.
 *
 *   beforeParsed(content)
 *     Last chance to rewrite markup. Resist the temptation: anything done here
 *     is invisible to the editor preview and the two renderings diverge.
 */
