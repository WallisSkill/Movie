/* The same window.api the preload puts up on desktop, built instead on the
   Android shell's bridge.

   The renderer never learns which one it got: both answer { ok, data } to the
   same call names. Everything below no-ops when the bridge is absent, so this
   file is harmless in Electron — there window.api already exists by the time it
   runs. */

(function () {
  const native = window.WiSNative;
  if (window.api || !native) return;

  /* ------------------------------------------------------------- transport */

  /* @JavascriptInterface calls cannot return a promise, so a request carries a
     ticket: the shell answers by calling back into window.__wisReply with it. */

  const waiting = new Map();
  let ticket = 0;

  window.__wisReply = (id, json) => {
    const pending = waiting.get(id);
    if (!pending) return;
    waiting.delete(id);
    try {
      const answer = JSON.parse(json);
      if (answer.error) pending.reject(new Error(answer.error));
      else pending.resolve(answer);
    } catch (err) {
      pending.reject(err);
    }
  };

  function fetchText(url, opts) {
    const { headers, timeout, range } = opts || {};
    const id = ++ticket;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      // A request the shell never answers must not hold a card forever.
      setTimeout(() => {
        if (!waiting.has(id)) return;
        waiting.delete(id);
        reject(new Error('Het thoi gian cho mang'));
      }, (timeout || 25000) + 2000);

      try {
        native.fetchText(
          id,
          url,
          JSON.stringify({ ...(headers || {}), ...(range ? { range } : {}) }),
          timeout || 25000
        );
      } catch (err) {
        waiting.delete(id);
        reject(err);
      }
    });
  }

  /* ----------------------------------------------------------------- store */

  /* Kept by the shell, not by the web view.

     Favourites, history, where a film was left off and every subtitle added are
     the app's own data, and a web view is the wrong place for it: on iOS the
     interface is served over a scheme of its own, and storage belonging to a
     scheme like that is not persisted at all — everything was lost the moment the
     app closed. The shell writes it where an app's data belongs, hands it back at
     startup as window.__wisStore, and takes each change as it happens.

     localStorage stays as the fallback for a shell too old to have been asked. */
  const STORE_KEY = 'wisfilm-store';
  let held = null;

  const readStore = async () => {
    if (held) return held;

    if (window.__wisStore && typeof window.__wisStore === 'object') {
      held = window.__wisStore;
      return held;
    }

    if (native.storeRead) {
      try {
        held = JSON.parse(native.storeRead() || '{}');
        return held;
      } catch {
        /* unreadable: start clean rather than refuse to start */
      }
    }

    try {
      held = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch {
      held = {};
    }
    return held;
  };

  const writeStore = async (data) => {
    held = data;
    const json = JSON.stringify(data);

    if (native.storeWrite) {
      try {
        native.storeWrite(json);
        return true;
      } catch {
        /* fall through to the web view's own storage */
      }
    }

    try {
      localStorage.setItem(STORE_KEY, json);
      return true;
    } catch {
      return false;
    }
  };

  /* ------------------------------------------------------------- the shape */

  const catalog = window.WiSCatalog.createCatalog({
    fetchText,
    // 22 MB of cast rows through a JS bridge would cost more than the portraits
    // are worth on a phone, so names come back without them.
    actors: false,
    cache: {
      read(name) {
        try {
          return JSON.parse(localStorage.getItem('wisfilm-cache-' + name));
        } catch {
          return null;
        }
      },
      write(name, value) {
        try {
          localStorage.setItem('wisfilm-cache-' + name, JSON.stringify(value));
        } catch {
          /* storage full: the cache is an optimisation, not the app */
        }
      },
    },
  });

  const wrap = (fn) => async (payload) => {
    try {
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  };

  const api = { readStore, writeStore };
  [
    'list',
    'genre',
    'country',
    'search',
    'genres',
    'countries',
    'detail',
    'format',
    'hh3d',
    'hh3dSearch',
    'hh3dDetail',
    'hh3dUpdated',
    'cast',
  ].forEach((name) => {
    api[name] = wrap((payload) => catalog[name](payload));
  });

  window.api = api;
  window.WiSPlatform = 'android';
  /* The stylesheet needs to know it is inside a shell: the player there is a view
     of its own laid over this page, so anything the page floats on top of the
     picture — the bar with the way out of a film, for one — would be underneath
     it and impossible to press. */
  document.documentElement.classList.add('shell');
  catalog.warmUp();

  /* The shell trims the watch page's own weight while a film plays, which means
     it has to know which host that page is on — and HH3D moves. Only the
     catalogue ever learns the answer, so it passes it down as soon as it has it
     and again now and then, since the address is re-read every few hours. */
  const tellHost = () => {
    try {
      const origin = catalog.hostNow();
      if (origin && native.hh3dHost) native.hh3dHost(origin);
    } catch {
      /* an older shell does without */
    }
  };

  setTimeout(tellHost, 2000);
  setInterval(tellHost, 60000);
})();
