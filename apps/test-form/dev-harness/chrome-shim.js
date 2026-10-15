// DEV-ONLY: minimal chrome.* stand-in so the built side panel can run in a normal browser
// tab next to the test form (see /__dev/harness). Never shipped in the extension.
(function () {
  var mem = { local: { serverUrl: location.origin }, session: {} };
  // Dev convenience: a session saved by the harness survives reloading the panel frame.
  // Dev convenience: sign in as the seeded dev test user (POST /__dev/session) before the panel starts.
  var xhr = new XMLHttpRequest();
  try {
    // ?as=cafe on the harness page signs in as the dev café owner instead of the dev customer.
    var as = new URLSearchParams(window.parent.location.search).get("as");
    xhr.open("POST", "/__dev/session" + (as === "cafe" ? "?as=cafe" : ""), false);
    xhr.send();
    if (xhr.status === 200) mem.session.session = JSON.parse(xhr.responseText);
  } catch {
    // no dev user seeded: the panel shows its normal sign-in
  }
  function area(name) {
    return {
      get: function (key) { var o = {}; if (key in mem[name]) o[key] = mem[name][key]; return Promise.resolve(o); },
      set: function (obj) { Object.assign(mem[name], obj); return Promise.resolve(); },
      remove: function (key) { delete mem[name][key]; return Promise.resolve(); },
    };
  }
  function formWindow() { return window.parent.frames["form"]; }
  var noopEvent = { addListener: function () {}, removeListener: function () {} };
  window.chrome = {
    storage: { local: area("local"), session: area("session") },
    permissions: { contains: function () { return Promise.resolve(true); }, request: function () { return Promise.resolve(true); }, remove: function () { return Promise.resolve(true); } },
    tabs: {
      query: function () { return Promise.resolve([{ id: 1, url: formWindow().location.href, title: formWindow().document.title }]); },
      create: function (o) { window.open(o.url, "_blank"); return Promise.resolve(); },
      sendMessage: function (_id, msg) {
        var w = formWindow();
        if (msg.type === "UFA_DETECT") return Promise.resolve(Object.assign({ ok: true }, w.UFADetector.detect()));
        if (msg.type === "UFA_VERIFY") return Promise.resolve({ ok: true, results: w.UFADetector.verify(msg.items) });
        if (msg.type === "UFA_HIGHLIGHT") {
          var el = w.document.querySelector('[data-ufa-id="' + msg.fieldId + '"]');
          if (el) { el.scrollIntoView({ block: "center" }); el.style.outline = "3px solid #2453e0"; setTimeout(function () { el.style.outline = ""; }, 1600); }
          return Promise.resolve({ ok: !!el });
        }
        if (msg.type === "UFA_FILL") return w.UFADetector.fill(msg.items, msg.visual).then(function (results) { return { ok: true, results: results }; });
        if (msg.type === "UFA_UNDO") return Promise.resolve({ ok: true, restored: w.UFADetector.undo() });
        if (msg.type === "UFA_LIST_UPLOADS") return Promise.resolve({ ok: true, fields: w.UFADetector.listUploads() });
        if (msg.type === "UFA_ATTACH_FILE") return Promise.resolve({ ok: true, outcome: w.UFADetector.attach(msg.fieldId, msg.name, msg.mime, msg.base64) });
        if (msg.type === "UFA_INSERT_EMAIL") return Promise.resolve({ ok: true, result: w.UFADetector.insertEmail({ subject: msg.subject, body: msg.body }) });
        if (msg.type === "UFA_UNDO_EMAIL") return Promise.resolve({ ok: true, restored: w.UFADetector.undoEmail() });
        return Promise.resolve({ ok: true });
      },
      onActivated: noopEvent,
      onUpdated: noopEvent,
    },
    scripting: {
      executeScript: function () {
        var w = formWindow();
        if (w.UFADetector) return Promise.resolve([]);
        return new Promise(function (ok, fail) {
          var s = w.document.createElement("script"); s.src = "/__dev/detector.js"; s.onload = function () { ok([]); }; s.onerror = fail;
          w.document.head.appendChild(s);
        });
      },
    },
    runtime: { onMessage: noopEvent, sendMessage: function () { return Promise.resolve(); } },
    sidePanel: { setPanelBehavior: function () { return Promise.resolve(); } },
  };
})();
