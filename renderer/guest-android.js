/* The guest surface on Android.

   Electron gives the player page as a <webview> the renderer can talk to. An
   Android WebView cannot nest another one in its own document, so the shell puts
   a second WebView on top of the first and this file makes it answer to the same
   handful of calls: src, insertCSS, executeJavaScript, and the four events the
   watchdog listens for.

   The <webview> element still gets created — an unknown tag in a browser is a
   perfectly ordinary element — so everything that looks the player up by
   selector, sizes it with CSS or removes it keeps working untouched. What this
   adds is the reporting of where that element ended up on screen, since the real
   WebView is a native view and has to be moved there by hand. */

(function () {
  const native = window.WiSNative;
  if (!native) return;

  const waiting = new Map();
  let ticket = 0;

  // The bridge answers evaluate calls the same way it answers requests.
  const reply = window.__wisReply;
  window.__wisReply = (id, json) => {
    const pending = waiting.get(id);
    if (!pending) return reply && reply(id, json);
    waiting.delete(id);
    try {
      const answer = JSON.parse(json);
      if (answer.error) pending.reject(new Error(answer.error));
      else pending.resolve(answer.value);
    } catch (err) {
      pending.reject(err);
    }
  };

  const ask = (send) =>
    new Promise((resolve, reject) => {
      const id = ++ticket + 1000000; // clear of the transport's tickets
      waiting.set(id, { resolve, reject });
      try {
        send(id);
      } catch (err) {
        waiting.delete(id);
        reject(err);
      }
    });

  let live = null; // the element the native WebView is currently standing behind

  window.__wisGuestEvent = (name, json) => {
    if (!live) return;
    let detail = {};
    try {
      detail = JSON.parse(json || '{}');
    } catch {
      /* an event with nothing to say is still an event */
    }
    const event = new Event(name);
    Object.assign(event, detail);
    live.dispatchEvent(event);
  };

  /* The element is laid out by the page's own CSS; the native view has to be
     told where that landed. Following it means watching for the obvious moves —
     resize, fullscreen — and, because neither fires when a panel above it grows,
     a cheap poll that only sends when the numbers actually change. */
  function follow(el) {
    let last = '';
    const push = () => {
      if (!el.isConnected) return;
      const box = el.getBoundingClientRect();
      const key = [box.left, box.top, box.width, box.height].map(Math.round).join(',');
      if (key === last) return;
      last = key;
      native.playerRect(box.left, box.top, box.width, box.height);
    };

    const timer = setInterval(push, 250);
    const observer = new ResizeObserver(push);
    observer.observe(el);
    window.addEventListener('resize', push);
    push();

    return () => {
      clearInterval(timer);
      observer.disconnect();
      window.removeEventListener('resize', push);
    };
  }

  window.WiSGuest = {
    attach(el) {
      let unfollow = null;

      const setAttribute = el.setAttribute.bind(el);
      el.setAttribute = (name, value) => {
        setAttribute(name, value);
        // Everything else — partition, allowpopups — is the shell's own doing.
        if (name === 'src' && value) {
          live = el;
          unfollow = unfollow || follow(el);
          native.playerMount(String(value));
        }
      };

      // An unknown tag has no src of its own; a real <webview>, if this ever
      // runs next to one, already has a better one than we could give it.
      try {
        Object.defineProperty(el, 'src', {
          get: () => el.getAttribute('src') || '',
          configurable: true,
        });
      } catch {
        /* the element defines it itself */
      }

      el.executeJavaScript = (code) => ask((id) => native.playerEval(id, String(code)));
      el.insertCSS = (css) =>
        new Promise((resolve) => {
          native.playerCss(String(css));
          resolve(true);
        });

      const remove = el.remove.bind(el);
      el.remove = () => {
        if (unfollow) unfollow();
        if (live === el) live = null;
        native.playerDrop();
        remove();
      };

      return el;
    },

    /* The chooser for a subtitle file, opened by the shell rather than by the page.
       That is what puts it in Files instead of in the photo library — a picker
       built from an accept list lands on photos and video, and cannot offer a .srt
       at all, since the system has no type for one. */
    pickSubtitle() {
      try {
        if (native.pickSubtitle) native.pickSubtitle();
      } catch {
        /* an older shell offers no chooser */
      }
    },

    /* Belt and braces on the way out of a film. Normally the element's own remove()
       tells the shell to take the picture down, but if that bookkeeping ever slips
       the picture stays over everything and the film cannot be left. Saying it
       twice costs nothing: the shell's own drop is harmless when there is nothing
       to drop. */
    drop() {
      try {
        native.playerDrop();
      } catch {
        /* nothing mounted */
      }
    },

    /* Full screen on a handset means sideways, and no system bars. Neither is
       something a page can decide for itself, so the shell is asked. */
    fullscreen(on) {
      try {
        if (native.fullscreen) native.fullscreen(!!on);
      } catch {
        /* an older shell stays as it is */
      }
    },

    // The notice lives inside the stage, which on Android is covered by a native
    // view, so it is drawn by the shell instead. The buttons call back by index.
    notice(text, labels) {
      try {
        native.notice(JSON.stringify({ text: text || '', actions: labels || [] }));
      } catch {
        /* an older shell simply shows nothing */
      }
    },
  };
})();
