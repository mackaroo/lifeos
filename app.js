/* lifeOS: one JSON file in your Google Drive is the whole database.
   Local changes are kept as a queue of operations and replayed onto the latest
   Drive copy on every save, so edits from other devices (or Claude) are not lost. */
(function () {
  "use strict";
  var CFG = window.LIFEOS_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var CACHE = "lifeos.cache.v1", UI = "lifeos.ui.v1";
  // Full Drive scope so the app can read inbox files that Claude creates through the Drive
  // connector (the connector can create files but cannot rewrite one).
  var SCOPE = "https://www.googleapis.com/auth/drive";
  var INBOX = "lifeos-inbox";

  /* ---------- small helpers ---------- */
  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function ls(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || "null"); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function today() { return ymd(new Date()); }
  function addDays(n) { var d = new Date(); d.setDate(d.getDate() + n); return ymd(d); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function money(n) { return "$" + (Number(n) || 0).toFixed(2); }
  function short(s) { if (!s) return ""; var d = new Date(s + "T00:00:00"); return isNaN(d) ? s : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
  function newestFirst(a, b) { return String(b.added || b.date || "").localeCompare(String(a.added || a.date || "")) || String(b.id).localeCompare(String(a.id)); }

  function emptyData() {
    return { app: "lifeOS", format: 1, updated: "", categories: {
      Personal: "#ff8fab", Home: "#ffb3c7", Work: "#c9b8ff", Money: "#b8f0d8", Squishies: "#ffd6f0", "Sell & declutter": "#a8c8ff"
    }, todos: [], notes: [], spending: [], wishlist: [], log: [], systems: [] };
  }

  /* ---------- state ---------- */
  var cache = ls(CACHE) || {};
  var data = cache.data || emptyData();
  var ops = cache.ops || [];
  var fileId = cache.fileId || null;
  var ui = Object.assign({ tab: "todo", cat: "" }, ls(UI) || {});
  function persist() { ls(CACHE, { data: data, ops: ops, fileId: fileId }); }

  function apply(d, op) {
    var list = d[op.list] || (d[op.list] = []);
    var i = list.findIndex(function (x) { return x.id === op.id; });
    if (op.t === "del") { if (i >= 0) list.splice(i, 1); }
    else if (op.t === "put") { if (i >= 0) list[i] = Object.assign({}, list[i], op.item); else list.unshift(op.item); }
    else if (op.t === "cats") { d.categories = Object.assign({}, d.categories, op.cats); }
    return d;
  }
  function change(op) { ops.push(op); apply(data, op); persist(); render(); scheduleSave(); }
  function put(list, item) { change({ t: "put", list: list, id: item.id, item: item }); }
  function del(list, id) { change({ t: "del", list: list, id: id }); }
  function catColor(c) { return (data.categories && data.categories[c]) || "#c9b8ff"; }

  /* ---------- Google sign-in + Drive ---------- */
  // Google access tokens last an hour. Browsers only allow the sign-in popup after a click,
  // so the token is kept across reloads and, once expired, the Connect button reappears.
  var saved = ls("lifeos.token") || {};
  if (saved.s !== SCOPE) saved = {};
  var token = saved.t || null, tokenExp = saved.exp || 0, tokenClient = null, pendingToken = [];
  function hasToken() { return token && Date.now() < tokenExp; }
  function setSync(text, err) { var s = $("sync"); s.textContent = text; s.classList.toggle("err", !!err); }
  function needSignIn(text) { $("signin").hidden = false; setSync(text || "Not connected", true); }

  function initGoogle() {
    if (!window.google || !google.accounts || !google.accounts.oauth2) return setTimeout(initGoogle, 200);
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.googleClientId, scope: SCOPE, prompt: "",
      callback: function (r) {
        if (r.error) { needSignIn(); flushToken(null); return; }
        token = r.access_token; tokenExp = Date.now() + (r.expires_in - 60) * 1000;
        ls("lifeos.token", { t: token, exp: tokenExp, s: SCOPE }); ls("lifeos.signedin", true);
        $("signin").hidden = true; flushToken(token);
      },
      error_callback: function () { needSignIn(); flushToken(null); }
    });
    $("signin").innerHTML = '<i class="ti ti-brand-google-drive" aria-hidden="true"></i> ' + (ls("lifeos.signedin") ? "Reconnect Drive" : "Connect Drive");
    if (hasToken()) sync(); else needSignIn(ls("lifeos.signedin") ? "Saved here, reconnect to sync" : "Not connected");
  }
  function flushToken(t) { var p = pendingToken; pendingToken = []; p.forEach(function (f) { f(t); }); }
  // Only call with interactive=true from a click; otherwise an expired token just fails.
  function getToken(interactive) {
    if (hasToken()) return Promise.resolve(token);
    if (!interactive || !tokenClient) return Promise.reject(new Error("auth"));
    return new Promise(function (res, rej) {
      pendingToken.push(function (t) { t ? res(t) : rej(new Error("auth")); });
      if (pendingToken.length === 1) tokenClient.requestAccessToken({ prompt: ls("lifeos.signedin") ? "" : "consent" });
    });
  }
  function api(method, url, body, type) {
    return getToken().then(function (t) {
      var h = { Authorization: "Bearer " + t }; if (type) h["Content-Type"] = type;
      return fetch(url, { method: method, headers: h, body: body });
    }).then(function (r) {
      if (r.status === 401) { token = null; tokenExp = 0; throw new Error("auth"); }
      if (!r.ok) throw new Error("drive " + r.status);
      return r;
    });
  }
  var DRIVE = "https://www.googleapis.com/drive/v3/files", UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
  function findFile() {
    var q = encodeURIComponent("name='" + CFG.driveFileName + "' and trashed=false");
    return api("GET", DRIVE + "?q=" + q + "&spaces=drive&orderBy=createdTime&fields=files(id)").then(function (r) { return r.json(); })
      .then(function (j) { return j.files && j.files[0] ? j.files[0].id : null; });
  }
  function createFile(d) {
    var b = "lifeos" + uid(), meta = { name: CFG.driveFileName, mimeType: "application/json" };
    var body = "--" + b + "\r\nContent-Type: application/json\r\n\r\n" + JSON.stringify(meta) + "\r\n--" + b +
      "\r\nContent-Type: application/json\r\n\r\n" + JSON.stringify(d, null, 2) + "\r\n--" + b + "--";
    return api("POST", UPLOAD + "?uploadType=multipart&fields=id", body, "multipart/related; boundary=" + b)
      .then(function (r) { return r.json(); }).then(function (j) { return j.id; });
  }
  function readFile(id) {
    return api("GET", DRIVE + "/" + id + "?alt=media").then(function (r) { return r.text(); })
      .then(function (t) { var d = t.trim() ? JSON.parse(t) : {}; return Object.assign(emptyData(), d); });
  }
  function writeFile(id, d) { return api("PATCH", UPLOAD + "/" + id + "?uploadType=media", JSON.stringify(d, null, 2), "application/json"); }

  /* Inbox: Claude adds or changes items by creating "lifeos-inbox-….json" files shaped like
     { "merge": { "todos": [items] }, "delete": { "todos": ["id"] } }. Items are matched by id
     (log entries by date). The app folds them into lifeos.json, then moves the inbox file to trash. */
  function readInbox() {
    var q = encodeURIComponent("name contains '" + INBOX + "' and trashed=false");
    return api("GET", DRIVE + "?q=" + q + "&spaces=drive&orderBy=createdTime&fields=files(id,name)").then(function (r) { return r.json(); })
      .then(function (j) {
        var files = (j.files || []).filter(function (f) { return f.name.indexOf(INBOX) === 0; });
        return Promise.all(files.map(function (f) {
          return api("GET", DRIVE + "/" + f.id + "?alt=media").then(function (r) { return r.json(); })
            .then(function (body) { return { id: f.id, body: body }; }, function () { return { id: f.id, body: null }; });
        }));
      });
  }
  function applyInbox(d, items) {
    items.forEach(function (it) {
      var b = it.body || {};
      Object.keys(b.merge || {}).forEach(function (list) {
        if (list === "categories") { apply(d, { t: "cats", cats: b.merge.categories }); return; }
        (b.merge[list] || []).forEach(function (item) {
          if (list === "log" && !item.id) item.id = item.date;
          if (!item.id) item.id = uid();
          apply(d, { t: "put", list: list, id: item.id, item: item });
        });
      });
      Object.keys(b.delete || {}).forEach(function (list) {
        (b.delete[list] || []).forEach(function (id) { apply(d, { t: "del", list: list, id: id }); });
      });
    });
    return d;
  }
  function trashFile(id) { return api("PATCH", DRIVE + "/" + id, JSON.stringify({ trashed: true }), "application/json"); }

  var saving = false, again = false, saveT = null;
  function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(sync, 700); }
  function sync() {
    if (!tokenClient) return;
    if (!hasToken()) return needSignIn(ls("lifeos.signedin") ? "Saved here, reconnect to sync" : "Not connected");
    if (saving) { again = true; return; }
    saving = true; setSync("Syncing…");
    var sent = ops.length;
    var p = fileId ? Promise.resolve(fileId) : findFile();
    p.then(function (id) {
      if (!id) return createFile(Object.assign(data, { updated: new Date().toISOString() })).then(function (nid) { fileId = nid; return data; });
      fileId = id;
      return Promise.all([readFile(id), readInbox()]).then(function (got) {
        var remote = got[0], inbox = got[1].filter(function (x) { return x.body; });
        if (!sent && !inbox.length) return remote;
        applyInbox(remote, inbox);
        ops.slice(0, sent).forEach(function (op) { apply(remote, op); });
        remote.updated = new Date().toISOString();
        return writeFile(id, remote)
          .then(function () { return Promise.all(inbox.map(function (x) { return trashFile(x.id); })); })
          .then(function () { return remote; });
      });
    }).then(function (fresh) {
      ops = ops.slice(sent);
      data = fresh; ops.forEach(function (op) { apply(data, op); });
      persist(); render();
      setSync(ops.length ? "Saving…" : "Synced " + new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
    }).catch(function (e) {
      if (e && e.message === "drive 404") { fileId = null; persist(); }
      if (e && e.message === "auth") needSignIn("Saved here, reconnect to sync");
      else setSync(navigator.onLine ? "Sync failed, will retry" : "Offline, saved here", true);
    }).then(function () {
      saving = false;
      if (again) { again = false; sync(); }
    });
  }

  /* ---------- quick add ---------- */
  var DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  function parseQuick(raw) {
    var s = " " + raw.trim() + " ", due = "", time = "", cat = "";
    // spending: "$12.50 Target #collecting"
    var m = /^\s*\$(\d+(?:\.\d{1,2})?)\s+(.+?)\s*$/.exec(s);
    if (m) return { kind: "spend", amount: Number(m[1]), rest: m[2] };
    m = /^\s*(?:n|note):\s*(.+?)\s*$/i.exec(s);
    if (m) return { kind: "note", text: m[1] };
    s = s.replace(/\s#([\w&-]+)/g, function (_, c) {
      var k = Object.keys(data.categories).find(function (x) { return x.toLowerCase().replace(/[^a-z]/g, "").indexOf(c.toLowerCase().replace(/[^a-z]/g, "")) === 0; });
      cat = k || c.charAt(0).toUpperCase() + c.slice(1); return " ";
    });
    s = s.replace(/\s(today|tod)\b/i, function () { due = today(); return " "; })
      .replace(/\s(tomorrow|tmrw|tmr)\b/i, function () { due = addDays(1); return " "; })
      .replace(/\sin (\d+) days?\b/i, function (_, n) { due = addDays(+n); return " "; })
      .replace(/\snext week\b/i, function () { due = addDays(7); return " "; })
      .replace(/\s(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i, function (_, d) {
        var diff = (DAYS.indexOf(d.toLowerCase()) - new Date().getDay() + 7) % 7 || 7; due = addDays(diff); return " ";
      })
      .replace(/\s(\d{1,2})\/(\d{1,2})\b/, function (_, mo, da) {
        var y = new Date().getFullYear(), c = y + "-" + pad(+mo) + "-" + pad(+da); due = c < today() ? (y + 1) + c.slice(4) : c; return " ";
      })
      .replace(/\s(?:at\s)?(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/i, function (_, h, mi, ap) {
        h = +h % 12 + (ap.toLowerCase() === "pm" ? 12 : 0); time = pad(h) + ":" + (mi || "00"); return " ";
      });
    if (time && !due) due = today();
    return { kind: "todo", text: s.replace(/\s+/g, " ").trim(), due: due, time: time, cat: cat };
  }
  $("qa").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = $("qa-input"), raw = input.value; if (!raw.trim()) return;
    var p = parseQuick(raw);
    if (p.kind === "spend") {
      var cm = /\s#([\w&-]+)/.exec(" " + p.rest), store = p.rest.replace(/\s*#[\w&-]+/g, "").trim();
      put("spending", { id: uid(), date: today(), amount: p.amount, store: store, category: cm ? cm[1] : "", kind: "", note: "", returnBy: "" });
      ui.tab = "money";
    } else if (p.kind === "note") {
      put("notes", { id: uid(), type: "note", text: p.text, added: today() }); ui.tab = "notes";
    } else {
      if (!p.text) return;
      if (p.cat && !data.categories[p.cat]) change({ t: "cats", cats: (function (o) { o[p.cat] = "#c9b8ff"; return o; })({}) });
      put("todos", { id: uid(), text: p.text, category: p.cat || ui.cat || "Personal", done: false, due: p.due, time: p.time, added: today() });
      ui.tab = "todo";
    }
    input.value = ""; ls(UI, ui); render();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $("qa-input").focus(); }
  });

  /* ---------- rendering ---------- */
  function dueChip(t) {
    if (!t.due) return "";
    var cls = t.due < today() && !t.done ? "late" : t.due === today() ? "now" : "";
    var label = t.due === today() ? "Today" : t.due === addDays(1) ? "Tomorrow" : short(t.due);
    if (t.time) { var h = +t.time.slice(0, 2), mi = t.time.slice(3); label += " " + ((h % 12) || 12) + (mi !== "00" ? ":" + mi : "") + (h < 12 ? "am" : "pm"); }
    return '<span class="due ' + cls + '"><i class="ti ti-clock" aria-hidden="true"></i> ' + esc(label) + "</span>";
  }
  function todoRow(t) {
    var c = catColor(t.category);
    return '<div class="row tick' + (t.done ? " done" : "") + '" tabindex="0" role="checkbox" aria-checked="' + !!t.done + '" data-list="todos" data-id="' + esc(t.id) + '" style="--c:' + esc(c) + '">' +
      '<i class="ti ' + (t.done ? "ti-circle-check" : "ti-circle") + ' ck" aria-hidden="true"></i>' +
      '<span class="t">' + esc(t.text) + "</span>" + dueChip(t) +
      '<span class="tag">' + esc(t.category) + "</span>" +
      '<button class="x" type="button" data-del aria-label="Delete">×</button></div>';
  }
  function section(title, n, rows, right) {
    return '<section class="sec"><div class="sh"><h2>' + esc(title) + '</h2><span class="n">' + (n || "") + "</span>" +
      (right ? '<span class="right">' + right + "</span>" : "") + "</div>" + (rows || '<p class="empty">Nothing here yet.</p>') + "</section>";
  }

  function renderTodo() {
    var all = data.todos.slice().sort(newestFirst);
    var cats = Object.keys(data.categories);
    var chips = '<div class="chips">' + ['<button class="chip" data-cat="" aria-pressed="' + !ui.cat + '">All</button>'].concat(cats.map(function (c) {
      return '<button class="chip" data-cat="' + esc(c) + '" aria-pressed="' + (ui.cat === c) + '" style="--c:' + esc(catColor(c)) + '">' + esc(c) + "</button>";
    })).join("") + "</div>";
    var list = ui.cat ? all.filter(function (t) { return t.category === ui.cat; }) : all;
    var t = today();
    var dueNow = list.filter(function (x) { return !x.done && x.due && x.due <= t; });
    var open = list.filter(function (x) { return !x.done && !(x.due && x.due <= t); });
    var done = list.filter(function (x) { return x.done; }).slice(0, 15);
    return chips +
      (dueNow.length ? section("Today", dueNow.length, dueNow.map(todoRow).join("")) : "") +
      section("To-do", open.length, open.map(todoRow).join("")) +
      (done.length ? section("Done", "", done.map(todoRow).join("")) : "");
  }

  function noteRow(n) {
    var icon = n.type === "quote" ? "ti-quote" : n.type === "idea" ? "ti-bulb" : "ti-note";
    var by = n.type === "quote" && (n.who || n.source) ? '<span class="s">' + esc([n.who, n.source].filter(Boolean).join(", ")) + "</span>" : "";
    return '<div class="row" data-list="notes" data-id="' + esc(n.id) + '" title="' + esc(n.text) + '"><i class="ti ' + icon + ' ck" style="color:var(--lav)" aria-hidden="true"></i>' +
      '<span class="t">' + esc(n.text) + by + '</span><span class="meta">' + esc(short(n.added)) + '</span><button class="x" type="button" data-del aria-label="Delete">×</button></div>';
  }
  function renderNotes() {
    var all = data.notes.slice().sort(newestFirst);
    var form = '<form class="add" data-form="note"><select name="type"><option value="note">Note</option><option value="idea">Idea</option><option value="quote">Quote</option></select>' +
      '<input class="grow" name="text" placeholder="Write a note" required><input name="who" placeholder="Who (quotes)"><button class="btn" type="submit">Add</button></form>';
    return form + section("Notes", all.length, all.map(noteRow).join(""));
  }

  function spendRow(s) {
    var c = s.kind === "impulse" ? "var(--late)" : s.kind === "needed" ? "#b8f0d8" : "var(--muted)";
    return '<div class="row" data-list="spending" data-id="' + esc(s.id) + '" title="' + esc(s.note || "") + '"><span class="amt">' + money(s.amount) + "</span>" +
      '<span class="t">' + esc(s.store) + (s.note ? '<span class="s">' + esc(s.note) + "</span>" : "") + "</span>" +
      '<span class="tag" style="--c:' + c + '">' + esc(s.kind || "untagged") + '</span><span class="meta">' + esc(s.category || "") + '</span><span class="meta">' + esc(short(s.date)) + "</span>" +
      '<button class="x" type="button" data-del aria-label="Delete">×</button></div>';
  }
  function wishRow(w) {
    return '<div class="row" data-list="wishlist" data-id="' + esc(w.id) + '"><span class="amt">' + (w.price != null ? money(w.price) : "") + '</span><span class="t">' + esc(w.item) + "</span>" +
      '<span class="meta">' + esc(short(w.added)) + '</span><button class="x" type="button" data-del aria-label="Delete">×</button></div>';
  }
  function renderMoney() {
    var all = data.spending.slice().sort(newestFirst), month = today().slice(0, 7);
    var inMonth = all.filter(function (s) { return String(s.date).indexOf(month) === 0; });
    var total = inMonth.reduce(function (a, s) { return a + (Number(s.amount) || 0); }, 0);
    var imp = inMonth.filter(function (s) { return s.kind === "impulse"; }).reduce(function (a, s) { return a + (Number(s.amount) || 0); }, 0);
    var form = '<form class="add" data-form="spend"><input class="w" name="amount" inputmode="decimal" placeholder="$0.00" required><input class="grow" name="store" placeholder="Store" required>' +
      '<input name="category" placeholder="Category"><select name="kind"><option value="needed">Needed</option><option value="impulse">Impulse</option></select><button class="btn" type="submit">Log</button></form>';
    var wish = data.wishlist.slice().sort(newestFirst);
    return form +
      section("Spending", all.length, all.map(spendRow).join(""), "This month " + money(total) + " · impulse " + money(imp)) +
      section("Wishlist", wish.length, wish.map(wishRow).join(""));
  }

  function renderLog() {
    var all = data.log.slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    var rows = all.map(function (l) {
      return '<div class="row" data-list="log" data-id="' + esc(l.date) + '" title="' + esc(l.highlight || "") + '"><span class="meta">' + esc(short(l.date)) + "</span>" +
        '<span class="meta"><i class="ti ti-mood-smile" aria-hidden="true"></i> ' + esc(l.mood != null ? l.mood : "–") + '</span><span class="meta"><i class="ti ti-bolt" aria-hidden="true"></i> ' + esc(l.energy != null ? l.energy : "–") + "</span>" +
        '<span class="t">' + esc(l.highlight || l.feeling || "") + "</span></div>";
    }).join("");
    return section("Daily log", all.length, rows, "Add entries with /log in Claude");
  }

  function render() {
    var t = ui.tab;
    [].forEach.call($("tabs").children, function (b) { b.setAttribute("aria-selected", b.dataset.tab === t ? "true" : "false"); });
    $("n-todo").textContent = data.todos.filter(function (x) { return !x.done; }).length || "";
    $("n-notes").textContent = data.notes.length || "";
    $("n-money").textContent = "";
    $("n-log").textContent = "";
    $("panel").innerHTML = t === "notes" ? renderNotes() : t === "money" ? renderMoney() : t === "log" ? renderLog() : renderTodo();
  }

  /* ---------- events ---------- */
  $("tabs").addEventListener("click", function (e) { var b = e.target.closest("button[data-tab]"); if (!b) return; ui.tab = b.dataset.tab; ls(UI, ui); render(); });
  function toggle(r) {
    var t = data.todos.find(function (x) { return x.id === r.dataset.id; }); if (!t) return;
    put("todos", { id: t.id, done: !t.done, doneAt: !t.done ? new Date().toISOString() : "" });
  }
  $("panel").addEventListener("click", function (e) {
    var chip = e.target.closest(".chip"); if (chip) { ui.cat = chip.dataset.cat; ls(UI, ui); render(); return; }
    var r = e.target.closest(".row"); if (!r) return;
    if (e.target.closest("[data-del]")) { del(r.dataset.list, r.dataset.id); return; }
    if (r.classList.contains("tick")) toggle(r);
  });
  $("panel").addEventListener("keydown", function (e) {
    var r = e.target.closest(".row.tick"); if (!r || e.target !== r) return;
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(r); }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); del("todos", r.dataset.id); }
  });
  $("panel").addEventListener("submit", function (e) {
    e.preventDefault(); var f = e.target, v = function (n) { return (f.elements[n] && f.elements[n].value || "").trim(); };
    if (f.dataset.form === "note") put("notes", { id: uid(), type: v("type"), text: v("text"), who: v("who"), source: "", added: today() });
    if (f.dataset.form === "spend") {
      var amt = parseFloat(v("amount").replace(/[$,]/g, "")); if (!(amt > 0)) return;
      put("spending", { id: uid(), date: today(), amount: Math.round(amt * 100) / 100, store: v("store"), category: v("category"), kind: v("kind"), note: "", returnBy: "" });
    }
  });
  $("signin").addEventListener("click", function () { getToken(true).then(sync).catch(function () { setSync("Sign-in cancelled", true); }); });
  window.addEventListener("focus", function () { if (hasToken()) sync(); });
  window.addEventListener("online", sync);

  $("today").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  render();
  initGoogle();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");
})();
