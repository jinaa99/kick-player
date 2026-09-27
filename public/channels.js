'use strict';

// Favourite channels sidebar: live status polled from the local server, optional import of Kick follows.
const Channels = (() => {
  const POLL_MS = 60000;
  let info = new Map(); // slug -> summary from /api/channels
  let onWatch = () => {};
  let current = null;
  let pollTimer = null;

  const $ = (id) => document.getElementById(id);

  const load = () => {
    try {
      return JSON.parse(localStorage.getItem('favorites') || '[]');
    } catch {
      return [];
    }
  };
  const save = (list) => {
    try {
      localStorage.setItem('favorites', JSON.stringify(list));
    } catch {}
  };

  const isFav = (slug) => load().includes(slug);

  function add(slugs) {
    const list = load();
    for (const s of slugs) if (s && !list.includes(s)) list.push(s);
    save(list);
    refresh();
  }

  function remove(slug) {
    save(load().filter((s) => s !== slug));
    info.delete(slug);
    render();
    updateStar();
  }

  function toggle(slug) {
    if (!slug) return;
    if (isFav(slug)) remove(slug);
    else add([slug]);
    updateStar();
  }

  function updateStar() {
    const b = $('favToggle');
    const on = !!current && isFav(current);
    b.textContent = on ? '★' : '☆';
    b.title = on ? 'Дуртайгаас хасах' : 'Дуртайд нэмэх';
    b.setAttribute('aria-pressed', String(on));
    b.disabled = !current;
  }

  const fmtViewers = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n ?? 0));

  function render() {
    const ul = $('favList');
    const slugs = load();
    ul.textContent = '';
    $('favEmpty').hidden = slugs.length > 0;
    const rows = slugs.map((slug) => ({ slug, ...(info.get(slug) || {}) }));
    rows.sort((a, b) => (b.live === true) - (a.live === true) || (b.viewers || 0) - (a.viewers || 0) || a.slug.localeCompare(b.slug));
    $('favLiveCount').textContent = rows.filter((r) => r.live).length || '';

    for (const r of rows) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fav' + (r.live ? ' live' : '') + (r.slug === current ? ' active' : '');
      btn.title = r.live ? `${r.title || ''}\n${r.category || ''}`.trim() : r.missing ? 'Ийм суваг олдсонгүй' : 'Офлайн';
      btn.onclick = () => onWatch(r.slug);

      const av = document.createElement('span');
      av.className = 'avatar';
      if (r.avatar && /^https:\/\/([a-z0-9-]+\.)*kick\.com\//i.test(r.avatar)) {
        const img = document.createElement('img');
        img.src = r.avatar;
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = () => img.remove();
        av.append(img);
      }
      av.dataset.initial = (r.username || r.slug)[0].toUpperCase();

      const text = document.createElement('span');
      text.className = 'fav-text';
      const name = document.createElement('span');
      name.className = 'fav-name';
      name.textContent = r.username || r.slug;
      const sub = document.createElement('span');
      sub.className = 'fav-sub';
      sub.textContent = r.live ? r.category || 'Эфирт' : r.missing ? 'Олдсонгүй' : r.live === false ? 'Офлайн' : '…';
      text.append(name, sub);

      btn.append(av, text);
      if (r.live) {
        const v = document.createElement('span');
        v.className = 'viewers';
        v.textContent = fmtViewers(r.viewers);
        btn.append(v);
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'fav-del';
      del.textContent = '×';
      del.title = 'Хасах';
      del.onclick = (e) => {
        e.stopPropagation();
        remove(r.slug);
      };
      li.append(btn, del);
      ul.append(li);
    }
  }

  async function refresh() {
    clearTimeout(pollTimer);
    const slugs = load();
    render();
    if (slugs.length) {
      try {
        const res = await fetch(`/api/channels?slugs=${encodeURIComponent(slugs.join(','))}`);
        if (res.ok) for (const r of await res.json()) if (r?.slug) info.set(r.slug, r);
      } catch {}
      render();
    }
    pollTimer = setTimeout(refresh, POLL_MS);
  }

  // ---------------------------------------------------------------- import dialog

  async function doImport() {
    const input = $('importToken');
    const msg = $('importMsg');
    msg.className = 'muted';
    msg.textContent = 'Импортолж байна…';
    try {
      const res = await fetch('/api/follows/import', { method: 'POST', body: JSON.stringify({ token: input.value }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      input.value = ''; // never keep the token around
      if (!data.slugs.length) throw new Error('Follow хийсэн суваг олдсонгүй');
      const before = load().length;
      add(data.slugs);
      msg.className = 'ok';
      msg.textContent = `${data.slugs.length} суваг олдлоо, ${load().length - before} нь шинээр нэмэгдлээ.`;
    } catch (e) {
      msg.className = 'err';
      msg.textContent = e.message;
    }
  }

  function init({ watch }) {
    onWatch = watch;
    $('favToggle').addEventListener('click', () => toggle(current));
    $('importOpen').addEventListener('click', () => {
      $('importMsg').textContent = '';
      $('importDialog').showModal();
    });
    $('importClose').addEventListener('click', () => {
      $('importToken').value = '';
      $('importDialog').close();
    });
    $('importRun').addEventListener('click', doImport);
    $('favAddForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('favAddInput').value.trim().toLowerCase().replace(/^@/, '');
      const m = v.match(/kick\.com\/([a-z0-9_-]+)/);
      const slug = m ? m[1] : v;
      if (/^[a-z0-9_-]{1,64}$/.test(slug)) add([slug]);
      $('favAddInput').value = '';
    });
    updateStar();
    refresh();
  }

  /** Called by the player when the watched channel changes. */
  function setCurrent(slug) {
    current = slug;
    updateStar();
    render();
  }

  return { init, setCurrent, info: (slug) => info.get(slug) };
})();
