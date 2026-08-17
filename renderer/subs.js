/* Subtitles WiSFilm supplies, drawn where the player draws its own.

   The embedded player has the files, parses them, and then puts captions back to
   "Off" about eighty milliseconds after anything turns them on — its own
   remembered preference wins every argument, and it is not our page to fix.

   So the text is taken away from it, but not out of the picture: the cues are
   parsed here and handed to the watch page, where a small script keeps them in
   the player's own frame, timed off the video's own clock. That is what makes
   them survive fullscreen — whichever fullscreen the viewer reaches for, ours or
   the site's, the line is inside the thing being blown up rather than layered
   over it. */

(function () {
  const state = {
    view: null,
    film: null, // which film the imported files belong to
    tracks: [], // { id, label, lang, url?, cues? }
    seq: 0, // ids stay unique as tracks turn up mid-film
    prefer: null, // the language the viewer last watched in
    pos: 8, // how far up the frame the line sits, in percent
    active: null,
    offset: 0,
  };

  /* ------------------------------------------------------------- parsing */

  const TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})|(\d{1,2}):(\d{2})[.,](\d{1,3})/;

  function seconds(stamp) {
    const m = String(stamp || '').trim().match(TIME_RE);
    if (!m) return null;
    if (m[1] !== undefined) {
      return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
    }
    return Number(m[5]) * 60 + Number(m[6]) + Number(m[7].padEnd(3, '0')) / 1000;
  }

  // What a track is called, compared loosely so the same subtitle under a renewed
  // address is recognised as itself.
  const nameOf = (track) =>
    String((track && (track.label || track.lang)) || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

  // Anything that is not the line itself: the position hints VTT allows, the
  // styling tags both formats allow, and the override blocks ASS leaves behind.
  const clean = (text) =>
    text
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\r/g, '')
      .trim();

  /* SRT and VTT differ in the header, the decimal comma and the numbering, none
     of which matters once the blocks are split apart. */
  function parseCues(raw) {
    const text = String(raw || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    const cues = [];

    for (const block of text.split(/\n\s*\n/)) {
      const lines = block.split('\n').filter((line) => line.trim() !== '');
      const timing = lines.findIndex((line) => line.includes('-->'));
      if (timing === -1) continue;

      const [from, to] = lines[timing].split('-->');
      const start = seconds(from);
      const end = seconds(to);
      const body = clean(lines.slice(timing + 1).join('\n'));
      if (start === null || end === null || !body) continue;

      cues.push({ s: start, e: end, t: body });
    }

    cues.sort((a, b) => a.s - b.s);
    return cues;
  }

  /* -------------------------------------------------- the guest's own frame */

  /* Mounted inside the player's element, so it inherits the size the player has
     — including when the player is the only thing on the screen. The player
     rebuilds parts of its own DOM as it goes, so the box checks now and then
     that it is still where it was put. */
  const GUEST_RENDER = `(() => {
    if (window.__wisSubsReady) return 'already';
    window.__wisSubsReady = true;
    window.__wisSubs = { cues: [], offset: 0 };

    const box = document.createElement('div');
    box.id = 'wis-sub';
    box.style.cssText = [
      // Where the page's own line used to sit; the viewer can move it from here.
      'position:absolute', 'left:50%', 'bottom:8%', 'transform:translateX(-50%)',
      'max-width:88%', 'z-index:2147483600', 'pointer-events:none',
      'text-align:center', 'white-space:pre-line', 'font-weight:650',
      'font-size:clamp(15px,2.4vw,34px)', 'line-height:1.32', 'color:#fff',
      'text-shadow:0 0 4px #000,0 2px 6px rgba(0,0,0,.95),0 -1px 3px rgba(0,0,0,.85)',
      'display:none',
    ].join(';');

    const stage = () =>
      document.querySelector('.jwplayer') ||
      document.querySelector('#halim-player-wrapper') ||
      (document.querySelector('video') && document.querySelector('video').parentElement) ||
      document.body;

    const mount = () => {
      const host = stage();
      if (host && box.parentElement !== host) {
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(box);
      }
    };

    const at = (time) => {
      const cues = window.__wisSubs.cues;
      for (let i = 0; i < cues.length; i++) {
        if (time < cues[i].s) break;
        if (time <= cues[i].e) return cues[i].t;
      }
      return '';
    };

    const paint = () => {
      const video = document.querySelector('video');
      if (!video) return;
      const text = window.__wisSubs.cues.length ? at(video.currentTime + window.__wisSubs.offset) : '';
      if (text === box.__wisLast) return;
      box.__wisLast = text;
      box.textContent = text;
      box.style.display = text ? 'block' : 'none';
    };

    /* Two renderers, one line, twice on screen. This site draws captions itself
       — a .bc-dual-cue of its own, which is why its player carries the class
       bc-dual-hide-jw — and it does that regardless of what jwplayer's caption
       api says. So while WiSFilm is drawing, that copy is hidden by a rule, not
       by chasing elements it keeps rebuilding, and jwplayer's own captions are
       held shut as well. Turn ours off and the page gets its captions back. */
    const QUIET = '.bc-dual-cue, .bc-dual-cues, .bc-dual-caption, .jw-captions' +
      ' { visibility: hidden !important; }';

    const hush = () => {
      const drawing = window.__wisSubs.cues.length > 0;
      let rule = document.getElementById('wis-quiet');

      if (drawing && !rule) {
        rule = document.createElement('style');
        rule.id = 'wis-quiet';
        rule.textContent = QUIET;
        (document.head || document.documentElement).appendChild(rule);
      } else if (!drawing && rule) {
        rule.remove();
      }

      /* Nothing else is touched. Turning the page's captions off through its own
         api, or disabling the video's tracks, cannot be undone from here — and
         the page would then have no captions left after ours are switched off. A
         rule that hides and unhides is the whole of it. */
    };

    window.__wisHush = hush;
    mount();
    hush();
    setInterval(mount, 2000);
    setInterval(hush, 500);
    setInterval(paint, 120);
    return 'ready';
  })()`;

  const push = (cues) => {
    if (!state.view) return Promise.resolve(0);
    return state.view
      .executeJavaScript(
        `(() => {
          if (!window.__wisSubs) return -1;
          window.__wisSubs.cues = ${JSON.stringify(cues || [])};
          window.__wisSubs.offset = ${state.offset};
          const box = document.getElementById('wis-sub');
          if (box) { box.__wisLast = null; }
          // Taking a track over means the page's own copy goes now, not half a
          // second later.
          if (window.__wisHush) window.__wisHush();
          return window.__wisSubs.cues.length;
        })()`
      )
      .catch(() => 0);
  };

  /* -------------------------------------------------------------- tracks */

  /* What the player was handed. jwplayer keeps the sideloaded list in its own
     config; the HH3D player has none, and that is a fine answer too — a file off
     the disk is the whole list there. */
  async function discover(view) {
    try {
      const found = await view.executeJavaScript(`(() => {
        const out = [];
        const add = (url, label, lang) => {
          if (!url || out.some((t) => t.url === url)) return;
          out.push({ url, label: label || lang || 'Phụ đề', lang: lang || '' });
        };

        try {
          const item = jwplayer().getConfig().playlist[0];
          (item.tracks || [])
            .filter((t) => t.file && (t.kind || 'captions') === 'captions')
            .forEach((t) => add(t.file, t.label, t.srclang));
        } catch { /* not a jwplayer page */ }

        /* A file added through the player's own "add subtitle" button never
           reaches that config — it turns up in the caption list as an address of
           its own, often a blob. Reading both is what lets a file imported the
           way the viewer is used to still be drawn. */
        try {
          (jwplayer().getCaptionsList() || []).forEach((c) => {
            if (typeof c.id === 'string' && /^(https?:|blob:|data:)/.test(c.id)) add(c.id, c.label, '');
          });
        } catch { /* no list to read */ }

        return out;
      })()`);
      return Array.isArray(found) ? found : [];
    } catch {
      return [];
    }
  }

  // The file sits on the guest's own origin, so the guest is the one that can
  // read it without a cross-origin argument.
  async function fetchCues(view, url) {
    const text = await view.executeJavaScript(
      `(async () => {
        try {
          const res = await fetch(${JSON.stringify(url)});
          return res.ok ? await res.text() : '';
        } catch { return ''; }
      })()`
    );
    return parseCues(text);
  }

  async function activate(id) {
    state.active = id || 'off';

    if (!id || id === 'off') {
      await push([]);
      return { ok: true, cues: 0 };
    }

    const track = state.tracks.find((t) => t.id === id);
    if (!track) return { ok: false, cues: 0 };

    if (!track.cues) {
      if (!track.url || !state.view) return { ok: false, cues: 0 };
      track.cues = await fetchCues(state.view, track.url);
    }

    await push(track.cues);
    return { ok: track.cues.length > 0, cues: track.cues.length };
  }

  /* ----------------------------------------------------------------- api */

  window.WiSSubs = {
    /* A fresh mount: the guest is new, so the box has to be put back and the
       list read again, but the choice and the nudge stay where they were — for
       as long as it is the same film. A subtitle file picked off the disk belongs
       to the film it was picked for, and carrying it into the next one would show
       a stranger's lines. */
    async attach(view, prefer, filmKey, position) {
      state.view = view;
      state.prefer = prefer || state.prefer;
      if (Number.isFinite(position)) state.pos = position;

      const sameFilm = filmKey && filmKey === state.film;
      state.film = filmKey || state.film;
      if (!sameFilm) {
        state.tracks = state.tracks.filter((t) => !t.id.startsWith('file:'));
        if (String(state.active || '').startsWith('file:')) state.active = null;
        state.offset = 0;
      }

      await view.executeJavaScript(GUEST_RENDER).catch(() => {});
      // A fresh guest draws at the default height until told where the viewer put it.
      this.move(0);

      const imported = state.tracks.filter((t) => t.id.startsWith('file:'));
      const found = await discover(view);
      state.seq = 0;
        state.tracks = found.map((t) => ({ id: 'url:' + state.seq++, ...t }));
      state.tracks.push(...imported);

      /* Nothing is taken over on the way in. The page's own captions are what a
         viewer expects to see, and they work; the only thing it cannot show is a
         file added later, which is what refresh() is for. A file already chosen
         for this same film keeps playing across a reconnect. */
      const carried = state.tracks.find((t) => t.id === state.active);
      return carried ? activate(carried.id) : activate('off');
    },

    detach() {
      state.view = null;
    },

    /* A subtitle added through the player's own button appears in its list at
       any moment, long after the film was opened. Reading the list only once
       meant that file never showed up and the old track kept being drawn — so
       the list is read again whenever it is about to be shown, and anything new
       is reported back, since a file just added is a file meant to be watched. */
    async refresh() {
      if (!state.view) return { added: [] };
      const found = await discover(state.view);

      /* By address: an address not seen before is a subtitle not seen before,
         which is what makes a file the viewer just attached get picked up. Names
         were tried instead and that was wrong — a file sharing its name with a
         track already listed was taken for that track and never shown.

         The player does renew those addresses as it goes, though, and re-adopting
         the very subtitle already on screen every few seconds is pointless. So
         one case is quietly absorbed: a new address for the track being drawn
         right now just replaces the old one. */
      const drawn = state.tracks.find((t) => t.id === state.active);
      const added = [];

      found.forEach((track) => {
        if (state.tracks.some((t) => t.url === track.url)) return;

        if (drawn && nameOf(drawn) === nameOf(track)) {
          drawn.url = track.url;
          return;
        }

        const id = 'url:' + state.seq++;
        state.tracks.push({ id, ...track });
        added.push(id);
      });

      return { added };
    },

    list: () => state.tracks.map((t) => ({ id: t.id, label: t.label, lang: t.lang || '', loaded: !!t.cues })),
    active: () => state.active,
    offset: () => state.offset,
    pick: (id) => activate(id),

    /* How high the line sits, in percent of the frame. A print with burnt-in
       subtitles, or a player whose controls sit where the text lands, is a reason
       to move it rather than to put up with it. */
    position: () => state.pos,

    move(by) {
      // A stored value that never made it through is not a reason to slam the
      // line to the floor.
      const from = Number.isFinite(state.pos) ? state.pos : 8;
      state.pos = Math.min(45, Math.max(0, Math.round((from + by) * 10) / 10));
      if (state.view) {
        state.view
          .executeJavaScript(
            `(() => {
              const box = document.getElementById('wis-sub');
              if (!box) return false;
              box.style.bottom = '${state.pos}%';
              return true;
            })()`
          )
          .catch(() => {});
      }
      return state.pos;
    },

    nudge(by) {
      state.offset = Math.round((state.offset + by) * 10) / 10;
      if (state.view) {
        state.view
          .executeJavaScript(
            `(() => {
              if (!window.__wisSubs) return false;
              window.__wisSubs.offset = ${state.offset};
              const box = document.getElementById('wis-sub');
              if (box) box.__wisLast = null;
              return true;
            })()`
          )
          .catch(() => {});
      }
      return state.offset;
    },

    /* What is on screen, in a form worth keeping: the cues themselves, since the
       address they came from is a blob the player throws away on reload. */
    activeTrack() {
      const track = state.tracks.find((t) => t.id === state.active);
      if (!track || !track.cues || !track.cues.length) return null;
      return { name: track.label || 'Phụ đề', lang: track.lang || '', cues: track.cues, offset: state.offset };
    },

    // A subtitle read back out of the store: no address, cues already parsed.
    async useSaved(entry) {
      if (!entry || !Array.isArray(entry.cues) || !entry.cues.length) return { ok: false, cues: 0 };
      const id = 'saved:' + entry.name;
      const held = state.tracks.find((t) => t.id === id);
      if (held) held.cues = entry.cues;
      else state.tracks.push({ id, label: entry.name, lang: '', cues: entry.cues });
      if (Number.isFinite(entry.offset)) state.offset = entry.offset;
      return activate(id);
    },

    /* Reading a file without a film on screen: the cues are wanted, the drawing is
       not — there is nothing to draw them over yet. */
    parse: (text) => parseCues(text),

    // A file off the disk is just another track, and the one the viewer picked.
    async addFile(name, text) {
      const cues = parseCues(text);
      if (!cues.length) return { ok: false, cues: 0 };
      const id = 'file:' + name;
      const existing = state.tracks.find((t) => t.id === id);
      if (existing) existing.cues = cues;
      else state.tracks.push({ id, label: 'Tệp: ' + name, lang: '', cues });
      return activate(id);
    },

    // What the guest is actually holding, for a check that does not trust the
    // host's own bookkeeping.
    async inGuest() {
      if (!state.view) return null;
      return state.view
        .executeJavaScript(
          `(() => {
            const box = document.getElementById('wis-sub');
            return {
              ready: !!window.__wisSubsReady,
              cues: window.__wisSubs ? window.__wisSubs.cues.length : -1,
              offset: window.__wisSubs ? window.__wisSubs.offset : null,
              mountedIn: box && box.parentElement ? (box.parentElement.className || box.parentElement.tagName) : null,
              showing: box ? box.style.display !== 'none' : false,
              chars: box ? (box.textContent || '').length : 0,
            };
          })()`
        )
        .catch(() => null);
    },
  };
})();
