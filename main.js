const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

// The reading of vsmov and HH3D is shared with the Android shell, which cannot
// run any of this process — see shared/catalog.js.
const { createCatalog } = require('./shared/catalog');

/* Stuttering at 1080p is usually the decode having fallen back to the CPU: a
   driver on Chromium's blocklist takes the GPU out of the picture entirely.
   These have to be set before the app is ready to have any effect. */
/* A trailer that has to be clicked before it runs is not what was asked for, and
   an embedded player will not start on its own while Chromium is waiting for a
   gesture that never comes. */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

let win = null;
let storeFile = null;

/* ---------------------------------------------------------- store on disk */

function defaultStore() {
  return {
    favorites: [],
    history: [],
    fillFrame: true,
    autoRecover: true,
    skipIntro: false,
    autoNext: false,
    // Vietnamese if the print carries it: the app draws subtitles itself, so this
    // is a language, not a switch on someone else's player.
    subLang: 'vi',
    // How high the subtitle line sits, in percent of the frame.
    subPos: 8,
    /* Subtitles the viewer attached themselves, kept per film so the same file
       does not have to be found again next time. Parsed cues rather than the
       original text: that is what gets drawn, and a blob address from the player
       is gone the moment the page reloads. */
    subs: [],
  };
}

// Renaming the package moved userData to a new folder, which would have looked
// like the favourites and history had been wiped. Carry the old file across the
// first time the app starts under the new name.
function migrateStore() {
  const legacy = path.join(app.getPath('appData'), 'vsmov-desktop', 'vsmov-store.json');
  try {
    if (fs.existsSync(storeFile) || !fs.existsSync(legacy)) return;
    fs.copyFileSync(legacy, storeFile);
  } catch (err) {
    console.error('store migration failed', err);
  }
}

function readStore() {
  try {
    return Object.assign(defaultStore(), JSON.parse(fs.readFileSync(storeFile, 'utf8')));
  } catch {
    return defaultStore();
  }
}

/* A subtitle file is the one thing in here that can be large — a three-hour film
   runs to a couple of thousand lines — and the store is read whole at every
   start. So the kept set is bounded, newest first, and each entry is trimmed to
   what a film can actually use. */
const SUBS_KEPT = 24;
const CUES_KEPT = 6000;

function keepSubs(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => entry && entry.film && Array.isArray(entry.cues) && entry.cues.length)
    .slice(0, SUBS_KEPT)
    .map((entry) => ({
      film: String(entry.film),
      filmName: String(entry.filmName || ''),
      name: String(entry.name || 'Phụ đề'),
      addedAt: String(entry.addedAt || ''),
      offset: Number.isFinite(entry.offset) ? entry.offset : 0,
      cues: entry.cues
        .slice(0, CUES_KEPT)
        .filter((cue) => cue && Number.isFinite(cue.s) && Number.isFinite(cue.e) && cue.t)
        .map((cue) => ({ s: cue.s, e: cue.e, t: String(cue.t) })),
    }));
}

function writeStore(data) {
  try {
    fs.writeFileSync(storeFile, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('store write failed', err);
    return false;
  }
}

/* ---------------------------------------------------------- the catalogue */

/* Requests are made here rather than in the window because the pages this app
   reads answer no cross-origin caller. The catalogue itself does not care: it
   is handed this one primitive and does its own parsing, caching and retrying. */

const CACHE_FILES = {};

const catalog = createCatalog({
  async fetchText(url, opts) {
    const { headers, timeout, range } = opts || {};
    const res = await fetch(url, {
      headers: { ...(headers || {}), ...(range ? { range } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout || 25000),
    });
    // Where the request landed matters as much as what it said: the HH3D short
    // link is read by following it.
    return { status: res.status, body: await res.text(), url: res.url };
  },

  cache: {
    read(name) {
      try {
        return JSON.parse(fs.readFileSync(CACHE_FILES[name], 'utf8'));
      } catch {
        return null;
      }
    },
    write(name, value) {
      try {
        fs.writeFileSync(CACHE_FILES[name], JSON.stringify(value), 'utf8');
      } catch (err) {
        console.error('cache write failed', name, err.message);
      }
    },
  },
});

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

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
].forEach((name) => handle(`catalog:${name}`, (payload) => catalog[name](payload)));

/* Which build is this? A packaged file carries the moment it was packed, so the
   question "is it running my new one?" has an answer inside the app rather than
   only in a folder listing. */
handle('app:build', () => {
  let builtAt = '';
  try {
    builtAt = fs.statSync(__filename).mtime.toISOString();
  } catch {
    /* unpacked and unknown is still an answer */
  }
  return { version: app.getVersion(), builtAt, packaged: app.isPackaged };
});

handle('store:read', () => readStore());
handle('store:write', (data) => {
  writeStore({
    favorites: data.favorites || [],
    history: data.history || [],
    fillFrame: data.fillFrame !== false,
    // The player switches default to leaving things alone, so they are read the
    // other way round: only an explicit true turns the automatic behaviour on.
    autoRecover: data.autoRecover !== false,
    skipIntro: data.skipIntro === true,
    autoNext: data.autoNext === true,
    subLang: typeof data.subLang === 'string' ? data.subLang : 'vi',
    subPos: Number.isFinite(data.subPos) ? data.subPos : 8,
    subs: keepSubs(data.subs),
  });
  return true;
});

/* ------------------------------------------------------ keeping playback fed */

/* A watch page is a whole ad-funded site around one video: trackers, ad frames,
   avatars, sliders. All of it competes with the stream for bandwidth and for the
   frames the player needs to decode on time, which is what stuttering looks like.
   None of it is ever seen — the player is pinned over the page — so none of it is
   worth fetching. */

/* Note what is not in here: googlevideo.com. That is where YouTube's picture
   itself comes from, ads and film alike, so blocking by address cannot separate
   them — the advert is skipped inside the player instead (see AD_SKIPPER in
   renderer/app.js). Everything below is only ever an advert or a tracker. */
const JUNK_RE =
  /(doubleclick|googlesyndication|googletagmanager|google-analytics|googleadservices|googleads\.|adservice\.|pagead|adsbygoogle|imasdk\.googleapis|2mdn\.net|moatads|scorecardresearch|zedo|revcontent|vidoomy|aniview|springserve|videoplaza|taboola|outbrain|mgid\.|propeller|popads|popcash|adsterra|onclickads|histats|statcounter|criteo|adnxs|pubmatic|rubiconproject|casalemedia|openx\.|smartadserver|admicro|adtima|eclick\.|yandex|metrika|hotjar|clarity\.ms|disqus|gravatar|connect\.facebook|facebook\.net|fbcdn)/i;

// The advert bookkeeping a player does on its own host, which is not a tracker
// domain and so has to be named by path.
const AD_PATH_RE = /\/(api\/stats\/ads|pagead|ptracking|get_midroll_info|api\/stats\/qoe\?.*adformat)/i;

// Nothing on a hidden page needs a picture or a typeface, but the vsmov player
// draws its own controls, so this only applies to the page HH3D serves.
const DEAD_WEIGHT = new Set(['image', 'font']);

function guestHost(details) {
  try {
    return new URL(details.referrer || details.url).host;
  } catch {
    return '';
  }
}

function hh3dHostname() {
  const origin = catalog.hostNow();
  try {
    return origin ? new URL(origin).host : '';
  } catch {
    return '';
  }
}

function trimPlayerTraffic() {
  // The trailer runs in a partition of its own so it cannot hold up the film's
  // guest, and it deserves the same filtering.
  ['persist:player', 'persist:trailer'].forEach(trimPartition);
}

function trimPartition(partition) {
  const filter = { urls: ['*://*/*'] };
  session.fromPartition(partition).webRequest.onBeforeRequest(filter, (details, callback) => {
    if (JUNK_RE.test(details.url) || AD_PATH_RE.test(details.url)) return callback({ cancel: true });

    const host = hh3dHostname();
    if (host && DEAD_WEIGHT.has(details.resourceType) && guestHost(details).endsWith(host)) {
      return callback({ cancel: true });
    }

    callback({});
  });
}

/* --------------------------------------------------------- trailer origin */

/* YouTube's embed refuses to play unless the page holding it has a real origin —
   from file:// it answers "Error 153" and stops. The watch page has no such
   check, but it comes with adverts that cannot be skipped from outside: the
   player pins the speed at 1 and refuses to seek. The embed almost never carries
   a pre-roll, so what is needed is an origin, and the smallest way to have one is
   to serve a single page from this process. */

const http = require('http');

let trailerBase = '';

const TRAILER_PAGE = (id, origin) => `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
</style>
<div id="mount"></div>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
  const id = ${JSON.stringify(id)};

  /* No captions on a trailer. The player is asked through its own api rather than
     by styling, since the picture lives in a frame of another origin that nothing
     here can reach into. */
  function quiet(player) {
    try {
      player.unloadModule('captions');
      player.unloadModule('cc');
      player.setOption('captions', 'track', {});
    } catch (err) {
      /* an older player names the module differently; the other calls cover it */
    }
  }

  function onYouTubeIframeAPIReady() {
    new YT.Player('mount', {
      videoId: id,
      host: 'https://www.youtube-nocookie.com',
      playerVars: {
        autoplay: 1, mute: 1, rel: 0, modestbranding: 1, playsinline: 1,
        iv_load_policy: 3, cc_load_policy: 0, origin: ${JSON.stringify(origin)},
      },
      events: {
        onReady(event) {
          // Muted is how it is allowed to start; sound is given back at once.
          event.target.playVideo();
          event.target.unMute();
          event.target.setVolume(100);
          quiet(event.target);
        },
        // The player brings its captions back when it changes state, so it is
        // told again each time rather than once at the start.
        onStateChange(event) { quiet(event.target); },
      },
    });
  }
</script>`;

function startTrailerHost() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const id = (url.searchParams.get('v') || '').replace(/[^\w-]/g, '');
      if (url.pathname !== '/t' || !id) {
        res.writeHead(404).end('no');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(TRAILER_PAGE(id, trailerBase));
    });

    // Loopback only: nothing here is meant to be reachable from anywhere else.
    server.listen(0, '127.0.0.1', () => {
      trailerBase = `http://127.0.0.1:${server.address().port}`;
      resolve(trailerBase);
    });
    server.on('error', () => resolve(''));
  });
}

handle('app:trailerBase', () => ({ base: trailerBase }));

/* ----------------------------------------------------------------- window */

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    title: 'WiSFilm',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  storeFile = path.join(app.getPath('userData'), 'vsmov-store.json');
  CACHE_FILES.actors = path.join(app.getPath('userData'), 'wisfilm-actors.json');
  CACHE_FILES.hh3dHost = path.join(app.getPath('userData'), 'wisfilm-hh3d-host.json');
  migrateStore();
  trimPlayerTraffic();
  startTrailerHost();
  createWindow();

  // Index the cast and settle where HH3D lives now while the viewer is still on
  // the first grid, so neither a detail page nor the HH3D tab waits on them.
  catalog.warmUp();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// The embedded player page is ad-supported: every window.open is a popup ad.
// Deny them all, and keep the shell window itself pinned to the local UI.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  contents.on('will-navigate', (event, url) => {
    if (contents === (win && win.webContents) && !url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
});
