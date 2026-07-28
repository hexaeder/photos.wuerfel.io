// Tiny DOM helpers. No framework — the app is a grid, a lightbox and two
// forms, and a render() that rebuilds from state is less code than a
// dependency would be.

export const $ = (id) => document.getElementById(id);

/**
 * el('div', { class: 'x', text: 'hi', onclick: fn }, child, [child, child])
 * Attribute values of false/null are skipped; true renders a bare attribute.
 */
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(3)) if (c != null && c !== false) n.append(c);
  return n;
}

export function show(screen) {
  document.body.dataset.screen = screen;
  window.scrollTo(0, 0);
}

export function toast(msg, kind = '') {
  const t = el('div', { class: kind ? `toast ${kind}` : 'toast', text: msg });
  $('toasts').append(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 320);
  }, kind === 'bad' ? 5500 : 2600);
}

/** Bottom-sheet confirm. Resolves true if the user goes ahead. */
export function confirmSheet({ title, body, confirm = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
    };

    const go = el('button', {
      class: danger ? 'btn danger' : 'btn primary',
      text: confirm,
      onclick: () => finish(true),
    });

    const wrap = el('div', { class: 'sheet', onclick: (e) => { if (e.target === wrap) finish(false); } },
      el('div', { class: 'sheetbox confirmbox' },
        el('h2', { class: 'confirmtitle', text: title }),
        body && el('p', { class: 'lede', text: body }),
        el('div', { class: 'confirmacts' },
          el('button', { class: 'btn', text: 'Cancel', onclick: () => finish(false) }),
          go)));

    document.body.append(wrap);
    document.addEventListener('keydown', onKey);
    go.focus();
  });
}

/** Run `jobs` (array of thunks returning promises) at most `n` at a time. */
export async function pool(jobs, n) {
  const queue = [...jobs];
  const runners = Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(runners);
}

export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * The bottom sheet with a title, a running summary, a list of rows and one
 * action button. Uploading and bulk-saving are the same shape of job — both
 * chew through a list of files and can fail partway — so they share it.
 */
export const taskSheet = {
  _onClose: null,

  open({ title, summary = '' }) {
    $('upTitle').textContent = title;
    $('upSummary').textContent = summary;
    $('upList').replaceChildren();
    this.hideAction();
    $('upSheet').hidden = false;
    return this;
  },

  summary(text) {
    $('upSummary').textContent = text;
    return this;
  },

  /** Adds a row and hands back a setter for its status. */
  row(name, status = '…', state = 'work') {
    const stat = el('span', { class: 'upstat', text: status });
    const row = el('div', { class: 'uprow', 'data-s': state },
      el('span', { class: 'upname', text: name }), stat);
    $('upList').append(row);
    row.scrollIntoView({ block: 'nearest' });
    return (nextState, nextStatus) => {
      row.dataset.s = nextState;
      stat.textContent = nextStatus;
    };
  },

  action(label, fn) {
    const btn = $('upRetry');
    btn.textContent = label;
    btn.hidden = false;
    btn.onclick = fn;
    return this;
  },

  hideAction() {
    const btn = $('upRetry');
    btn.hidden = true;
    btn.onclick = null;
    return this;
  },

  onClose(fn) {
    this._onClose = fn;
    return this;
  },

  close() {
    $('upSheet').hidden = true;
    this.hideAction();
    const fn = this._onClose;
    this._onClose = null;
    fn?.();
  },
};

export function shortDate(ms) {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * Date plus time of day. Only used for capture times, where the clock is real
 * information — a trip photo at 06:12 tells you something an upload timestamp
 * never could, and it's also how you can tell at a glance that the date came
 * out of EXIF rather than out of the filename.
 */
export const shortDateTime = (ms) =>
  `${shortDate(ms)} ${new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  })}`;
