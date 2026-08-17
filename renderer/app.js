'use strict';

/* --------------------------------------------------------------- helpers */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const content = $('#content');
const pageTitle = $('#page-title');

const PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="#171b25"/><text x="100" y="155" fill="#3a4155" font-family="sans-serif" font-size="15" text-anchor="middle">WiSFilm</text></svg>'
  );

const FACE_PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1d2231"/><circle cx="50" cy="38" r="17" fill="#333b52"/><path d="M18 92c0-19 14-30 32-30s32 11 32 30z" fill="#333b52"/></svg>'
  );

// The two image fields are named the wrong way round by this API: poster_url is
// a 16:9 backdrop, thumb_url is the real 2:3 poster artwork. Cards and the hero
// are portrait, so thumb_url comes first. Some entries also carry an empty
// object instead of a URL string, so anything non-string has to be dropped
// rather than concatenated. The pathImage the API advertises (nguon.vsphim.com)
// 404s, so relative paths are resolved against the host that actually serves
// the files.
const IMAGE_BASE = 'https://vsmov.com/storage/images/';

function posterOf(item) {
  const str = (value) => (typeof value === 'string' ? value.trim() : '');
  const raw = str(item.thumb_url) || str(item.poster_url);
  if (!raw) return PLACEHOLDER;
  if (/^https?:\/\//i.test(raw)) return raw;
  return IMAGE_BASE + raw.replace(/^\/+/, '');
}

/* ------------------------------------------------------- grouping a title */

/* The catalog stores every season as its own entry, and the same title can also
   appear more than once — a straight duplicate, or one row per print (HD / 4K).
   TMDB's id is shared by the whole family, so it groups them reliably; the name
   with its "- Phần N" tail removed is the fallback for entries with no TMDB
   link. Collapsing on that key is what removes the duplicates from the grid. */

const SEASON_SUFFIX = /\s*[-–—:]?\s*(?:phần|phan|season|ss|part)\s*(\d+)\s*$/i;

const baseName = (name) => String(name || '').replace(SEASON_SUFFIX, '').trim();

// tmdb.season is only filled in on the detail payload — on list and search rows
// the part number exists nowhere but the title.
function seasonOf(item) {
  const tagged = Number(item.tmdb && item.tmdb.season);
  if (tagged) return tagged;
  const match = SEASON_SUFFIX.exec(String(item.name || ''));
  return match ? Number(match[1]) : 0;
}

/* The same title, compared the way a person reads it: accents, punctuation and
   spacing carry no meaning here, and neither does the season tail. */
const plainName = (name) =>
  baseName(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/* What counts as one film. The catalogue lists the same title more than once
   under ids of its own, so the name and the year are the key — a TMDB id only
   agrees with that, and when it disagrees it is because two entries for one film
   were linked differently. Groups sharing an id are merged afterwards, which is
   what keeps a season released under a different title with its family. */
function familyKey(item) {
  return 'name:' + plainName(item.name) + ':' + (item.year || '');
}

const tmdbKey = (item) => {
  const tmdb = item.tmdb || {};
  return tmdb.id ? 'tmdb:' + (tmdb.type || '') + ':' + tmdb.id : '';
};

// Two rows are the same release — not two parts of one show — when they land on
// the same family, the same part number and the same year.
const variantKey = (item) =>
  [familyKey(item), seasonOf(item), item.year || '', baseName(item.name).toLowerCase()].join('|');

const QUALITY_RANKS = [
  [/4k|2160/i, 4],
  [/fhd|1080/i, 3],
  [/hd|720/i, 2],
  [/sd|cam|ts/i, 1],
];

function qualityRank(item) {
  const quality = String(item.quality || '');
  for (const [pattern, rank] of QUALITY_RANKS) if (pattern.test(quality)) return rank;
  return 0;
}

const freshness = (item) => Date.parse((item.modified && item.modified.time) || '') || 0;

/* How much of the film an entry actually is. Two rows for one title are usually
   not equals: one is the finished thing and the other is a trailer, or a series
   that stopped halfway. That matters more than which print it is, because the
   short one is not worth opening at all. */
const COMPLETENESS = [
  [/tr[aà]iler|s[aắ]p chi[eế]u|teaser/i, 0],
  [/ho[aà]n t[aấ]t|full|thuy[eế]t minh xong/i, 3],
  [/(\d+)\s*\/\s*(\d+)/, 2],
  [/t[aậ]p\s*\d+/i, 2],
];

function completeness(item) {
  const said = String(item.episode_current || '');
  for (const [pattern, rank] of COMPLETENESS) if (pattern.test(said)) return rank;
  return 1;
}

// The fuller entry wins, then the better print; when the rows are otherwise
// indistinguishable — list rows carry no quality field at all — the more
// recently refreshed one wins.
const betterCopy = (a, b) =>
  completeness(b) - completeness(a) || qualityRank(b) - qualityRank(a) || freshness(b) - freshness(a);

// Newest part first, best copy within a part.
const byBest = (a, b) =>
  seasonOf(b) - seasonOf(a) || betterCopy(a, b) || (Number(b.year) || 0) - (Number(a.year) || 0);

// Drops the straight duplicates: one card per release, keeping the best copy.
function dedupe(items) {
  const best = new Map();
  items.forEach((item) => {
    const key = variantKey(item);
    const held = best.get(key);
    if (!held || betterCopy(item, held) < 0) best.set(key, item);
  });
  return [...best.values()];
}

function groupFamilies(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = familyKey(item);
    if (groups.has(key)) groups.get(key).push(item);
    else groups.set(key, [item]);
  });

  /* A second pass for the case the name cannot catch: one film listed under two
     titles, tied together only by the id the catalogue gave it. */
  const byTmdb = new Map();
  [...groups.entries()].forEach(([key, members]) => {
    const id = members.map(tmdbKey).find(Boolean);
    if (!id) return;
    const held = byTmdb.get(id);
    if (held === undefined) return byTmdb.set(id, key);
    if (held === key) return;
    groups.get(held).push(...members);
    groups.delete(key);
  });

  return [...groups.values()].map((members) => {
    const variants = dedupe(members).sort(byBest);
    const lead = variants[0];
    return {
      lead,
      variants,
      /* The catalogue carries the same release more than once — different
         uploads of one film, which differ in what they actually offer: one may
         have a dub as well as subtitles, or a second source. Those are not
         duplicates to be thrown away; each is shown, fullest first, and what
         separates them is spelled out on the card once known. */
      copies: members.filter((item) => variantKey(item) === variantKey(lead)).sort(betterCopy),
      // Deduplication runs before any print is known, so the row it dropped may
      // well have been the better copy. Keep them all for the format lookup.
      members,
      // Only what survived deduplication counts as a separate part, so an entry
      // listed twice never gets advertised as "2 phần".
      parts: variants.length,
      // The parts of one show hardly ever share a year, and two unrelated shows
      // can carry the same Vietnamese title — the span tells them apart.
      years: [...new Set(variants.map((m) => Number(m.year)).filter(Boolean))].sort(),
    };
  });
}

// Rows that look identical still have to say which is which, so the note is
// built out of whichever fields actually differ across the set on screen.
function differenceNote(item, siblings) {
  const differs = (pick) => new Set(siblings.map(pick)).size > 1;
  const notes = [];

  if (item.quality && differs((s) => String(s.quality || ''))) notes.push(item.quality);
  if (item.lang && differs((s) => String(s.lang || ''))) notes.push(item.lang);
  if (item.year && differs((s) => String(s.year || ''))) notes.push(String(item.year));
  if (!notes.length && freshness(item) && differs(freshness)) {
    notes.push('Cập nhật ' + new Date(freshness(item)).toLocaleDateString('vi-VN'));
  }
  return notes.join(' · ');
}

const MAIN_LISTS = [
  { slug: 'phim-moi-cap-nhat', label: 'Mới cập nhật' },
  { slug: 'phim-le', label: 'Phim lẻ' },
  { slug: 'phim-bo', label: 'Phim bộ' },
  { slug: 'subteam', label: 'Subteam' },
];

/* ----------------------------------------------------------------- state */

const state = {
  view: null, // { kind, slug, label, page, keyword }
  history: [], // navigation stack of view descriptors
  store: {
    favorites: [],
    history: [],
    fillFrame: true,
    autoRecover: true,
    skipIntro: false,
    autoNext: false,
    subLang: 'vi',
    subPos: 8,
  },
  scope: 'vsmov', // which catalogue the search bar is currently pointed at
  // The film last opened, so a subtitle picked after closing it still has an owner.
  lastFilm: null,
};

async function loadStore() {
  const res = await window.api.readStore();
  if (res.ok) state.store = res.data;
}

function saveStore() {
  window.api.writeStore(JSON.parse(JSON.stringify(state.store)));
}

const isFav = (slug) => state.store.favorites.some((m) => m.slug === slug);

function toggleFav(movie) {
  const idx = state.store.favorites.findIndex((m) => m.slug === movie.slug);
  if (idx >= 0) state.store.favorites.splice(idx, 1);
  else
    state.store.favorites.unshift({
      slug: movie.slug,
      name: movie.name,
      origin_name: movie.origin_name,
      poster_url: movie.poster_url,
      thumb_url: movie.thumb_url,
      year: movie.year,
      // Which catalogue the row came from, so reopening it later asks the right
      // one rather than looking the slug up in a table that never had it.
      source: movie.source,
    });
  saveStore();
  return idx < 0;
}

/* Where a film was left off, not just which episode. The watchdog already reads
   the guest's clock every few seconds for its own reasons, so the position comes
   free — it only has to be written down, and not on every tick. */

const asClock = (seconds) => {
  const whole = Math.max(0, Math.floor(seconds || 0));
  const mm = String(Math.floor(whole / 60) % 60).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  const hh = Math.floor(whole / 3600);
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
};

let progressWritten = 0;

function saveProgress(seconds) {
  if (!playerCtx || !Number.isFinite(seconds)) return;
  // A minute of film is close enough to come back to; writing every tick would
  // put the store on disk twenty times a minute for nothing.
  if (Date.now() - progressWritten < 10000) return;
  progressWritten = Date.now();

  const entry = state.store.history.find((h) => h.slug === playerCtx.movie.slug);
  if (!entry) return;
  entry.pos = Math.floor(seconds);
  entry.epIndex = playerCtx.epIndex;
  entry.serverIndex = playerCtx.serverIndex;
  saveStore();
}

// The saved position belongs to an episode, so a different one starts clean.
function resumeFor(slug, epIndex) {
  const entry = state.store.history.find((h) => h.slug === slug);
  if (!entry || entry.epIndex !== epIndex) return 0;
  return Number.isFinite(entry.pos) ? entry.pos : 0;
}

function rememberWatch(movie, serverIndex, epIndex, epName) {
  const held = state.store.history.find((h) => h.slug === movie.slug);
  const entry = {
    slug: movie.slug,
    name: movie.name,
    origin_name: movie.origin_name,
    poster_url: movie.poster_url,
    thumb_url: movie.thumb_url,
    year: movie.year,
    source: movie.source,
    serverIndex,
    epIndex,
    epName,
    at: Date.now(),
    // Same episode as last time: the position it was left at still means something.
    pos: held && held.epIndex === epIndex ? held.pos || 0 : 0,
  };
  state.store.history = [entry, ...state.store.history.filter((h) => h.slug !== movie.slug)].slice(
    0,
    60
  );
  saveStore();
}

const lastWatch = (slug) => state.store.history.find((h) => h.slug === slug);

/* --------------------------------------------------------------- ui bits */

function showLoading(message) {
  content.innerHTML = '';
  const box = el('div', 'state');
  box.appendChild(el('div', 'spinner'));
  box.appendChild(el('div', null, message || 'Đang tải…'));
  content.appendChild(box);
}

function showError(message, retry) {
  content.innerHTML = '';
  const box = el('div', 'state error');
  box.appendChild(el('div', null, message));
  if (retry) {
    const btn = el('button', 'btn ghost', 'Thử lại');
    btn.style.marginTop = '16px';
    btn.onclick = retry;
    box.appendChild(btn);
  }
  content.appendChild(box);
}

function makeCard(item, options) {
  const { subtitle, parts = 0, years = [] } = options || {};
  const card = el('div', 'card');
  const wrap = el('div', 'poster');

  const img = el('img');
  img.loading = 'lazy';
  img.src = posterOf(item);
  img.onerror = () => {
    img.onerror = null;
    img.src = PLACEHOLDER;
  };
  wrap.appendChild(img);

  const epLabel = item.episode_current || (item.tmdb && item.tmdb.type === 'tv' ? 'Phim bộ' : '');
  if (epLabel) wrap.appendChild(el('span', 'badge', epLabel));

  const score = item.tmdb && parseFloat(item.tmdb.vote_average);
  if (score > 0) wrap.appendChild(el('span', 'badge rate', '★ ' + score.toFixed(1)));

  // HH3D states the print on the listing itself, so that badge needs no lookup
  // and goes up with the rest of the card.
  if (item.quality) wrap.appendChild(el('span', 'badge quality', item.quality));

  // What the collapsed duplicates left behind, plus the part this card stands
  // for when it stands for only one.
  const season = seasonOf(item);
  if (parts > 1) wrap.appendChild(el('span', 'badge parts', parts + ' phần'));
  else if (season) wrap.appendChild(el('span', 'badge parts', 'Phần ' + season));

  card.appendChild(wrap);

  // Every card carries the show's name and leaves the part to the badge, so one
  // title never shows up on the grid under several different spellings.
  const title = baseName(item.name) || item.name;
  const origin = baseName(item.origin_name) || item.origin_name;
  const span = years.length > 1 ? years[0] + '–' + years[years.length - 1] : item.year;

  const sub = subtitle || [origin, span].filter(Boolean).join(' • ');
  const meta = el('div', 'meta');
  meta.appendChild(el('div', 'name', title || '(không tên)'));
  meta.appendChild(el('div', 'sub', sub));
  card.appendChild(meta);

  // Both lines are clipped to the card width, and the subtitle is exactly what
  // separates two shows that share a title — so keep it readable on hover.
  card.title = [title, sub].filter(Boolean).join('\n');

  card.onclick = () => openDetail(item.slug, item.source);
  return card;
}

// "2 giờ trước" answers the only question the timestamp is asked: how fresh is
// the newest episode.
function sinceText(iso) {
  const at = Date.parse(iso || '');
  if (!at) return '';

  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'vừa xong';
  if (minutes < 60) return minutes + ' phút trước';

  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' giờ trước';

  const days = Math.round(hours / 24);
  if (days < 30) return days + ' ngày trước';

  const months = Math.round(days / 30);
  return months < 12 ? months + ' tháng trước' : Math.round(months / 12) + ' năm trước';
}

// HH3D states no date on its listing, so the cards go up first and the stamp
// follows once each film's own page has been read for it.
function stampUpdated(entries, token) {
  const rows = entries.filter((entry) => entry.card && entry.lead.source === 'hh3d' && entry.lead.slug);
  if (!rows.length) return;

  window.api.hh3dUpdated({ slugs: rows.map((entry) => entry.lead.slug) }).then((res) => {
    if (state.view !== token || !res.ok) return;

    rows.forEach((entry) => {
      const iso = res.data.at[entry.lead.slug];
      const text = sinceText(iso);
      const meta = entry.card.querySelector('.meta');
      if (!text || !meta) return;

      const stamp = el('div', 'stamp', 'Cập nhật ' + text);
      stamp.title = new Date(iso).toLocaleString('vi-VN');
      meta.appendChild(stamp);
    });
  });
}

// No vsmov list payload carries the print a title is available in, so the cards
// go up straight away and the format badge is stamped on once the details are
// back. Rows that already stated their print are left alone.
function stampFormats(entries, token) {
  const pending = entries.filter((entry) => !entry.lead.quality);
  const slugs = pending.flatMap((entry) => entry.members.map((item) => item.slug)).filter(Boolean);
  if (!slugs.length) return;

  window.api.format({ slugs }).then((res) => {
    if (state.view !== token || !res.ok) return;
    const info = res.data.info;

    const bestOf = (rows) =>
      rows
        .map((item) => ({ item, info: info[item.slug] }))
        .filter((row) => row.info && row.info.quality)
        .sort((a, b) => qualityRank(b.info) - qualityRank(a.info))[0];

    pending.forEach((entry) => {
      const poster = entry.card && entry.card.querySelector('.poster');
      if (!poster) return;

      // A card standing for several parts advertises the best print among them.
      const best = bestOf(entry.members);
      if (best) poster.appendChild(el('span', 'badge quality', best.info.quality));

      /* One of several uploads of the same release: the card has to say which one
         it is, or the two are indistinguishable. What differs is the audio it
         carries, the number of sources behind it and the day it went up. */
      const own = info[entry.lead.slug];
      const meta = entry.card.querySelector('.meta');
      if (entry.sibling && own && meta) {
        const added = Date.parse(own.created || '');
        const parts = [
          own.lang || '',
          own.servers ? own.servers + ' nguồn' : '',
          added ? 'thêm ' + new Date(added).toLocaleDateString('vi-VN') : '',
        ].filter(Boolean);

        const line = el('div', 'stamp variant', parts.join(' · '));
        line.title = (own.serverNames || []).join(' · ');
        meta.appendChild(line);
      }

      // The same part can be listed once per print, and which of those rows
      // became the card was decided before any print was known — so send the
      // click to the best copy of the part actually on screen.
      const part = seasonOf(entry.lead);
      const pick = bestOf(entry.members.filter((item) => seasonOf(item) === part));
      if (pick && pick.item.slug !== entry.lead.slug) {
        entry.card.onclick = () => openDetail(pick.item.slug);
      }
    });
  });
}

function renderGrid(items, options) {
  const { subtitleOf, group = true } = options || {};
  const grid = el('div', 'grid');

  const families = group
    ? groupFamilies(items)
    : items.map((item) => ({ lead: item, variants: [item], members: [item], copies: [item], parts: 0, years: [] }));

  /* One card per upload, not per film: two uploads of the same release each get
     their own, so neither is hidden behind the other. Everything else about the
     family — its parts, its years — stays attached to both. */
  const entries = families.flatMap((family) => {
    const copies = family.copies && family.copies.length ? family.copies : [family.lead];
    if (copies.length < 2) return [family];
    return copies.map((copy) => ({ ...family, lead: copy, members: [copy], sibling: copies.length }));
  });

  entries.forEach((entry) => {
    // One malformed entry from the API must not take the whole page down.
    try {
      entry.card = makeCard(entry.lead, {
        subtitle: subtitleOf && subtitleOf(entry.lead),
        parts: entry.parts,
        years: entry.years,
      });
      if (entry.sibling) entry.card.classList.add('one-of-many');
      grid.appendChild(entry.card);
    } catch (err) {
      console.warn('bo qua item loi', entry.lead && entry.lead.slug, err);
    }
  });

  stampFormats(entries, state.view);
  stampUpdated(entries, state.view);
  return grid;
}

function renderPager(pagination, onPage) {
  const total = Math.max(1, Number(pagination.totalPages) || 1);
  const current = Math.max(1, Number(pagination.currentPage) || 1);
  if (total <= 1) return null;

  const bar = el('div', 'pager');

  const prev = el('button', null, '‹ Trước');
  prev.disabled = current <= 1;
  prev.onclick = () => onPage(current - 1);

  const next = el('button', null, 'Sau ›');
  next.disabled = current >= total;
  next.onclick = () => onPage(current + 1);

  bar.appendChild(prev);
  bar.appendChild(el('span', null, `Trang ${current} / ${total}`));
  bar.appendChild(next);
  return bar;
}

/* ------------------------------------------------------------ navigation */

function pushHistory(view) {
  if (state.view) state.history.push(state.view);
  state.view = view;
}

function goBack() {
  if (!$('#player').classList.contains('hidden')) return closePlayer();
  const prev = state.history.pop();
  if (!prev) return;
  state.view = null;
  render(prev, false);
}

function markActiveNav(key) {
  document
    .querySelectorAll('#nav-main button, #nav-local button, .nav-sub button')
    .forEach((btn) => btn.classList.toggle('active', btn.dataset.key === key));
}

const HH3D_VIEWS = new Set(['hh3d', 'hh3dSearch']);

/* There is one search bar, and it searches whichever catalogue the viewer is
   standing in: inside HH3D it looks through HH3D, everywhere else it asks
   vsmov. The placeholder says which, so a search is never a surprise. */
function setSearchScope(view) {
  const inHh3d = HH3D_VIEWS.has(view.kind) || (view.kind === 'detail' && view.source === 'hh3d');
  state.scope = inHh3d ? 'hh3d' : 'vsmov';

  const box = $('#search');
  box.placeholder = inHh3d ? 'Tìm trong HH3D… (Enter để tìm)' : 'Tìm phim theo tên… (Enter để tìm)';
  box.classList.toggle('scoped', inHh3d);
  document.querySelectorAll('#nav-hh3d-links button').forEach((btn) => btn.classList.toggle('active', inHh3d));
}

async function render(view, push = true) {
  stopTrailer(); // leaving the page it belongs to is the end of it
  if (push) pushHistory(view);
  else state.view = view;

  pageTitle.textContent = view.label;
  markActiveNav(view.kind + ':' + (view.slug || view.keyword || ''));
  setSearchScope(view);

  if (view.kind === 'subs') return renderSubsTab();
  if (view.kind === 'favorites') return renderLocal(state.store.favorites, 'Chưa có phim yêu thích nào.');
  if (view.kind === 'watching')
    return renderLocal(state.store.history, 'Chưa có lịch sử xem.', (item) => {
      const where = item.epName ? 'Tập ' + item.epName : '';
      // Where it was left off is the useful half of "đang xem".
      const at = Number.isFinite(item.pos) && item.pos > 20 ? asClock(item.pos) : '';
      return [where, at].filter(Boolean).join(' · ');
    });

  showLoading('Đang tải ' + view.label.toLowerCase() + '…');

  const fetchers = {
    list: () => window.api.list({ slug: view.slug, page: view.page }),
    genre: () => window.api.genre({ slug: view.slug, page: view.page }),
    country: () => window.api.country({ slug: view.slug, page: view.page }),
    search: () => window.api.search({ keyword: view.keyword, page: view.page }),
    hh3d: () => window.api.hh3d({ page: view.page }),
    hh3dSearch: () => window.api.hh3dSearch({ keyword: view.keyword, page: view.page }),
  };

  const res = await fetchers[view.kind]();
  if (state.view !== view) return; // a newer navigation already won
  if (!res.ok) return showError('Lỗi: ' + res.error, () => render(view, false));

  const { items, pagination } = res.data;
  content.innerHTML = '';

  if (!items.length) {
    content.appendChild(el('div', 'state', 'Không có kết quả nào.'));
    return;
  }

  content.appendChild(renderGrid(items));
  const pager = renderPager(pagination, (page) => render({ ...view, page }, false));
  if (pager) content.appendChild(pager);
  content.scrollTop = 0;
}

/* ------------------------------------------------------------ tab phụ đề */

/* Everything the viewer brought in from outside, in one place: which film it
   belongs to, how many lines it has, whether it runs early or late, and whether
   it is wanted at all. The films' own subtitles are not listed — they are not
   ours to keep or to change, and they will be on the page next time regardless. */

/* Adding one from here, not only from the player. On a handset the player's own
   way of attaching a subtitle is out of reach — which is what made it impossible
   to add one at all on a phone — and this button always is. It needs a film on
   screen to belong to, so it says so when there is none. */
function subsAddRow() {
  const row = el('div', 'subs-add');

  const target = (playerCtx && playerCtx.movie) || state.lastFilm;
  const pick = el('button', 'subs-btn use', '＋  Thêm tệp .srt / .vtt');
  pick.disabled = !target;
  pick.onclick = () => $('#sub-file').click();
  row.appendChild(pick);

  const hint = !target
    ? 'Mở một phim trước, rồi quay lại đây để thêm phụ đề cho phim đó.'
    : `Sẽ dùng cho: ${target.name}` + (playerCtx ? ' (đang xem)' : ' — bật khi mở lại phim');
  row.appendChild(el('div', 'subs-hint', hint));

  return row;
}

function renderSubsTab() {
  content.innerHTML = '';
  const saved = state.store.subs || [];
  content.appendChild(subsAddRow());

  if (!saved.length) {
    content.appendChild(
      el(
        'div',
        'state',
        'Chưa có phụ đề nào được thêm. Thêm tệp ở trên, hoặc gắn bằng nút CC của trình phát trong lúc xem — WiSFilm sẽ vẽ và lưu lại ở đây.'
      )
    );
    return;
  }

  const list = el('div', 'subs-list');

  saved.forEach((entry) => {
    const row = el('div', 'subs-row');

    const head = el('div', 'subs-head');
    head.appendChild(el('div', 'subs-name', entry.name));
    head.appendChild(el('div', 'subs-film', entry.filmName || entry.film));
    list.appendChild(row);

    const meta = el('div', 'subs-meta');
    const when = Date.parse(entry.addedAt || '');
    meta.textContent =
      `${entry.cues.length} dòng` +
      (when ? ` · thêm ${new Date(when).toLocaleString('vi-VN')}` : '') +
      (entry.offset ? ` · lệch ${entry.offset.toFixed(1)}s` : '');

    const acts = el('div', 'subs-acts');

    const shift = (by) => {
      entry.offset = Math.round(((entry.offset || 0) + by) * 10) / 10;
      saveStore();
      // The film on screen is this one: the change is worth seeing at once.
      if (playerCtx && playerCtx.movie.slug === entry.film) window.WiSSubs.useSaved(entry);
      renderSubsTab();
    };

    const earlier = el('button', 'subs-btn', '−0,5s');
    earlier.onclick = () => shift(-0.5);
    const later = el('button', 'subs-btn', '+0,5s');
    later.onclick = () => shift(0.5);

    const use = el('button', 'subs-btn use', 'Dùng ngay');
    use.disabled = !(playerCtx && playerCtx.movie.slug === entry.film);
    use.title = use.disabled ? 'Mở phim này trước đã' : 'Bật phụ đề này cho phim đang xem';
    use.onclick = async () => {
      const res = await window.WiSSubs.useSaved(entry);
      showPlayerNotice(res.ok ? `Đã bật ${entry.name} (${res.cues} dòng)` : 'Không đọc được phụ đề này.', {
        kind: 'subs',
      });
    };

    const open = el('button', 'subs-btn', 'Mở phim');
    open.onclick = () => openDetail(entry.film);

    const drop = el('button', 'subs-btn danger', 'Xoá');
    drop.onclick = () => {
      state.store.subs = saved.filter((held) => held !== entry);
      saveStore();
      renderSubsTab();
    };

    [earlier, later, use, open, drop].forEach((btn) => acts.appendChild(btn));

    row.appendChild(head);
    row.appendChild(meta);
    row.appendChild(acts);
  });

  content.appendChild(list);
  content.scrollTop = 0;
}

function renderLocal(items, emptyMessage, subtitleOf) {
  content.innerHTML = '';
  if (!items.length) {
    content.appendChild(el('div', 'state', emptyMessage));
    return;
  }
  // Favourites and history are hand-picked rows: collapsing them would hide an
  // entry the user put there on purpose.
  content.appendChild(renderGrid(items, { subtitleOf, group: false }));
  content.scrollTop = 0;
}

/* ---------------------------------------------------------------- detail */

async function openDetail(slug, source) {
  stopTrailer(); // the one on screen belongs to the film being left behind
  const view = { kind: 'detail', slug, source, label: 'Chi tiết phim' };
  pushHistory(view);
  pageTitle.textContent = 'Chi tiết phim';
  markActiveNav(null);
  setSearchScope(view);
  showLoading('Đang tải thông tin phim…');

  const res = source === 'hh3d' ? await window.api.hh3dDetail({ slug }) : await window.api.detail({ slug });
  if (state.view !== view) return;
  if (!res.ok) return showError('Lỗi: ' + res.error, () => openDetail(slug, source));

  drawDetail(res.data.movie, res.data.episodes);
}

// The 16:9 field the API calls poster_url is useless as cover art but makes a
// good blurred backdrop behind the detail header.
function backdropOf(movie) {
  const str = (value) => (typeof value === 'string' ? value.trim() : '');
  const raw = str(movie.poster_url) || str(movie.thumb_url);
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : IMAGE_BASE + raw.replace(/^\/+/, '');
}

function drawDetail(movie, episodes) {
  const token = state.view; // a later navigation must not get this page's async fills
  pageTitle.textContent = movie.name;
  content.innerHTML = '';

  // Everything lives in one wrapper so the backdrop can stretch to the full
  // height of the page rather than only the strip above the fold.
  const page = el('div', 'detail-page');
  content.appendChild(page);

  const backdropUrl = backdropOf(movie);
  if (backdropUrl) {
    const backdrop = el('div', 'detail-backdrop');
    const bgImg = el('img');
    bgImg.src = backdropUrl;
    bgImg.onerror = () => backdrop.remove();
    backdrop.appendChild(bgImg);
    page.appendChild(backdrop);
  }

  const hero = el('div', 'detail-hero');

  const img = el('img');
  img.src = posterOf(movie);
  img.onerror = () => {
    img.onerror = null;
    img.src = PLACEHOLDER;
  };
  hero.appendChild(img);

  const info = el('div', 'detail-info');
  info.appendChild(el('h1', null, movie.name));
  if (movie.origin_name) info.appendChild(el('div', 'origin', movie.origin_name));

  const chips = el('div', 'chips');
  const addChip = (text, highlight) => {
    if (text) chips.appendChild(el('span', 'chip' + (highlight ? ' hl' : ''), text));
  };
  addChip(movie.year && String(movie.year));
  addChip(movie.quality, true);
  addChip(movie.lang);
  addChip(movie.time);
  addChip(movie.episode_current);
  // How fresh the newest episode is, which on a running series is the first
  // thing worth knowing.
  addChip(sinceText(movie.updated_at) && 'Cập nhật ' + sinceText(movie.updated_at));
  if (movie.tmdb && parseFloat(movie.tmdb.vote_average) > 0)
    addChip('★ ' + movie.tmdb.vote_average + ' TMDB');
  (movie.category || []).forEach((c) => addChip(c.name));
  (movie.country || []).forEach((c) => addChip(c.name));
  info.appendChild(chips);

  if (movie.content) {
    const desc = el('div', 'desc');
    desc.innerHTML = movie.content; // API returns a short HTML synopsis
    desc.textContent = desc.textContent.trim();
    info.appendChild(desc);
  }

  const director = (movie.director || []).filter((d) => d && d !== 'Đang cập nhật');
  if (director.length) info.appendChild(el('div', 'credits', 'Đạo diễn: ' + director.join(', ')));

  const flatEpisodes = episodes.filter((s) => (s.server_data || []).length);

  const actions = el('div', 'actions');
  if (flatEpisodes.length) {
    const resume = lastWatch(movie.slug);
    const playBtn = el(
      'button',
      'btn',
      resume ? '▶  Xem tiếp tập ' + resume.epName : '▶  Xem ngay'
    );
    playBtn.onclick = () =>
      openPlayer(
        movie,
        flatEpisodes,
        resume ? Math.min(resume.serverIndex, flatEpisodes.length - 1) : 0,
        resume ? resume.epIndex : 0
      );
    actions.appendChild(playBtn);
  }

  const favBtn = el('button', 'btn ghost', isFav(movie.slug) ? '♥  Bỏ yêu thích' : '♡  Yêu thích');
  favBtn.onclick = () => {
    favBtn.textContent = toggleFav(movie) ? '♥  Bỏ yêu thích' : '♡  Yêu thích';
  };
  actions.appendChild(favBtn);

  info.appendChild(actions);
  hero.appendChild(info);
  page.appendChild(hero);

  /* The trailer runs as soon as the page is open, without being asked for: it is
     what the page is for before the film itself is. Mounted in the player's own
     partition so the ad filter applies to it too, and it goes when the view does
     — the container is emptied on the next navigation, which takes the guest
     with it. */
  const trailerId = youtubeId(movie.trailer_url);
  if (trailerId) {
    const box = el('section', 'trailer');
    box.appendChild(el('div', 'trailer-head', 'Trailer'));

    const frame = el('div', 'trailer-frame');
    frame.appendChild(trailerPlayer(trailerId));
    box.appendChild(frame);
    page.appendChild(box);
  }

  const cast = (movie.actor || []).filter((name) => name && name !== 'Đang cập nhật');
  if (cast.length) page.appendChild(castBlock(cast.slice(0, 24), token));

  page.appendChild(familyBlock(movie, token));

  if (!flatEpisodes.length) {
    page.appendChild(el('div', 'state', 'Phim này chưa có nguồn phát.'));
    return;
  }

  flatEpisodes.forEach((server, serverIndex) => {
    const block = el('div', 'server-block');
    block.appendChild(el('h3', null, cleanServerName(server.server_name)));
    const grid = el('div', 'ep-grid');
    server.server_data.forEach((ep, epIndex) => {
      const btn = el('button', 'ep-btn', ep.name || ep.filename || 'Tập ' + (epIndex + 1));
      btn.onclick = () => openPlayer(movie, flatEpisodes, serverIndex, epIndex);
      grid.appendChild(btn);
    });
    block.appendChild(grid);
    page.appendChild(block);
  });

  content.scrollTop = 0;
}

const cleanServerName = (name) => (name || 'Server').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------- cast */

function castCard(name, photo) {
  const card = el('div', 'cast-card');
  const img = el('img');
  img.loading = 'lazy';
  img.src = photo || FACE_PLACEHOLDER;
  img.onerror = () => {
    img.onerror = null;
    img.src = FACE_PLACEHOLDER;
  };
  card.appendChild(img);
  card.appendChild(el('div', 'cast-name', name));
  card.appendChild(el('div', 'cast-role', 'Diễn viên'));
  return card;
}

// The names render straight away and the portraits drop in afterwards: the very
// first lookup has to pull the whole actor table before it can answer.
function castBlock(names, token) {
  const block = el('div', 'cast-block');
  block.appendChild(el('h3', null, 'Diễn viên'));
  const row = el('div', 'cast-row');
  names.forEach((name) => row.appendChild(castCard(name, '')));
  block.appendChild(row);

  window.api.cast({ names }).then((res) => {
    if (state.view !== token || !res.ok) return;
    row.innerHTML = '';
    res.data.people.forEach((person) => row.appendChild(castCard(person.name, person.photo)));
  });

  return block;
}

/* ---------------------------------------------------------- other seasons */

// The grid only ever shows one card per title, so the detail page is where the
// rest of the family has to be reachable — every season, and every print of the
// season being viewed.
function familyBlock(movie, token) {
  const block = el('div', 'server-block hidden');
  block.appendChild(el('h3', null, 'Các phần khác'));
  const row = el('div', 'ep-grid');
  block.appendChild(row);

  const keyword = baseName(movie.name);
  // The search this leans on is vsmov's, so it has nothing to say about a title
  // that came from elsewhere.
  if (keyword.length < 2 || movie.source === 'hh3d') return block;

  window.api.search({ keyword, limit: 50 }).then((res) => {
    if (state.view !== token || !res.ok) return;

    const key = familyKey(movie);
    const family = dedupe(res.data.items.filter((item) => familyKey(item) === key)).sort(
      (a, b) => seasonOf(a) - seasonOf(b) || betterCopy(a, b)
    );
    // The current title on its own is not "other parts", and neither is the same
    // release listed twice — both cases leave nothing worth showing.
    if (family.length < 2) return;

    family.forEach((item) => {
      const season = seasonOf(item);
      const btn = el('button', 'ep-btn season' + (item.slug === movie.slug ? ' playing' : ''));
      btn.appendChild(el('span', 'season-name', season ? 'Phần ' + season : item.name));
      const note = differenceNote(item, family);
      if (note) btn.appendChild(el('span', 'season-note', note));
      btn.onclick = () => openDetail(item.slug);
      row.appendChild(btn);
    });

    block.classList.remove('hidden');
  });

  return block;
}

/* ---------------------------------------------------------------- player */

const playerEl = $('#player');
const stage = $('#player-stage');
let playerCtx = null;

function openPlayer(movie, servers, serverIndex, epIndex, opts) {
  stopTrailer(); // nobody wants a trailer running behind the film
  playerCtx = { movie, servers, serverIndex, epIndex, ...(opts || {}) };
  /* Remembered past the closing of the player, because on a handset the player
     covers the whole screen: to reach the subtitle tab a viewer has to close the
     film first, and the file they pick there still belongs to it. */
  if (!playerCtx.trailer) state.lastFilm = { slug: movie.slug, name: movie.name };
  playerEl.classList.remove('hidden');
  $('#player-title').textContent = movie.name;
  drawPlayerSide();
  playEpisode(serverIndex, epIndex);
}

/* ---------------------------------------------------------------- trailer */

/* The catalogue gives trailers as YouTube watch links, in any of the three forms
   that site hands out. Only the id matters; the rest is rebuilt as an embed the
   player can mount like any other source. */
function youtubeId(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';

  return (
    (raw.match(/[?&]v=([\w-]{6,})/) || [])[1] ||
    (raw.match(/youtu\.be\/([\w-]{6,})/) || [])[1] ||
    (raw.match(/\/embed\/([\w-]{6,})/) || [])[1] ||
    ''
  );
}

/* Two ways to show a trailer, and the difference is adverts.

   The embed almost never carries a pre-roll, but it will not play unless the page
   holding it has a real origin — from file:// it answers "Error 153: video player
   configuration error". So the app serves that page itself, over loopback, and
   the embed is happy.

   The watch page needs no origin and always plays, but it comes with adverts that
   cannot be got rid of from outside: the player holds the speed at 1 and refuses
   to seek while one is running. It is the fallback, not the choice. */
/* Which of the two a platform gets depends on the origin its interface runs from.
   The phone and television shells serve theirs over a real https origin, so an
   ordinary iframe is all a trailer needs there — the embed is satisfied, and
   nothing native has to be placed or torn down. Electron's window is file://,
   where that same embed answers "Error 153" and stops, so the desktop keeps its
   guest view pointed at the app's own loopback page. */
function trailerPlayer(id) {
  /* An embed inside a frame refuses to play unless it can see an origin it
     trusts above it, and neither shell has one to offer: Android serves the
     interface from appassets.androidplatform.net, iOS from a scheme of its own,
     and both get "Error 153" for their trouble — the same answer the desktop got
     from file://. Loaded as a page in its own right there is no embedder to
     check, so the embed plays, and being the embed it comes without adverts. */
  if (window.WiSNative) {
    const guest = document.createElement('webview');
    if (window.WiSGuest) window.WiSGuest.attach(guest);
    guest.setAttribute('partition', 'persist:trailer');
    guest.setAttribute(
      'src',
      `https://www.youtube-nocookie.com/embed/${id}` +
        '?autoplay=1&mute=1&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3&cc_load_policy=0'
    );
    // Sound, once it is running — muted is the only way it is allowed to start.
    guest.addEventListener('dom-ready', () => startTrailer(guest));
    return guest;
  }

  const view = document.createElement('webview');
  /* Not handed to WiSGuest: on the shells that stands in for the film's player,
     and a trailer must not be able to take that over. Its own partition, too —
     guests sharing one share a renderer, and a busy YouTube page left the film's
     own guest waiting to come up. */
  view.setAttribute('partition', 'persist:trailer');
  view.setAttribute('allowpopups', 'false');
  view.addEventListener('dom-ready', () => startTrailer(view));
  trailerSource(id).then((src) => {
    if (view.isConnected) view.setAttribute('src', src);
  });
  return view;
}

let trailerHost = null;

async function trailerSource(id) {
  if (trailerHost === null) {
    const res = await window.api.trailerBase().catch(() => null);
    trailerHost = (res && res.ok && res.data.base) || '';
  }
  return trailerHost ? `${trailerHost}/t?v=${id}` : `https://www.youtube.com/watch?v=${id}`;
}

/* A trailer has one job and it is over the moment the viewer goes anywhere: to
   the film, back to the grid, or on to another title. Tearing the guest down
   rather than pausing it is what makes the sound stop for certain. */
function stopTrailer() {
  // Either kind: a guest view on the desktop, an iframe on the shells.
  const view = document.querySelector('.trailer-frame webview, .trailer-frame iframe');
  if (!view) return;

  if (view.executeJavaScript) {
    try {
      view
        .executeJavaScript('(() => { const v = document.querySelector("video"); if (v) { v.pause(); v.muted = true; } return true; })()')
        .catch(() => {});
    } catch {
      /* not up yet; removing it is enough */
    }
  } else if (view.contentWindow) {
    // An embed in a frame of its own takes commands by message; being removed
    // stops it anyway, but a paused player makes no sound on the way out.
    try {
      view.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*');
    } catch {
      /* another origin and not listening: the removal below is enough */
    }
  }

  view.remove();
}

/* Everything around the player on a watch page — masthead, recommendations,
   comments — is weight nobody in a 16:9 box asked for. The player itself is
   pinned over the lot. */
const TRAILER_SKIN = `
  html, body { background: #000 !important; overflow: hidden !important; }
  ytd-masthead, #masthead-container, #secondary, #below, #comments,
  ytd-comments, tp-yt-app-drawer, #chat, ytd-merch-shelf-renderer { display: none !important; }
  ytd-app, #content, #page-manager, ytd-watch-flexy, #columns, #primary, #primary-inner,
  #player-theater-container, #full-bleed-container {
    margin: 0 !important; padding: 0 !important; max-width: none !important;
  }
  #player-container-outer, #player-container-inner, #player, #movie_player,
  .html5-video-player, ytd-player {
    position: fixed !important; inset: 0 !important;
    width: 100vw !important; height: 100vh !important; max-width: none !important;
    z-index: 2147483000 !important;
  }
  /* The picture sits two boxes deep and both are sized by the player's own
     script. Telling the video to be 100% high while the box holding it is zero
     high is how it ends up drawing nothing: sound, controls, no image. Each box
     is pinned to the frame, so neither can collapse. */
  .html5-video-container {
    position: absolute !important; inset: 0 !important;
    width: 100% !important; height: 100% !important;
  }
  video, video.video-stream {
    position: absolute !important; inset: 0 !important;
    width: 100% !important; height: 100% !important;
    /* The box outside is given the shape of the lit part of the picture, so
       covering it crops the baked-in bands away rather than squashing anything —
       see fitTrailerFrame. */
    object-fit: cover !important;
  }
`;

/* Adverts cannot be blocked by address here: they arrive from the same servers
   the picture does. What can be done is what a viewer does — press skip, and when
   there is nothing to press, run the advert to its end, which is a fraction of a
   second and lets the clip start. */
const AD_SKIPPER = `(() => {
  if (window.__wisAdSkip) return 'already';
  window.__wisAdSkip = true;

  const hide = document.createElement('style');
  hide.textContent = '.ytp-ad-overlay-container, .ytp-ad-module, .ytp-ad-image-overlay,' +
    ' #player-ads, ytd-action-companion-ad-renderer, ytd-promoted-video-renderer' +
    ' { display: none !important; }';
  (document.head || document.documentElement).appendChild(hide);

  const skip = () => {
    const player = document.querySelector('#movie_player');
    const v = document.querySelector('video');
    if (!player || !v) return;

    if (player.classList.contains('ad-showing')) {
      const button = document.querySelector(
        '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-survey-answer-button'
      );
      if (button) return button.click();

      /* Nothing to press — an unskippable advert, and this one runs for nearly
         two minutes. Seeking is refused during adverts, but the speed is not: at
         sixteen times, silently, it is over in seconds. */
      if (v.playbackRate < 16) v.playbackRate = 16;
      v.muted = true;
      return;
    }

    // The film again: give it back its speed, and its sound if it had any.
    if (v.playbackRate !== 1) v.playbackRate = 1;
    if (v.muted && window.__wisWantSound) v.muted = false;
  };

  setInterval(skip, 400);
  skip();
  return 'skipping';
})()`;

/* Sound is given back from inside the page — this Chromium is told not to wait
   for a gesture — and the player is nudged a few times, since the script that
   builds it arrives well after the document is ready. */
/* Trailers are not 16:9. This one is 640x266, and a 16:9 box around it leaves a
   black band above and below — the letterboxing the viewer objected to. Rather
   than cropping the sides or stretching the picture out of shape, the box is
   given the clip's own proportions, so the picture fills it exactly. */
/* What shape the picture really is. The stream says 640x360 whether or not the
   film inside it is wider than that: a 2.39:1 trailer arrives as a 16:9 stream
   with the black bands baked into the frames, and no property of the video
   element admits it. The only way to know is to look at the pixels — so a frame
   is drawn to a small canvas and the dark rows at the top and bottom are counted.
   The box is then given the shape of what is actually lit, and the picture is
   cropped to fill it, which puts the bands outside the frame instead of inside. */
const MEASURE_BANDS = `(() => {
  const v = document.querySelector('video');
  if (!v || !v.videoWidth || v.readyState < 2) return null;

  const w = 32, h = 90;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  try { ctx.drawImage(v, 0, 0, w, h); } catch { return null; }

  const rows = ctx.getImageData(0, 0, w, h).data;
  const dark = (y) => {
    let sum = 0;
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; sum += (rows[i] + rows[i+1] + rows[i+2]) / 3; }
    return sum / w < 10;
  };

  let top = 0;
  while (top < h / 3 && dark(top)) top++;
  let bottom = 0;
  while (bottom < h / 3 && dark(h - 1 - bottom)) bottom++;

  return { w: v.videoWidth, h: v.videoHeight, top: top / h, bottom: bottom / h };
})()`;

function fitTrailerFrame(view) {
  let shape = '';
  let steady = 0;

  const timer = setInterval(async () => {
    if (!view.isConnected) return clearInterval(timer);

    const seen = await view.executeJavaScript(MEASURE_BANDS).catch(() => null);
    if (!seen) return;

    // Bands are symmetrical; a dark scene is not, and neither is a fade.
    const band = Math.min(seen.top, seen.bottom);
    const lit = Math.max(0.4, 1 - band * 2);
    const next = `${seen.w} / ${Math.round(seen.h * lit)}`;

    if (next === shape) {
      steady = 0;
      return;
    }
    // Two readings agreeing, so a single dark frame cannot reshape the box.
    if (++steady < 2) return;
    steady = 0;
    shape = next;

    const box = view.closest('.trailer-frame');
    if (box) box.style.aspectRatio = next;
  }, 1200);
}

function startTrailer(view) {
  view.insertCSS(TRAILER_SKIN).catch(() => {});
  view.executeJavaScript(AD_SKIPPER).catch(() => {});
  fitTrailerFrame(view);
  // The player measures itself on resize, and it has just been given a new box.
  view.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
  view
    .executeJavaScript(
      `(() => {
        if (window.__wisTrailer) return 'already';
        window.__wisTrailer = true;

        const go = () => {
          const v = document.querySelector('video');
          if (!v) {
            const btn = document.querySelector('.ytp-large-play-button');
            if (btn) btn.click();
            return false;
          }
          v.muted = false;
          // What the advert skipper restores once the advert is out of the way.
          window.__wisWantSound = true;
          const started = v.play();
          if (started && started.catch) {
            // Sound was refused after all: running quietly beats not running.
            started.catch(() => { v.muted = true; v.play().catch(() => {}); });
          }
          return !v.paused;
        };

        go();
        let tries = 0;
        const timer = setInterval(() => {
          const v = document.querySelector('video');
          if ((v && !v.paused && v.currentTime > 0) || ++tries > 14) return clearInterval(timer);
          go();
        }, 700);
        return 'started';
      })()`,
      true
    )
    .catch(() => {});
}

function drawPlayerSide() {
  const tabs = $('#server-tabs');
  tabs.innerHTML = '';
  playerCtx.servers.forEach((server, index) => {
    const btn = el('button', index === playerCtx.serverIndex ? 'active' : null, cleanServerName(server.server_name));
    btn.onclick = () => {
      playerCtx.serverIndex = index;
      drawPlayerSide();
      const target = Math.min(playerCtx.epIndex, server.server_data.length - 1);
      // Changing source mid-film should carry the position across; landing on a
      // different episode obviously should not.
      playEpisode(index, target, target === playerCtx.epIndex);
    };
    tabs.appendChild(btn);
  });
  drawPlayerEpisodes();
}

function drawPlayerEpisodes() {
  const list = $('#ep-list');
  list.innerHTML = '';
  const server = playerCtx.servers[playerCtx.serverIndex];
  server.server_data.forEach((ep, index) => {
    const btn = el(
      'button',
      'ep-btn' + (index === playerCtx.epIndex ? ' playing' : ''),
      ep.name || ep.filename || 'Tập ' + (index + 1)
    );
    btn.onclick = () => playEpisode(playerCtx.serverIndex, index);
    list.appendChild(btn);
  });
}

function playEpisode(serverIndex, epIndex, keepPosition = false) {
  const server = playerCtx.servers[serverIndex];
  const ep = server.server_data[epIndex];
  if (!ep || !ep.link_embed) return;

  playerCtx.serverIndex = serverIndex;
  playerCtx.epIndex = epIndex;
  // Picking a source by hand is the viewer taking over again, so a dismissed
  // recovery no longer holds.
  playerCtx.muted = false;
  if (!keepPosition) {
    playerCtx.retries = 0;

    /* Where this episode was left off. Jumping there without being asked is the
       thing that was complained about, so it only happens when the viewer has
       said they want the automatic tua; otherwise the film starts at the
       beginning and the offer sits in the notice, one click away. */
    const saved = resumeFor(playerCtx.movie.slug, epIndex);
    playerCtx.resumeAt = state.store.skipIntro ? saved : 0;
    playerCtx.offerResume = !state.store.skipIntro && saved > 20 ? saved : 0;
  }

  $('#player-ep').textContent = 'Đang phát: ' + (ep.name || ep.filename || '');
  drawPlayerEpisodes();

  mountPlayerView(ep.link_embed);
  // A trailer is not something the viewer was watching, so it stays out of the
  // history and out of the way of where they actually left off.
  if (!playerCtx.trailer) rememberWatch(playerCtx.movie, serverIndex, epIndex, ep.name || ep.filename || '');
}

/* ------------------------------------------------- keeping the stream alive */

/* A stream drops out in ways the host window cannot see: the guest stays
   attached and keeps painting its last frame. The only reliable signal is the
   guest's own <video> — if its clock stops advancing while it claims to be
   playing, the connection is gone. Recovery is a fresh mount at the same
   position, and after a few failed goes, the next server. */

const STALL_MS = 15000;
const PROBE_MS = 3000;
const MAX_RETRIES = 3;

// HH3D hands its stream to a player living in a frame of its own, so the picture
// the watchdog has to watch is not always in the page it can reach directly.
const FIND_VIDEO = `const findVideo = (doc) => {
  const own = doc.querySelector('video');
  if (own) return own;
  for (const frame of doc.querySelectorAll('iframe')) {
    try {
      const inner = frame.contentDocument && findVideo(frame.contentDocument);
      if (inner) return inner;
    } catch { /* another origin: not ours to read */ }
  }
  return null;
};`;

const PROBE_VIDEO = `(() => {
  ${FIND_VIDEO}
  const v = findVideo(document);
  if (!v) return null;
  return { at: v.currentTime, paused: v.paused, ended: v.ended };
})()`;

let watchdog = null;

const currentEmbed = () => {
  const server = playerCtx && playerCtx.servers[playerCtx.serverIndex];
  const ep = server && server.server_data[playerCtx.epIndex];
  return (ep && ep.link_embed) || '';
};

// A drop is the one moment the viewer has an opinion, so the notice carries the
// choices with it instead of only saying what happened.
function showPlayerNotice(message, opts) {
  const { sticky = false, actions = [], kind = 'recovery', hold = 0 } = opts || {};
  const notice = $('#player-notice');
  notice.innerHTML = '';
  notice.dataset.kind = kind;
  clearTimeout(showPlayerNotice.timer);

  if (!message) {
    showPlayerNotice.actions = [];
    if (window.WiSGuest && window.WiSGuest.notice) window.WiSGuest.notice('', []);
    return notice.classList.add('hidden');
  }

  notice.appendChild(el('span', 'notice-text', message));
  actions.forEach((action) => {
    const btn = el('button', 'notice-act', action.label);
    btn.onclick = () => {
      showPlayerNotice('');
      action.run();
    };
    notice.appendChild(btn);
  });
  notice.classList.remove('hidden');

  // A native view covers the stage on Android, so the shell draws this one and
  // reports back which button was pressed.
  if (window.WiSGuest && window.WiSGuest.notice) {
    showPlayerNotice.actions = actions;
    window.WiSGuest.notice(message, actions.map((action) => action.label));
  }

  // Anything the viewer can act on waits for them; plain news does not. A hold
  // is the middle case: controls worth noticing, not worth keeping on the film.
  if (hold) {
    showPlayerNotice.timer = setTimeout(() => notice.classList.add('hidden'), hold);
  } else if (!sticky && !actions.length) {
    showPlayerNotice.timer = setTimeout(() => notice.classList.add('hidden'), 4000);
  }
}

// Being told over and over is the thing to escape from: this stops the
// reconnecting until the viewer picks an episode or a server themselves.
// The shell's own notice buttons answer here, by the order they were given.
window.__wisNoticeAction = (index) => {
  const action = (showPlayerNotice.actions || [])[index];
  if (!action) return;
  showPlayerNotice('');
  action.run();
};

function dismissRecovery() {
  if (playerCtx) playerCtx.muted = true;
}

// A source that has stopped answering is worth a couple more goes before the
// whole server is written off, since most drops are the connection, not the file.
function nextServerFor(epIndex) {
  const { servers, serverIndex } = playerCtx;
  for (let step = 1; step < servers.length; step++) {
    const index = (serverIndex + step) % servers.length;
    const ep = (servers[index].server_data || [])[epIndex];
    if (ep && ep.link_embed) return index;
  }
  return -1;
}

// Jumping source on demand, without waiting out the reconnect attempts.
function switchServerNow() {
  if (!playerCtx) return;
  const next = nextServerFor(playerCtx.epIndex);
  if (next === -1) {
    return showPlayerNotice('Tập này chỉ có một server.', {
      sticky: true,
      actions: [{ label: 'Bỏ qua', run: dismissRecovery }],
    });
  }
  playerCtx.retries = 0;
  playerCtx.serverIndex = next;
  drawPlayerSide();
  playEpisode(next, playerCtx.epIndex, true);
}

function retryNow() {
  if (!playerCtx) return;
  playerCtx.retries = 0;
  playerCtx.muted = false;
  const url = currentEmbed();
  if (url) mountPlayerView(url);
}

// Hand the decision over and wait: nothing moves until the viewer says so.
function askRecovery(message) {
  const actions = [{ label: 'Thử lại', run: retryNow }];
  if (nextServerFor(playerCtx.epIndex) !== -1) actions.push({ label: 'Đổi server', run: switchServerNow });
  actions.push({ label: 'Bỏ qua', run: dismissRecovery });
  showPlayerNotice(message, { sticky: true, actions });
}

function recoverPlayback(reason) {
  if (!playerCtx || playerCtx.muted) return;

  // Reconnecting to the same source is invisible when it works. Changing the
  // source is not — the picture jumps, so that one is never taken automatically.
  if (!state.store.autoRecover) return askRecovery(reason + ' — chọn cách xử lý:');

  playerCtx.retries = (playerCtx.retries || 0) + 1;
  if (playerCtx.retries > MAX_RETRIES) return askRecovery('Không kết nối được nguồn phát.');

  const url = currentEmbed();
  if (!url) return;

  const actions = [];
  if (nextServerFor(playerCtx.epIndex) !== -1) actions.push({ label: 'Đổi server', run: switchServerNow });
  actions.push({ label: 'Bỏ qua', run: dismissRecovery });
  showPlayerNotice(`${reason} — đang kết nối lại (${playerCtx.retries}/${MAX_RETRIES})…`, {
    sticky: true,
    actions,
  });
  mountPlayerView(url);
}

// Coming back from a drop should land where the picture stopped.
function restorePosition(view) {
  const at = Math.floor((playerCtx && playerCtx.resumeAt) || 0);
  if (at < 5) return;

  view
    .executeJavaScript(
      `(() => {
        ${FIND_VIDEO}
        const v = findVideo(document);
        if (!v) return false;
        const seek = () => { try { v.currentTime = ${at}; v.play(); } catch {} };
        if (v.readyState >= 1) seek();
        else v.addEventListener('loadedmetadata', seek, { once: true });
        return true;
      })()`
    )
    .catch(() => {});
}

function watchPlayback(view) {
  clearInterval(watchdog);
  let lastAt = -1;
  let stuckSince = 0;
  let goodTicks = 0;

  watchdog = setInterval(async () => {
    // The stage was torn down or replaced: this watchdog is watching nothing.
    if (!playerCtx || currentPlayerView() !== view) return clearInterval(watchdog);

    let probe = null;
    try {
      probe = await view.executeJavaScript(PROBE_VIDEO);
    } catch {
      return; // guest busy or navigating; the next tick will tell
    }

    // Paused on purpose, finished, or the player has not built its <video> yet.
    if (!probe || probe.paused || probe.ended) {
      stuckSince = 0;
      return;
    }

    if (probe.at > lastAt + 0.05) {
      lastAt = probe.at;
      stuckSince = 0;
      goodTicks++;
      playerCtx.resumeAt = probe.at;
      saveProgress(probe.at);
      playerCtx.retries = 0; // it is playing again; earlier drops no longer count
      // Two clean ticks, not one: a seek or a single decoded frame is not the
      // picture coming back, and taking the choice away too early is worse than
      // leaving it up a few seconds longer. Only the drop notice goes — the
      // subtitle one is not about the connection and has nothing to do with this.
      const notice = $('#player-notice');
      if (goodTicks >= 2 && notice.dataset.kind === 'recovery' && notice.querySelector('.notice-act')) {
        showPlayerNotice('');
      }
      return;
    }

    goodTicks = 0;
    if (!stuckSince) stuckSince = Date.now();
    if (Date.now() - stuckSince >= STALL_MS) {
      stuckSince = 0;
      recoverPlayback('Mất kết nối');
    }
  }, PROBE_MS);
}

// The guest page measures itself once, when it attaches, so the stage must
// already have a resolved size — otherwise the player latches onto the default
// 300x150 and never re-measures. Reading the stage box forces that layout pass
// synchronously; deferring the src via requestAnimationFrame would not, because
// Chromium stops firing frame callbacks whenever the window is not visible,
// which left the stream silently unassigned.
function mountPlayerView(url) {
  dropPlayerView();
  const view = document.createElement('webview');
  // On Android the guest is a native view standing where this element ends up;
  // attaching teaches the element the same calls Electron's <webview> answers.
  if (window.WiSGuest) window.WiSGuest.attach(view);
  view.setAttribute('partition', 'persist:player');
  view.setAttribute('allowpopups', 'false');
  view.setAttribute('src', url);

  stage.getBoundingClientRect();
  stage.appendChild(view);

  view.addEventListener('dom-ready', () => {
    nudgeGuestResize(view);
    applyStretching(view);

    /* A trailer is a clip on someone else's player: none of what follows applies
       to it. Its ads would look like a stall to the drop detector, it has no
       subtitles of ours to draw, and there is no position to restore. */
    if (playerCtx && playerCtx.trailer) {
      relayGuestKeys(view);
      watchGuestKeys();
      return;
    }

    skinGuest(view);
    guardGuestSeek(view);
    applyGuestPrefs(view);
    // The subtitle files belong to the guest, so the list can only be read once
    // it is up; the choice made earlier carries over.
    window.WiSSubs
      .attach(view, state.store.subLang, playerCtx.movie.slug, state.store.subPos)
      .then(() => restoreSubtitle())
      .catch(() => {});
    restorePosition(view);
    watchPlayback(view);
    // Nothing can be injected before this point: the guest is not there to
    // listen yet.
    relayGuestKeys(view);
    watchGuestKeys();
    watchAddedSubtitles();
    offerResume();
  });

  // The guest failing outright is the one drop the host can see directly.
  // -3 is the abort Chromium reports for a navigation we replaced ourselves.
  view.addEventListener('did-fail-load', (event) => {
    if (!event.isMainFrame || event.errorCode === -3) return;
    recoverPlayback('Không tải được nguồn phát');
  });
  view.addEventListener('render-process-gone', () => recoverPlayback('Trình phát dừng đột ngột'));
  view.addEventListener('crashed', () => recoverPlayback('Trình phát dừng đột ngột'));

  /* The player's own fullscreen button is left alone. Taking it over — exiting
     the guest's fullscreen and going to ours instead — is what broke it, and it
     is no longer needed for anything: the subtitle line is drawn inside the
     player's frame, so it is part of what gets blown up either way. */

  return view;
}

/* Keys pressed while the picture has the focus are the guest's, and there is no
   way for it to hand them over. What it can do is write them down where the host
   can read them, which is what this pair does — the same trick as the seek
   guard, and the reason Esc still leaves fullscreen when the film has the focus. */
function relayGuestKeys(view) {
  view
    .executeJavaScript(
      `(() => {
        if (window.__wisKeys) return 'already';
        window.__wisKeys = [];
        addEventListener('keydown', (event) => {
          if (['Escape', 'f', 'F'].includes(event.key)) return window.__wisKeys.push(event.key);
          // Shift with the arrows belongs to the subtitle: where it sits, and
          // whether it runs early or late. The film keeps the plain arrows.
          if (!event.shiftKey) return;
          const token = {
            ArrowUp: 'SUB_UP', ArrowDown: 'SUB_DOWN',
            ArrowLeft: 'SUB_EARLIER', ArrowRight: 'SUB_LATER',
          }[event.key];
          if (!token) return;
          event.preventDefault();
          window.__wisKeys.push(token);
        }, true);

        return 'listening';
      })()`
    )
    .catch(() => {});
}

let keyRelay = null;

function watchGuestKeys() {
  clearInterval(keyRelay);
  keyRelay = setInterval(async () => {
    const view = currentPlayerView();
    if (!view || !playerCtx) return;
    let keys = [];
    try {
      keys = await view.executeJavaScript('(window.__wisKeys || []).splice(0)');
    } catch {
      return; // the guest is busy; the next tick will do
    }
    (keys || []).forEach((key) => {
      if (key === 'SUB_UP') return moveSubtitle(2);
      if (key === 'SUB_DOWN') return moveSubtitle(-2);
      if (key === 'SUB_EARLIER') return nudgeSubtitle(-0.5);
      if (key === 'SUB_LATER') return nudgeSubtitle(0.5);
      if (key === 'Escape') {
        if (playerEl.classList.contains('immersive')) return toggleFullscreen(false);
        return closePlayer();
      }
      toggleFullscreen();
    });
  }, 300);
}

function nudgeGuestResize(view) {
  try {
    view.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
  } catch {
    /* guest not attached yet */
  }
}

/* A wider-than-16:9 print gets letterboxed by the embedded player: black bands
   above and below. Two ways out of that, and they are not the same thing —
   "fill" zooms until the frame is covered, which takes the sides off the picture,
   while "exactfit" pulls the height to the frame and leaves the width where it
   is. Nothing should ever be cropped away, so it is the second one. */
function applyStretching(view) {
  const mode = state.store.fillFrame ? 'exactfit' : 'uniform';
  try {
    view
      .executeJavaScript(
        `(() => { try { jwplayer().setConfig({ stretching: '${mode}' }); return true; } catch { return false; } })()`
      )
      .catch(() => {});
  } catch {
    /* guest not attached yet */
  }
}

/* HH3D has no embed of its own: the thing that knows how to ask for a stream is
   the site's own watch page, so that whole page is what gets mounted. Pinning its
   player over the top turns a web page back into a player without touching how it
   loads the film. */
const HH3D_SKIN = `
  html, body { background: #000 !important; overflow: hidden !important; }
  #halim-player-wrapper, #halim-full-player, .halim-full-player {
    position: fixed !important; inset: 0 !important;
    width: 100vw !important; height: 100vh !important;
    max-width: none !important; margin: 0 !important; padding: 0 !important;
    background: #000 !important; z-index: 2147483000 !important;
  }
  .halim-player-aspect, .playerjs-mount-slot, .halim-playerjs-host {
    height: 100% !important; width: 100% !important; padding-top: 0 !important;
  }
  #halim-player-wrapper video, #halim-player-wrapper iframe { width: 100% !important; height: 100% !important; }
  /* Sliders, marquees and hover effects on a page nobody sees still cost frames
     the decoder wants. */
  *:not(video) { animation: none !important; transition: none !important; }
`;

/* hoathinh3d ships switches of its own — "bỏ qua giới thiệu" and "chuyển tập tự
   động" — both on by default, and they are what jumps the opening and moves to
   the next tập without being asked. Each lives in the guest's own localStorage,
   so the preference is written there and the site's button is nudged to match
   for the page already on screen. The player builds late, hence the polling. */
const GUEST_SWITCHES = [
  { store: 'skipIntro', key: 'halim_auto_skip_intro', btn: 'autoSkipIntroToggleBtn' },
  { store: 'autoNext', key: 'halim_auto_next_episode', btn: 'autoNextToggleBtn' },
];

/* The switches above are not the whole story. hoathinh3d also stores a
   resumeTime per tập and has its player seek there the moment the file loads
   (Actions.LoadedData → Seek), so a tập you had already started jumps straight
   past its opening no matter how the switches are set. The jump happens inside
   the guest before anything we could call from here, so the only place to stand
   is in front of the seek itself: the first jump away from zero that we did not
   ask for is redirected to where WiSFilm wants to be. Anything the viewer does
   by hand disarms it. */
function guardGuestSeek(view) {
  if (!playerCtx || playerCtx.movie.source !== 'hh3d') return;
  if (state.store.skipIntro) return; // the viewer asked for the site's jump
  const want = Math.floor(playerCtx.resumeAt || 0);

  view
    .executeJavaScript(
      `(() => {
        if (window.__wisSeekGuard) return 'already';
        const proto = HTMLMediaElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'currentTime');
        if (!desc || !desc.set) return 'no-descriptor';
        window.__wisSeekGuard = true;

        const want = ${want};
        let armed = true;
        const disarm = () => { armed = false; };

        Object.defineProperty(proto, 'currentTime', {
          configurable: true,
          get: desc.get,
          set(value) {
            const now = desc.get.call(this);
            // A jump out of the opening seconds that lands somewhere else is the
            // page restoring itself; the viewer's own seeks come later, off a
            // clock that is already running.
            if (armed && now < 3 && Math.abs(value - want) > 3) return desc.set.call(this, want);
            desc.set.call(this, value);
          },
        });

        // The host asks for one deliberate jump when the viewer takes up where
        // they left off; that is not the page restoring itself.
        window.__wisDisarmSeek = disarm;

        ['pointerdown', 'keydown', 'wheel'].forEach((type) =>
          document.addEventListener(type, disarm, { capture: true, once: true })
        );
        setTimeout(disarm, 60000);
        return 'guarded';
      })()`
    )
    .catch(() => {});
}

function applyGuestPrefs(view) {
  if (!playerCtx || playerCtx.movie.source !== 'hh3d') return;
  const wants = GUEST_SWITCHES.map((sw) => ({
    key: sw.key,
    btn: sw.btn,
    want: state.store[sw.store] ? 'true' : 'false',
  }));

  view
    .executeJavaScript(
      `(() => {
        const wants = ${JSON.stringify(wants)};
        const save = (w) => { try { localStorage.setItem(w.key, w.want); } catch {} };

        /* The switch is the authority, not the key: the site's click handler reads
           the stored value to decide which way to flip, so writing first sends the
           click the wrong way. Click until the button reads what we want, then
           store it — that is the state the next tập starts from. */
        const settle = (w, tries) => {
          const btn = document.getElementById(w.btn);
          if (!btn) {
            if (tries < 24) return setTimeout(() => settle(w, tries + 1), 500);
            return save(w); // no switch on this page; at least the next load starts right
          }
          if (btn.getAttribute('aria-pressed') === w.want || tries > 28) return save(w);
          btn.click();
          setTimeout(() => settle(w, tries + 1), 400);
        };

        wants.forEach((w) => settle(w, 0));
        return true;
      })()`
    )
    .catch(() => {});
}

function skinGuest(view) {
  if (!playerCtx || playerCtx.movie.source !== 'hh3d') return;
  // CSS "fill" is the stretch, not the crop — the opposite of what the word means
  // in jwplayer's stretching option. Cropping would be "cover", and is not wanted.
  const fit = state.store.fillFrame ? 'fill' : 'contain';
  view.insertCSS(HH3D_SKIN + `\n#halim-player-wrapper video { object-fit: ${fit} !important; }`).catch(() => {});
}

/* ------------------------------------------------------------------ phụ đề */

/* The page's own captions work, and its own button for adding one is the one to
   use — neither is replaced here. What that button cannot do is show the file it
   just took: the script behind it puts captions back to Off a moment later. So
   the list is watched, and when a subtitle turns up that was not there when the
   film opened, WiSFilm draws that one — inside the player's frame, so it behaves
   like the page's own line, and the page's copy is hidden only while it does.
   The notice carries the two things worth changing afterwards. */

let subWatch = null;
let subsIntroduced = false; // the controls say hello once per film, not per track

function subtitleControls() {
  return [
    { label: '▲', run: () => moveSubtitle(2) },
    { label: '▼', run: () => moveSubtitle(-2) },
    { label: '−0,5s', run: () => nudgeSubtitle(-0.5) },
    { label: '+0,5s', run: () => nudgeSubtitle(0.5) },
    { label: 'Tắt', run: () => window.WiSSubs.pick('off') },
  ];
}

// The panel is gone, so the two things worth changing about a subtitle ride on
// the notice itself: where the line sits, and whether it runs early or late.
function subtitleNotice(message) {
  showPlayerNotice(message, { sticky: true, actions: subtitleControls(), kind: 'subs' });
}

/* ------------------------------------------------- phụ đề đã thêm, giữ lại */

/* Only the ones brought in from outside are kept. A film's own tracks live on
   its page and will be there next time; a file the viewer attached exists
   nowhere else once the player has thrown its blob away. */

const subsFor = (slug) => (state.store.subs || []).filter((entry) => entry.film === slug);

/* film is passed when there is no player open — a file added from the tab after
   the viewer came out of the film it belongs to. */
function rememberSubtitle(film, cues, name) {
  const owner = film || (playerCtx && playerCtx.movie);
  if (!owner) return;

  const track = cues ? { name, cues, offset: 0 } : window.WiSSubs.activeTrack();
  if (!track) return;

  const entry = {
    film: owner.slug,
    filmName: owner.name || owner.slug,
    name: track.name,
    addedAt: new Date().toISOString(),
    offset: track.offset || 0,
    cues: track.cues,
  };

  const kept = (state.store.subs || []).filter((held) => !(held.film === entry.film && held.name === entry.name));
  state.store.subs = [entry, ...kept].slice(0, 24);
  saveStore();
}

/* The picker's own end of it: read the file, draw it, keep it for this film. The
   input lives outside the tab so the tab can be redrawn without losing it. */
$('#sub-file').onchange = async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = ''; // the same file again should still count as a change
  if (!file) return;

  const owner = (playerCtx && playerCtx.movie) || state.lastFilm;
  if (!owner) {
    showPlayerNotice('Mở một phim trước rồi hãy thêm phụ đề.');
    return;
  }

  const text = await file.text();

  /* With the film on screen the file goes straight on. Off screen — which is how
     it happens on a handset, where reaching this tab means leaving the film — it
     is only parsed and kept, and it goes on by itself the next time that film is
     opened. */
  if (playerCtx) {
    const res = await window.WiSSubs.addFile(file.name, text);
    if (!res.ok) return showPlayerNotice('Tệp này không đọc được (chỉ nhận .srt hoặc .vtt).');
    rememberSubtitle();
    subtitleNotice(`Đã nạp phụ đề từ tệp (${res.cues} dòng).`);
  } else {
    const cues = window.WiSSubs.parse(text);
    if (!cues.length) return showPlayerNotice('Tệp này không đọc được (chỉ nhận .srt hoặc .vtt).');
    rememberSubtitle(owner, cues, 'Tệp: ' + file.name);
    showPlayerNotice(`Đã lưu phụ đề cho ${owner.name} (${cues.length} dòng) — mở phim là tự bật.`);
  }

  if (state.view && state.view.kind === 'subs') renderSubsTab();
};

// Opening a film it was attached to: the newest one goes straight on, so nobody
// has to find the file again.
async function restoreSubtitle() {
  if (!playerCtx) return false;
  const saved = subsFor(playerCtx.movie.slug);
  if (!saved.length) return false;

  const res = await window.WiSSubs.useSaved(saved[0]);
  if (!res.ok) return false;
  subsIntroduced = true;
  showPlayerNotice(`Đã dùng phụ đề đã lưu: ${saved[0].name} (${res.cues} dòng)`, {
    actions: subtitleControls(),
    kind: 'subs',
    hold: 7000,
  });
  return true;
}

function moveSubtitle(by) {
  const pos = window.WiSSubs.move(by);
  state.store.subPos = pos;
  saveStore();
  subtitleNotice(`Phụ đề cách đáy ${pos}% khung`);
}

function nudgeSubtitle(by) {
  const offset = window.WiSSubs.nudge(by);
  subtitleNotice(`Phụ đề lệch ${offset.toFixed(1)}s`);
}

/* Coming back to a film that was left part-way: the offer, rather than the jump.
   One click goes there, and the film keeps playing from the start meanwhile. */
function offerResume() {
  if (!playerCtx || !playerCtx.offerResume) return;
  const at = playerCtx.offerResume;
  playerCtx.offerResume = 0;

  showPlayerNotice(`Lần trước bạn xem tới ${asClock(at)}`, {
    kind: 'resume',
    sticky: true,
    actions: [
      {
        label: 'Xem tiếp',
        run: () => {
          const view = currentPlayerView();
          if (!view) return;
          playerCtx.resumeAt = at;
          view
            .executeJavaScript(
              `(() => {
                const v = document.querySelector('video');
                if (!v) return false;
                v.currentTime = ${Math.floor(at)};
                v.play();
                return true;
              })()`,
              true
            )
            .catch(() => {});
        },
      },
      { label: 'Xem từ đầu', run: () => {} },
    ],
  });
}

function watchAddedSubtitles() {
  clearInterval(subWatch);
  subsIntroduced = false;
  subWatch = setInterval(async () => {
    if (!playerCtx || !currentPlayerView()) return;
    const fresh = await window.WiSSubs.refresh().catch(() => ({ added: [] }));
    if (!fresh.added.length) return;

    /* A batch of them is the film's own list arriving late, and the language last
       watched in is the one to take. A single one arriving on its own is a file
       just attached, so that is simply it. */
    const tracks = window.WiSSubs.list();
    const want = state.store.subLang;
    const preferred =
      fresh.added.length > 1 && want && want !== 'off'
        ? fresh.added.find((id) => {
            const track = tracks.find((t) => t.id === id) || {};
            return track.lang === want || String(track.label || '').toLowerCase() === String(want).toLowerCase();
          })
        : null;

    const first = !subsIntroduced;
    subsIntroduced = true;
    const res = await window.WiSSubs.pick(preferred || fresh.added[fresh.added.length - 1]);
    if (!res.ok) return showPlayerNotice('Không đọc được phụ đề này.');

    // A subtitle that turned up on its own is one the viewer attached, and worth
    // keeping: next time this film opens it is already there.
    if (!preferred) rememberSubtitle();

    // The controls introduce themselves once, then keep out of the picture.
    if (first) {
      showPlayerNotice('Phụ đề: ▲▼ đổi vị trí · Shift+↑↓ bất cứ lúc nào', {
        actions: subtitleControls(),
        kind: 'subs',
        hold: 7000,
      });
    } else {
      subtitleNotice(`Đang chạy phụ đề bạn vừa gắn (${res.cues} dòng).`);
    }
  }, 2500);
}

function currentPlayerView() {
  return stage.querySelector('webview');
}

// Only the guest goes: the stage also holds the reconnect notice, which has to
// survive the remount that put it on screen in the first place.
function dropPlayerView() {
  const view = currentPlayerView();
  if (view) view.remove();
}

function syncFillButton() {
  $('#player-fill').classList.toggle('active', !!state.store.fillFrame);
  const auto = $('#player-auto');
  auto.classList.toggle('active', !!state.store.autoRecover);
  auto.title = state.store.autoRecover
    ? 'Tự động kết nối lại: BẬT (bấm để tự chọn mỗi lần mất kết nối)'
    : 'Tự động kết nối lại: TẮT (app sẽ hỏi thay vì tự xử lý)';

  const intro = $('#player-intro');
  intro.classList.toggle('active', !!state.store.skipIntro);
  intro.title = state.store.skipIntro
    ? 'Tự tua khi mở tập: BẬT (bỏ qua giới thiệu / nhảy tới chỗ xem dở)'
    : 'Tự tua khi mở tập: TẮT — luôn bắt đầu từ đầu tập';

  const next = $('#player-next');
  next.classList.toggle('active', !!state.store.autoNext);
  next.title = state.store.autoNext
    ? 'Tự động chuyển tập: BẬT (bấm để hết tập thì dừng lại)'
    : 'Tự động chuyển tập: TẮT — hết tập sẽ dừng, bạn tự chọn tập sau';
}

// Both switches belong to the guest page, so flipping one is the same errand.
function toggleGuestPref(store, on, off) {
  return () => {
    state.store[store] = !state.store[store];
    saveStore();
    syncFillButton();
    const view = currentPlayerView();
    if (view) applyGuestPrefs(view);
    showPlayerNotice(state.store[store] ? on : off);
  };
}

$('#player-intro').onclick = toggleGuestPref(
  'skipIntro',
  'Mở tập sẽ tự tua (bỏ qua giới thiệu / chỗ xem dở).',
  'Đã chặn tự tua — tập luôn chạy từ đầu.'
);

$('#player-next').onclick = toggleGuestPref(
  'autoNext',
  'Hết tập sẽ tự chuyển tập sau.',
  'Đã chặn tự chuyển tập.'
);

$('#player-auto').onclick = () => {
  state.store.autoRecover = !state.store.autoRecover;
  saveStore();
  syncFillButton();
  showPlayerNotice(
    state.store.autoRecover ? 'Đã bật tự động kết nối lại.' : 'Đã tắt tự động — app sẽ hỏi trước khi làm gì.'
  );
};

$('#player-fill').onclick = () => {
  state.store.fillFrame = !state.store.fillFrame;
  saveStore();
  syncFillButton();
  const view = currentPlayerView();
  if (view) applyStretching(view);
};

function toggleFullscreen(force) {
  const want = force === undefined ? !playerEl.classList.contains('immersive') : force;
  playerEl.classList.toggle('immersive', want);

  if (want && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  if (!want && document.fullscreenElement) document.exitFullscreen().catch(() => {});

  /* A phone held upright has no business showing a film full screen: the picture
     would be a strip across the middle of it. So on the shells, going full screen
     turns the handset sideways and takes the system bars away — and coming out
     gives both of those back. */
  if (window.WiSGuest && window.WiSGuest.fullscreen) window.WiSGuest.fullscreen(want);

  // Where the browser itself will take the instruction, it gets it too.
  if (screen.orientation && screen.orientation.lock) {
    if (want) {
      screen.orientation.lock('landscape').catch(() => {});
    } else if (screen.orientation.unlock) {
      try {
        screen.orientation.unlock();
      } catch {
        /* nothing to give back */
      }
    }
  }

  const view = currentPlayerView();
  if (view) setTimeout(() => nudgeGuestResize(view), 200);
}

$('#player-full').onclick = () => toggleFullscreen();

let resizeTimer = null;
window.addEventListener('resize', () => {
  const view = stage.querySelector('webview');
  if (!view) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => nudgeGuestResize(view), 150);
});

function closePlayer() {
  toggleFullscreen(false);
  playerEl.classList.add('hidden');
  clearInterval(watchdog);
  clearInterval(keyRelay);
  clearInterval(subWatch);
  showPlayerNotice('');
  window.WiSSubs.detach();
  dropPlayerView(); // tear the webview down so audio stops
  playerCtx = null;
}

$('#player-close').onclick = closePlayer;
document.addEventListener('keydown', (event) => {
  if (playerEl.classList.contains('hidden')) return;

  // The same subtitle keys the guest relays, for when the host has the focus.
  if (event.shiftKey && event.key.startsWith('Arrow')) {
    const run = {
      ArrowUp: () => moveSubtitle(2),
      ArrowDown: () => moveSubtitle(-2),
      ArrowLeft: () => nudgeSubtitle(-0.5),
      ArrowRight: () => nudgeSubtitle(0.5),
    }[event.key];
    if (run) {
      event.preventDefault();
      return run();
    }
  }

  // Escape backs out one level at a time: immersive first, then the player.
  if (event.key === 'Escape') {
    if (playerEl.classList.contains('immersive')) return toggleFullscreen(false);
    return closePlayer();
  }
  if (event.key === 'f' || event.key === 'F') toggleFullscreen();
});

/* ------------------------------------------------------------- chrome/nav */

function buildSidebar() {
  const navMain = $('#nav-main');
  MAIN_LISTS.forEach((entry) => {
    const kind = entry.kind || 'list';
    const btn = el('button', null, entry.label);
    btn.dataset.key = kind + ':' + (entry.slug || '');
    btn.onclick = () => render({ kind, slug: entry.slug, label: entry.label, page: 1 });
    navMain.appendChild(btn);
  });

  const navLocal = $('#nav-local');
  [
    { kind: 'watching', label: 'Đang xem' },
    { kind: 'favorites', label: 'Yêu thích' },
    // Subtitles brought in from outside are kept, so they need somewhere to live.
    { kind: 'subs', label: 'Phụ đề' },
  ].forEach((entry) => {
    const btn = el('button', null, entry.label);
    btn.dataset.key = entry.kind + ':';
    btn.onclick = () => render({ kind: entry.kind, label: entry.label });
    navLocal.appendChild(btn);
  });

  const navHh3d = $('#nav-hh3d-links');
  const hh3dBtn = el('button', null, 'HH3D');
  hh3dBtn.dataset.key = 'hh3d:';
  hh3dBtn.onclick = () => render({ kind: 'hh3d', label: 'HH3D', page: 1 });
  navHh3d.appendChild(hh3dBtn);

  document.querySelectorAll('.nav-toggle').forEach((toggle) => {
    toggle.onclick = () => $('#panel-' + toggle.dataset.panel).classList.toggle('open');
  });
}

async function fillTaxonomy(panelId, fetcher, kind) {
  const res = await fetcher();
  if (!res.ok) return;
  const panel = $('#' + panelId);
  res.data.items.forEach((entry) => {
    const btn = el('button', null, entry.name);
    btn.dataset.key = kind + ':' + entry.slug;
    btn.onclick = () => render({ kind, slug: entry.slug, label: entry.name, page: 1 });
    panel.appendChild(btn);
  });
}

$('#btn-back').onclick = goBack;

$('#search').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const keyword = event.target.value.trim();
  if (keyword.length < 2) return;

  if (state.scope === 'hh3d') {
    return render({ kind: 'hh3dSearch', keyword, label: 'HH3D: “' + keyword + '”', page: 1 });
  }
  render({ kind: 'search', keyword, label: 'Kết quả cho “' + keyword + '”', page: 1 });
});

/* ------------------------------------------------------------------ boot */

/* "Is it running the build I just made?" should be answerable from inside the
   app. The stamp hides in the logo's tooltip rather than taking a line of the
   sidebar. */
async function stampBuild() {
  if (!window.api.build) return;
  const res = await window.api.build().catch(() => null);
  if (!res || !res.ok) return;
  const at = res.data.builtAt ? new Date(res.data.builtAt) : null;
  const when = at ? at.toLocaleString('vi-VN') : 'không rõ';
  const mark = document.querySelector('.brand-mark');
  const text = `WiSFilm ${res.data.version} — bản dựng ${when}`;
  if (mark) mark.title = text;
  window.WiSBuild = text;
}

/* On a phone the navigation is a sheet rather than a column, and the name at the
   top is its handle — see the stylesheet. Nothing is added to the screen for it:
   the brand was already there, and on a wide window this does nothing at all. */
function wireMobileNav() {
  const narrow = () => window.matchMedia('(max-width: 760px)').matches;
  const sidebar = $('#sidebar');
  const brand = document.querySelector('.brand');
  if (!brand) return;

  brand.onclick = () => {
    if (narrow()) sidebar.classList.toggle('open');
  };

  // Going somewhere is the end of choosing where to go.
  sidebar.addEventListener('click', (event) => {
    if (event.target.closest('.brand')) return;
    if (event.target.closest('button') && !event.target.closest('.nav-toggle')) {
      sidebar.classList.remove('open');
    }
  });

  window.addEventListener('resize', () => {
    if (!narrow()) sidebar.classList.remove('open');
  });
}

(async function boot() {
  buildSidebar();
  wireMobileNav();
  await loadStore();
  stampBuild();
  syncFillButton();
  render({ kind: 'list', slug: 'phim-moi-cap-nhat', label: 'Mới cập nhật', page: 1 });
  fillTaxonomy('panel-genres', window.api.genres, 'genre');
  fillTaxonomy('panel-countries', window.api.countries, 'country');
})();
