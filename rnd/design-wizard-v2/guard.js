/* ============================================================================
   R&D SAFETY GUARD — must load BEFORE store.js.

   store.js's CHECKOUT_API_BASE is a runtime hostname check: it points at the
   STAGING api only on dev.kcmps.com, and at PRODUCTION everywhere else — which
   includes localhost. So an unguarded "Place order" click in this mockup would
   create a real production order and email a real customer notification.

   This wraps fetch() and rejects any call leaving the machine. store.js's
   design-manifest fetch (a relative URL) is untouched and still resolves to a
   404 here, which it already treats as a silent no-op by design.
   ============================================================================ */
(function () {
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!realFetch) return;

  window.fetch = function (input) {
    var url = String((input && input.url) || input || "");
    if (/^https?:\/\//i.test(url)) {
      // eslint-disable-next-line no-console
      console.warn("[rnd mockup] blocked outbound request:", url);
      window.dispatchEvent(new CustomEvent("rnd:blocked-request", { detail: { url: url } }));
      return Promise.reject(new Error("R&D mockup: outbound API calls are blocked."));
    }
    return realFetch.apply(null, arguments);
  };
})();
