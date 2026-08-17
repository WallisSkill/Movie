/* Driving the app with a remote.

   A phone has a finger and a desktop has a pointer; an Android TV has four
   arrows, an OK and a Back, and nothing else. That means two things the mouse
   build never needed: everything you can act on has to be reachable by focus,
   and pressing an arrow has to move focus the way a person would expect on
   screen — to the nearest thing in that direction, not to the next one in
   document order.

   Loaded everywhere, awake only when the shell says a remote is in play. */

(function () {
  if (!window.WiSNative) return;

  const ACTIONABLE = '.card, .ep-btn, button, input, select, [tabindex]';
  const SEEK_STEP = 10;

  const visible = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight;
  };

  const reachable = () => [...document.querySelectorAll(ACTIONABLE)].filter((el) => !el.disabled && visible(el));

  // Anything a finger could tap should also stop under the focus ring, and cards
  // are ordinary divs.
  function makeFocusable() {
    document.querySelectorAll('.card:not([tabindex])').forEach((card) => {
      card.setAttribute('tabindex', '0');
    });
  }

  /* The nearest thing in a direction, not the next in document order: score by
     how far along the axis of travel it sits, with drift across that axis
     counting several times over so a card one row down beats one far to the
     side. */
  function step(from, dir) {
    const origin = from ? from.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const ox = origin.left + origin.width / 2;
    const oy = origin.top + origin.height / 2;

    let best = null;
    let bestScore = Infinity;

    for (const el of reachable()) {
      if (el === from) continue;
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const dx = x - ox;
      const dy = y - oy;

      const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      if (along <= 1) continue; // behind us, or level with us
      const drift = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);

      const score = along + drift * 3;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best;
  }

  function move(dir) {
    const from = document.activeElement === document.body ? null : document.activeElement;
    const next = step(from, dir);
    if (!next) return false;
    next.focus();
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  /* In the player the arrows belong to the film, not to the layout: left and
     right are the only way to scrub with a remote. */
  function playerKey(key) {
    const view = document.querySelector('#player-stage webview');
    if (!view || !view.executeJavaScript) return false;

    const jump = key === 'ArrowLeft' ? -SEEK_STEP : key === 'ArrowRight' ? SEEK_STEP : 0;
    const code = jump
      ? `(() => { const v = document.querySelector('video'); if (!v) return false; v.currentTime = Math.max(0, v.currentTime + ${jump}); return true; })()`
      : `(() => { const v = document.querySelector('video'); if (!v) return false; v.paused ? v.play() : v.pause(); return true; })()`;

    view.executeJavaScript(code).catch(() => {});
    return true;
  }

  const inPlayer = () => {
    const player = document.querySelector('#player');
    return player && !player.classList.contains('hidden');
  };

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;

    const key = event.key;
    const typing = /^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '');

    if (key === 'Enter' && !typing && document.activeElement && document.activeElement.click) {
      // A card is a div: Enter does nothing for it unless we say so.
      if (document.activeElement.matches('.card')) {
        event.preventDefault();
        return document.activeElement.click();
      }
      return;
    }

    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[key];
    if (!dir) return;

    // Immersive playback is the one place the arrows are not navigation.
    if (inPlayer() && document.querySelector('#player').classList.contains('immersive')) {
      if (playerKey(key)) event.preventDefault();
      return;
    }

    if (typing && (dir === 'left' || dir === 'right')) return; // caret movement
    if (move(dir)) event.preventDefault();
  });

  // Fresh cards arrive with every page of results.
  new MutationObserver(makeFocusable).observe(document.body, { childList: true, subtree: true });
  makeFocusable();

  // The remote's Back key: out of fullscreen, out of the player, then back
  // through the views the way the on-screen arrow does.
  window.__wisBack = () => {
    const player = document.querySelector('#player');
    if (player && !player.classList.contains('hidden')) {
      if (player.classList.contains('immersive')) {
        document.querySelector('#player-full').click();
        return true;
      }
      document.querySelector('#player-close').click();
      return true;
    }
    const back = document.querySelector('#btn-back');
    if (back && !back.disabled) {
      back.click();
      return true;
    }
    return false; // nothing left to back out of: the shell may close the app
  };
})();
