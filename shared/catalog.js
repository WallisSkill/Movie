/* The catalogue as the app understands it: the vsmov API, the HH3D scrape, and
   the caches that keep both cheap.

   Nothing in here knows about Electron, Node or the DOM. Every request goes
   through a transport handed in by whoever builds the catalogue — the desktop
   main process uses Node's fetch, the Android shell hands it down to OkHttp —
   so both platforms read the same site through the same parser instead of
   drifting apart. */

(function (root, factory) {
  const built = factory();
  if (typeof module === 'object' && module.exports) module.exports = built;
  else root.WiSCatalog = built;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const API_BASE = 'https://vsmov.com/api';
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  const HH3D_LINK = 'https://bit.ly/hh3d';
  const HH3D_TTL = 6 * 60 * 60 * 1000;
  const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
  const ACTOR_TTL = 7 * 24 * 60 * 60 * 1000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // A busy or briefly unreachable upstream, as opposed to an answer that says the
  // request itself was wrong — only the former is worth asking again.
  const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

  /* ------------------------------------------------------------ pure parsing */

  // The catalog endpoints answer with { status, items, pagination }; the taxonomy
  // endpoints answer with { status, data: { items } }. Flatten both to one shape.
  function normalizeList(json) {
    const items = json.items || (json.data && json.data.items) || [];
    const pagination = json.pagination ||
      (json.data && json.data.params && json.data.params.pagination) || {
        currentPage: 1,
        totalPages: 1,
        totalItems: items.length,
      };
    return { items, pagination, pathImage: json.pathImage || '' };
  }

  // Names arrive from two different tables, so they have to be compared with the
  // accents, punctuation and spacing thrown away.
  const normalizeName = (value) =>
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '');

  const decodeEntities = (raw) =>
    String(raw || '')
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

  // Everything read here is markup from a site we do not control, so nothing that
  // could be taken for a tag survives into the renderer.
  const plain = (html) => decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, '');

  const slugOf = (href) => {
    try {
      return new URL(href).pathname.replace(/^\/+|\/+$/g, '');
    } catch {
      return '';
    }
  };

  const ITEM_RE = /<article[^>]*class="[^"]*grid-item[^"]*"[^>]*>([\s\S]*?)<\/article>/g;

  function parseItems(html) {
    const items = [];

    for (const [, block] of html.matchAll(ITEM_RE)) {
      const one = (re) => (block.match(re) || [])[1] || '';
      const href = one(/class="halim-thumb"\s+href="([^"]+)"/);
      const name = plain(one(/class="entry-title">([^<]*)/));
      const slug = slugOf(href);
      if (!slug || !name) continue;

      items.push({
        source: 'hh3d',
        slug,
        name,
        origin_name: plain(one(/class="original_title">([^<]*)/)),
        poster_url: one(/<img[^>]+src="([^"]+)"/),
        // The listing already says which print and how far along it is, so these
        // cards need none of the per-title lookups the vsmov grid does.
        quality: plain(one(/class="status">([^<]*)/)),
        episode_current: plain(one(/class="episode">([^<]*)/)),
        tmdb: { vote_average: one(/halim-card-score-num">([\d.]+)/) },
      });
    }

    return items;
  }

  // The theme prints numbered page links; the largest is the last page.
  function parsePages(html) {
    const seen = [...html.matchAll(/\/page\/(\d+)/g)].map((m) => Number(m[1]));
    return seen.length ? Math.max(...seen) : 1;
  }

  const SERVER_RE = /<div[^>]*class="halim-server tab-pane[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="halim-server tab-pane|<\/div>\s*<\/div>\s*<\/div>)/g;
  const EPISODE_RE = /<li class="halim-episode[^"]*"><a href="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>([^<]*)<\/span>/g;

  function parseEpisodes(html) {
    const names = [...html.matchAll(/hh3d-server-tab__label">([^<]+)/g)].map((m) => plain(m[1]));
    const servers = [];

    for (const [, pane] of html.matchAll(SERVER_RE)) {
      const list = [...pane.matchAll(EPISODE_RE)].map(([, href, label]) => ({
        name: plain(label),
        slug: slugOf(href),
        // The watch page is the embed: it carries the site's own player, which is
        // the only thing that can ask for the key a stream needs.
        link_embed: href,
      }));

      // The site counts down from the newest episode; a player list reads better
      // the other way round.
      if (list.length) servers.push({ server_name: names[servers.length] || 'HH3D', server_data: list.reverse() });
    }

    return servers;
  }

  // WordPress stamps the last edit into the page head, which for a donghua listing
  // is exactly when the newest episode went up.
  const MODIFIED_RE = /(?:article:modified_time"\s+content|"dateModified"\s*:)\s*"([^"]+)"/;
  const modifiedAt = (html) => (html.match(MODIFIED_RE) || [])[1] || '';

  function parseDetail(html, slug) {
    const one = (re) => (html.match(re) || [])[1] || '';
    const all = (re) => [...new Set([...html.matchAll(re)].map((m) => plain(m[1])).filter(Boolean))];

    const name = plain(one(/<h1[^>]*>([^<]+)/)) || slug;
    const poster = one(/property="og:image" content="([^"]+)/);
    const score = one(/"ratingValue"\s*:\s*"?([\d.]+)/);
    const episodes = parseEpisodes(html);

    return {
      movie: {
        source: 'hh3d',
        slug,
        name,
        origin_name: plain(one(/class="original_title">([^<]*)/)),
        poster_url: poster,
        thumb_url: poster,
        content: plain(one(/class="item-content[^"]*"[^>]*>\s*<p>([\s\S]*?)<\/p>/)),
        quality: plain(one(/class="status">([^<]*)/)),
        lang: (episodes[0] && episodes[0].server_name) || '',
        episode_current: episodes.length ? `${episodes[0].server_data.length} tập` : '',
        category: all(/rel="category tag"[^>]*>([^<]+)/g).map((n) => ({ name: n })),
        country: [{ name: 'Trung Quốc' }],
        actor: [],
        director: [],
        updated_at: modifiedAt(html),
        tmdb: { vote_average: score },
      },
      episodes,
    };
  }

  /* ------------------------------------------------------------- the catalogue */

  /* deps.fetchText(url, { headers, timeout, range }) is the one primitive every
     call is built from. It resolves to { status, body, url }, where url is where
     the request finally landed — that last field is how the short link gives up
     the address HH3D lives at today.

     deps.cache is a tiny two-call store, { read(name), write(name, value) },
     holding JSON that is worth keeping between runs. deps.actors may be false on
     a platform where pulling a 22 MB table through the bridge is not worth it;
     the cast then comes back as names without portraits. */

  function createCatalog(deps) {
    const cacheRead = (name) => {
      try {
        return (deps.cache && deps.cache.read(name)) || null;
      } catch {
        return null;
      }
    };

    const cacheWrite = (name, value) => {
      try {
        if (deps.cache) deps.cache.write(name, value);
      } catch {
        /* a cache that will not write is still a working app */
      }
    };

    async function ask(url, opts, attempts) {
      const tries = attempts || 3;
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await deps.fetchText(url, opts);
          if (res.status >= 200 && res.status < 400) return res;
          const err = new Error(`HTTP ${res.status}`);
          err.status = res.status;
          err.retriable = RETRY_STATUS.has(res.status);
          throw err;
        } catch (err) {
          if (attempt >= tries || err.retriable === false) throw err;
          await sleep(400 * attempt);
        }
      }
    }

    /* ------------------------------------------------------------ vsmov api */

    async function apiGet(pathname, params, timeout, attempts) {
      const url = new URL(API_BASE + pathname);
      for (const [key, value] of Object.entries(params || {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
      }

      const res = await ask(
        url.toString(),
        { headers: { accept: 'application/json', 'user-agent': UA }, timeout: timeout || 25000 },
        attempts
      );

      try {
        return JSON.parse(res.body);
      } catch {
        const err = new Error('API khong tra ve JSON (co the endpoint khong ton tai)');
        err.retriable = false;
        throw err;
      }
    }

    /* The list and search endpoints answer with nothing but names, posters and
       years — the print a title is available in lives on /api/phim/{slug} alone.
       Showing it on a card therefore costs one detail call per card, so the
       answers are kept for the run of the session and spread over a few workers. */

    const formatCache = new Map();

    async function formatOf(slug) {
      if (formatCache.has(slug)) return formatCache.get(slug);

      const json = await apiGet(`/phim/${slug}`, null, 15000);
      const movie = json.movie || {};
      const servers = json.episodes || [];
      const info = {
        quality: movie.quality || '',
        lang: movie.lang || '',
        episode: movie.episode_current || '',
        /* What tells two uploads of one film apart: how many sources it carries,
           what they are called, and when it was put up. None of it is on a list
           row, and all of it decides which one is worth opening. */
        servers: servers.length,
        serverNames: servers.map((server) => String(server.server_name || '').replace(/\s+/g, ' ').trim()),
        created: (movie.created && movie.created.time) || '',
      };
      formatCache.set(slug, info);
      return info;
    }

    // One slow title should not hold up the rest, and one that fails simply goes
    // without a badge.
    async function spread(slugs, cap, workers, job) {
      const queue = [...new Set((slugs || []).filter(Boolean))].slice(0, cap);
      const out = {};
      let cursor = 0;

      const worker = async () => {
        while (cursor < queue.length) {
          const slug = queue[cursor++];
          try {
            out[slug] = await job(slug);
          } catch {
            out[slug] = null;
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, worker));
      return out;
    }

    /* ----------------------------------------------------------- actor index */

    let actorIndex = null;
    let actorIndexJob = null;

    // /api/dien-vien takes no filter: it answers with the entire 186k-row table,
    // about 22 MB. Pull it at most once a week, keep only the rows that carry a
    // portrait, and store it flattened to normalized-name -> TMDB path.
    async function buildActorIndex() {
      const cached = cacheRead('actors');
      if (cached && cached.map && Date.now() - cached.at < ACTOR_TTL) return cached.map;

      const json = await apiGet('/dien-vien', null, 90000);
      const items = (json.data && json.data.items) || json.items || [];
      const map = {};
      for (const person of items) {
        if (!person || typeof person.thumb_url !== 'string' || !person.thumb_url) continue;
        const key = normalizeName(person.name);
        if (key && !map[key]) map[key] = person.thumb_url.replace(TMDB_IMG, '');
      }

      cacheWrite('actors', { at: Date.now(), map });
      return map;
    }

    function actorIndexOnce() {
      if (actorIndex) return Promise.resolve(actorIndex);
      if (!actorIndexJob) {
        actorIndexJob = buildActorIndex().then(
          (map) => {
            actorIndex = map;
            return map;
          },
          (err) => {
            actorIndexJob = null; // let the next detail page try again
            throw err;
          }
        );
      }
      return actorIndexJob;
    }

    /* ------------------------------------------------------------------ hh3d */

    /* HH3D has no API and moves host every so often, so the short link is the
       only address worth writing down: every crawl starts by asking it where the
       site lives today. The answer is kept for the session and mirrored to the
       cache, so an outage of the shortener falls back to wherever the site was
       last seen instead of taking the whole tab down. */

    let hh3dHost = null; // { origin, at }
    let hh3dPending = null;

    function rememberHost(origin) {
      hh3dHost = { origin, at: Date.now() };
      cacheWrite('hh3dHost', hh3dHost);
      return origin;
    }

    function lastKnownHost() {
      if (hh3dHost) return hh3dHost.origin;
      const saved = cacheRead('hh3dHost');
      return (saved && saved.origin) || null;
    }

    function hh3dOrigin() {
      if (hh3dHost && Date.now() - hh3dHost.at < HH3D_TTL) return Promise.resolve(hh3dHost.origin);

      if (!hh3dPending) {
        hh3dPending = deps
          .fetchText(HH3D_LINK, { headers: { 'user-agent': UA }, timeout: 20000 })
          .then((res) => rememberHost(new URL(res.url).origin))
          .catch((err) => {
            // The shortener is unreachable: the last host we saw beats no host.
            const known = lastKnownHost();
            if (known) return known;
            throw err;
          })
          .finally(() => {
            hh3dPending = null;
          });
      }
      return hh3dPending;
    }

    async function hh3dGet(pathname, opts) {
      for (let attempt = 1; ; attempt++) {
        const origin = await hh3dOrigin();
        try {
          const res = await deps.fetchText(origin + pathname, {
            headers: { 'user-agent': UA, accept: 'text/html', referer: origin + '/' },
            timeout: 25000,
            ...(opts || {}),
          });
          if (res.status < 200 || res.status >= 400) {
            // A page that has stopped existing usually means the host moved on
            // and the cached origin is stale, so the next go re-reads the link.
            hh3dHost = null;
            const err = new Error(`HH3D tra ve HTTP ${res.status}`);
            err.retriable = RETRY_STATUS.has(res.status) || res.status === 404;
            throw err;
          }
          return res.body;
        } catch (err) {
          if (attempt >= 3 || err.retriable === false) throw err;
          await sleep(400 * attempt);
        }
      }
    }

    /* When a donghua last changed is when its newest episode went up, so a card
       can say how fresh it is — but that stamp only exists on the film's own
       page. The answers are kept for the session, and only the head of each page
       is asked for, since the stamp is in the <head> and the rest is a megabyte
       of comments. */

    const updatedCache = new Map();

    async function updatedOf(slug) {
      if (updatedCache.has(slug)) return updatedCache.get(slug);
      const html = await hh3dGet(`/${slug}`, { range: 'bytes=0-40000' });
      const at = modifiedAt(html);
      updatedCache.set(slug, at);
      return at;
    }

    /* --------------------------------------------------------------- the api */

    return {
      hostNow: lastKnownHost,
      warmUp() {
        // Settle where HH3D lives now, and index the cast, while the viewer is
        // still looking at the first grid.
        hh3dOrigin().catch(() => {});
        if (deps.actors !== false) actorIndexOnce().catch(() => {});
      },

      list: ({ slug, page, limit }) => apiGet(`/danh-sach/${slug}`, { page, limit }).then(normalizeList),
      genre: ({ slug, page, limit }) => apiGet(`/the-loai/${slug}`, { page, limit }).then(normalizeList),
      country: ({ slug, page, limit }) => apiGet(`/quoc-gia/${slug}`, { page, limit }).then(normalizeList),
      search: ({ keyword, page, limit }) => apiGet('/tim-kiem', { keyword, page, limit }).then(normalizeList),
      genres: () => apiGet('/the-loai').then(normalizeList),
      countries: () => apiGet('/quoc-gia').then(normalizeList),

      async detail({ slug }) {
        const json = await apiGet(`/phim/${slug}`);
        if (!json.movie) throw new Error('Khong tim thay phim nay');
        return { movie: json.movie, episodes: json.episodes || [] };
      },

      async format({ slugs }) {
        return { info: await spread(slugs, 80, 6, formatOf) };
      },

      async hh3d({ page }) {
        const at = Math.max(1, Number(page) || 1);
        const html = await hh3dGet(`/page/${at}/`);
        const items = parseItems(html);
        if (!items.length) throw new Error('Khong doc duoc danh sach HH3D (trang co the da doi giao dien)');
        return { items, pagination: { currentPage: at, totalPages: parsePages(html) } };
      },

      async hh3dSearch({ keyword, page }) {
        const at = Math.max(1, Number(page) || 1);
        const term = encodeURIComponent(String(keyword || '').trim());
        // The site answers ?s= on the front page and its own paging lives under
        // the /search/ path it redirects to.
        const html = await hh3dGet(at > 1 ? `/search/${term}/page/${at}/` : `/?s=${term}`);
        return { items: parseItems(html), pagination: { currentPage: at, totalPages: parsePages(html) } };
      },

      async hh3dDetail({ slug }) {
        return parseDetail(await hh3dGet(`/${slug}`), slug);
      },

      async hh3dUpdated({ slugs }) {
        const at = await spread(slugs, 40, 4, updatedOf);
        // A page that will not answer leaves that card without a stamp.
        Object.keys(at).forEach((slug) => {
          if (at[slug] === null) at[slug] = '';
        });
        return { at };
      },

      async cast({ names }) {
        if (deps.actors === false) return { people: (names || []).map((name) => ({ name, photo: '' })) };
        const map = await actorIndexOnce();
        const people = (names || []).map((name) => {
          const found = map[normalizeName(name)];
          const photo = !found ? '' : /^https?:\/\//i.test(found) ? found : TMDB_IMG + found;
          return { name, photo };
        });
        return { people };
      },
    };
  }

  return {
    API_BASE,
    UA,
    createCatalog,
    normalizeList,
    normalizeName,
    plain,
    parseItems,
    parsePages,
    parseEpisodes,
    parseDetail,
    modifiedAt,
  };
});
