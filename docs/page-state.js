// page-state.js -- shared by every page: remembers which league you picked
// (so switching pages doesn't drop you back on the first league), and keeps
// the page's league/year/week in the address bar so a link opens the same view.
//
//   PageState.pickLeague(selectEl, leagues)  after filling the league <select>
//       leagues: [{ id, slug }]. Chooses ?league= (slug or id) if present,
//       else the last league used on this device. Saves future changes.
//   PageState.param('week')                   read a ?param (string or null)
//   PageState.set({ league, year, week })     update the address bar in place
//       (no reload, no history entry). null/undefined removes a param.
//   PageState.pick(selectEl, value)           select value if it's an option
(function () {
  'use strict';
  var KEY = 'winProbLeague';
  var slugById = {};

  function param(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  }

  function set(values) {
    try {
      var p = new URLSearchParams(location.search);
      Object.keys(values).forEach(function (k) {
        var v = values[k];
        if (k === 'league' && v != null && slugById[v]) v = slugById[v];
        if (v == null || v === '') p.delete(k); else p.set(k, String(v));
      });
      var qs = p.toString();
      history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (e) { /* old browser / sandboxed: the page still works, just no link state */ }
  }

  function pick(sel, value) {
    if (!sel || value == null) return false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === String(value)) { sel.selectedIndex = i; return true; }
    }
    return false;
  }

  function pickLeague(sel, leagues) {
    if (!sel) return;
    (leagues || []).forEach(function (l) { if (l && l.slug) slugById[String(l.id)] = l.slug; });
    var want = param('league'), chosen = false;
    if (want) {
      var hit = (leagues || []).filter(function (l) { return l.slug === want || String(l.id) === want; })[0];
      if (hit) chosen = pick(sel, hit.id);
    }
    if (!chosen) {
      var saved = null; try { saved = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
      pick(sel, saved);
    }
    try { if (sel.value) localStorage.setItem(KEY, sel.value); } catch (e) { /* ignore */ }
    if (sel.value) set({ league: sel.value });
    if (!sel.dataset.psBound) {
      sel.dataset.psBound = '1';
      sel.addEventListener('change', function () {
        try { localStorage.setItem(KEY, sel.value); } catch (e) { /* ignore */ }
        set({ league: sel.value });
      });
    }
  }

  // A readable error card with a Retry button, in place of a one-line message.
  //   PageState.errorBox(el, 'Could not load standings', err, () => load())
  // retry is optional; without it the button reloads the page.
  var STYLE = '.ps-error{max-width:520px;margin:18px auto;padding:16px 18px;border-radius:12px;border:1px solid var(--warn-border,#e8b48a);' +
    'background:var(--warn-bg,#fff4ea);color:var(--fg,inherit);text-align:center;font-size:14px;line-height:1.45}' +
    '.ps-error b{display:block;font-size:15px;margin-bottom:4px}.ps-error small{display:block;color:var(--muted,#777);margin-top:4px;word-break:break-word}' +
    '.ps-error button{margin-top:12px;font:inherit;font-weight:600;padding:7px 18px;border-radius:999px;cursor:pointer;' +
    'border:1px solid var(--border,#ccc);background:var(--card-bg,#fff);color:var(--accent,#1a3fa0)}';
  function errorBox(el, title, err, retry) {
    if (!el) return;
    if (!document.getElementById('psErrorStyle')) {
      var st = document.createElement('style'); st.id = 'psErrorStyle'; st.textContent = STYLE; document.head.appendChild(st);
    }
    if (err) console.error(title, err);
    var detail = err ? String((err && err.message) || err) : '';
    var offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    el.innerHTML = '';
    var box = document.createElement('div'); box.className = 'ps-error'; box.setAttribute('role', 'alert');
    var b = document.createElement('b'); b.textContent = title; box.appendChild(b);
    var p = document.createElement('div');
    p.textContent = offline ? 'You appear to be offline. Reconnect and try again.' : 'This is usually temporary — try again in a moment.';
    box.appendChild(p);
    if (detail && !offline) { var sm = document.createElement('small'); sm.textContent = detail; box.appendChild(sm); }
    var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Retry';
    btn.addEventListener('click', function () { if (retry) { el.textContent = 'Retrying…'; retry(); } else location.reload(); });
    box.appendChild(btn);
    el.appendChild(box);
    el.style.display = '';
    el.hidden = false;
  }

  window.PageState = { param: param, set: set, pick: pick, pickLeague: pickLeague, errorBox: errorBox };

  // The data library comes from a CDN. If it didn't load, every page script
  // would die on its first line and leave a blank page -- explain instead.
  if (window.SUPABASE_CONFIG && !window.supabase) {
    var host = document.getElementById('status') || document.getElementById('loadingState') || document.body;
    errorBox(host, 'Couldn’t load the data library', 'The Supabase script (cdn.jsdelivr.net) didn’t load.');
  }
})();
