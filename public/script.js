// =============================================================
// VEKT meet - script.js
// Vanilla JS. No frameworks.
// =============================================================
(() => {
  'use strict';

  // -------------------------------------------------------------
  // Config
  // -------------------------------------------------------------
  // API base. Same-origin in production (meet.vekt.ro/api/*).
  // Override at deploy by injecting window.VEKT_API_BASE before this script.
  const API_BASE = (window.VEKT_API_BASE || '').replace(/\/+$/, '');

  const COUNTY_NAMES = {
    AB:'Alba', AR:'Arad', AG:'Argeș', BC:'Bacău', BH:'Bihor',
    BN:'Bistrița-Năsăud', BT:'Botoșani', BV:'Brașov', BR:'Brăila',
    B:'București', BZ:'Buzău', CS:'Caraș-Severin', CL:'Călărași',
    CJ:'Cluj', CT:'Constanța', CV:'Covasna', DB:'Dâmbovița',
    DJ:'Dolj', GL:'Galați', GR:'Giurgiu', GJ:'Gorj', HR:'Harghita',
    HD:'Hunedoara', IL:'Ialomița', IS:'Iași', IF:'Ilfov',
    MM:'Maramureș', MH:'Mehedinți', MS:'Mureș', NT:'Neamț',
    OT:'Olt', PH:'Prahova', SJ:'Sălaj', SM:'Satu Mare', SB:'Sibiu',
    SV:'Suceava', TR:'Teleorman', TM:'Timiș', TL:'Tulcea',
    VS:'Vaslui', VL:'Vâlcea', VN:'Vrancea',
  };

  const ERR_MSG = {
    min_2_chars:           'Minim 2 caractere.',
    required:              'Câmp obligatoriu.',
    invalid_email:         'Adresă de email invalidă.',
    invalid_phone_ro:      'Format telefon invalid. Ex: 07xx xxx xxx',
    out_of_range:          'Anul trebuie să fie între 1950 și 2026.',
    select_1_to_3:         'Selectează 1-3 județe pe hartă.',
    duplicate_county:      'Ai selectat același județ de două ori.',
    duplicate_rank:        'Ranguri duplicate.',
    invalid_rank:          'Rang invalid.',
    invalid_county_id:     'Județ invalid.',
    invalid_vote_shape:    'Format selecție invalid.',
    ranks_must_be_contiguous: 'Selectează în ordine: 1, apoi 2, apoi 3.',
    email_exists:          'Această adresă de email este deja înregistrată.',
    rate_limited:          'Prea multe încercări. Reîncearcă într-o oră.',
    invalid_csrf:          'Sesiunea a expirat. Reîncarcă pagina.',
    invalid_input:         'Verifică datele introduse.',
    server_error:          'Eroare server. Încearcă din nou.',
    network:               'Conexiune întreruptă. Reîncearcă.',
  };

  // -------------------------------------------------------------
  // State
  // -------------------------------------------------------------
  /** @type {{id:string, rank:number}[]} */
  const selection = []; // ordered: rank 1, 2, 3
  let csrfToken = null;
  let leaderboardTimer = null;

  // -------------------------------------------------------------
  // Elements
  // -------------------------------------------------------------
  const $   = (s, r = document) => r.querySelector(s);
  const $$  = (s, r = document) => Array.from(r.querySelectorAll(s));
  const map = $('#romania-map');
  const picksEl = $('#picks');
  const boardEl = $('#leaderboard');
  const formEl  = $('#vekt-form');
  const submitBtn = $('#submit-btn');
  const successEl = $('#success');
  const yearEl = $('#year');
  const csrfInput = $('#csrf');
  const votesErrEl = $('#votes-err');
  const resetBtn = $('#reset-selection');

  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // -------------------------------------------------------------
  // CSRF: fetch token on load (with retry)
  // -------------------------------------------------------------
  async function fetchCsrf() {
    try {
      const res = await fetch(`${API_BASE}/api/csrf`, { method: 'GET', credentials: 'omit' });
      if (!res.ok) throw new Error(`csrf ${res.status}`);
      const data = await res.json();
      csrfToken = data.token;
      if (csrfInput) csrfInput.value = csrfToken;
    } catch (err) {
      console.warn('csrf fetch failed', err);
      // non-fatal at load; will be retried on submit if missing
    }
  }

  // -------------------------------------------------------------
  // Map: click / keyboard interaction
  // -------------------------------------------------------------
  function makeCountyAccessible(node) {
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    const id = node.dataset.id;
    const name = node.dataset.name || COUNTY_NAMES[id] || id;
    node.setAttribute('aria-label', `Județ ${name}. Apasă pentru a selecta.`);
    node.dataset.name = name;
  }

  function bindMap() {
    if (!map) return;
    $$('.county', map).forEach(node => {
      makeCountyAccessible(node);
      node.addEventListener('click', onCountyActivate);
      node.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCountyActivate.call(node, e); }
      });
    });
  }

  function onCountyActivate(e) {
    const id = this.dataset.id;
    if (!id || !COUNTY_NAMES[id]) return;
    toggleSelection(id);
  }

  function toggleSelection(id) {
    const idx = selection.findIndex(s => s.id === id);
    if (idx !== -1) {
      // Deselect; collapse ranks
      selection.splice(idx, 1);
      selection.forEach((s, i) => s.rank = i + 1);
    } else {
      if (selection.length >= 3) {
        flashVotesError('Maxim 3 selecții. Apasă din nou pe un județ pentru a-l elimina.');
        return;
      }
      selection.push({ id, rank: selection.length + 1 });
    }
    renderSelection();
    clearVotesError();
  }

  function renderSelection() {
    // SVG classes
    $$('.county', map).forEach(node => {
      node.classList.remove('is-sel-1', 'is-sel-2', 'is-sel-3');
      node.removeAttribute('aria-pressed');
      const sel = selection.find(s => s.id === node.dataset.id);
      if (sel) {
        node.classList.add(`is-sel-${sel.rank}`);
        node.setAttribute('aria-pressed', 'true');
      } else {
        node.setAttribute('aria-pressed', 'false');
      }
    });

    // Picks list
    const picks = $$('.pick', picksEl);
    picks.forEach((li, i) => {
      const rank = i + 1;
      const nameEl = $('.pick__name', li);
      const sel = selection.find(s => s.rank === rank);
      if (sel) {
        nameEl.textContent = COUNTY_NAMES[sel.id];
        nameEl.classList.remove('pick__name--empty');
      } else {
        const placeholder = ['Prima alegere', 'A doua alegere', 'A treia alegere'][i];
        nameEl.textContent = placeholder;
        nameEl.classList.add('pick__name--empty');
      }
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      selection.length = 0;
      renderSelection();
      clearVotesError();
    });
  }

  // -------------------------------------------------------------
  // Leaderboard (live)
  // -------------------------------------------------------------
  async function fetchCounties() {
    try {
      const res = await fetch(`${API_BASE}/api/counties`, { method: 'GET' });
      if (!res.ok) throw new Error(`counties ${res.status}`);
      const data = await res.json();
      return Array.isArray(data.counties) ? data.counties : [];
    } catch (err) {
      console.warn('counties fetch failed', err);
      return [];
    }
  }

  function renderCountyCounts(rows) {
    // Update vote count text inside SVG
    const map = new Map(rows.map(r => [r.county_id, r]));
    $$('.county').forEach(node => {
      const id = node.dataset.id;
      const row = map.get(id);
      const cntEl = $('.cnt', node);
      if (cntEl && row) cntEl.textContent = String(row.total_votes ?? 0);
    });
  }

  function renderLeaderboard(rows) {
    if (!boardEl) return;
    if (!rows.length || rows.every(r => (r.total_points ?? 0) === 0)) {
      boardEl.innerHTML = '<li class="board__row board__row--empty">Așteaptă primele voturi.</li>';
      return;
    }
    const top = rows
      .filter(r => (r.total_points ?? 0) > 0)
      .slice(0, 5);
    if (!top.length) {
      boardEl.innerHTML = '<li class="board__row board__row--empty">Așteaptă primele voturi.</li>';
      return;
    }
    const max = top[0].total_points || 1;
    boardEl.innerHTML = top.map((r, i) => {
      const w = Math.max(0.05, (r.total_points || 0) / max);
      return `
        <li class="board__row">
          <span class="board__rank">${String(i + 1).padStart(2, '0')}</span>
          <span class="board__name">${escapeHtml(r.county_name)}</span>
          <span class="board__pts"><strong>${r.total_points}</strong> pct</span>
          <span class="board__bar" aria-hidden="true"><i style="--w:${w}"></i></span>
        </li>`;
    }).join('');
  }

  async function refreshLeaderboard() {
    const rows = await fetchCounties();
    renderCountyCounts(rows);
    renderLeaderboard(rows);
  }

  function startLeaderboardPolling() {
    refreshLeaderboard();
    // Poll every 30s while tab visible
    leaderboardTimer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshLeaderboard();
    }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshLeaderboard();
    });
  }

  // -------------------------------------------------------------
  // Form: client-side validation
  // -------------------------------------------------------------
  function setFieldError(field, msg) {
    const input = $(`#${field}`);
    const err = $(`.field__err[data-for="${field}"]`);
    if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (err) err.textContent = msg || '';
  }

  function clearAllFieldErrors() {
    $$('.field__err').forEach(e => { e.textContent = ''; });
    $$('.field__in').forEach(i => i.removeAttribute('aria-invalid'));
    clearVotesError();
  }

  function flashVotesError(msg) {
    if (votesErrEl) votesErrEl.textContent = msg;
  }
  function clearVotesError() {
    if (votesErrEl) votesErrEl.textContent = '';
  }

  function validateClient(formData) {
    let ok = true;

    const prenume = (formData.prenume || '').trim();
    if (prenume.length < 2) { setFieldError('prenume', ERR_MSG.min_2_chars); ok = false; }

    const nume = (formData.nume || '').trim();
    if (nume.length < 2) { setFieldError('nume', ERR_MSG.min_2_chars); ok = false; }

    const email = (formData.email || '').trim();
    if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(email)) {
      setFieldError('email', ERR_MSG.invalid_email); ok = false;
    }

    if (formData.telefon) {
      const cleaned = String(formData.telefon).replace(/[\s.\-()]/g, '');
      if (!/^(?:\+?40|0)7\d{8}$/.test(cleaned)) {
        setFieldError('telefon', ERR_MSG.invalid_phone_ro); ok = false;
      }
    }

    if (!(formData.marca_masina || '').trim()) { setFieldError('marca_masina', ERR_MSG.required); ok = false; }
    if (!(formData.model_masina || '').trim()) { setFieldError('model_masina', ERR_MSG.required); ok = false; }

    const an = parseInt(formData.an_fabricatie, 10);
    if (!Number.isInteger(an) || an < 1950 || an > 2026) { setFieldError('an_fabricatie', ERR_MSG.out_of_range); ok = false; }

    if (selection.length < 1) { flashVotesError(ERR_MSG.select_1_to_3); ok = false; }

    return ok;
  }

  // -------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------
  async function onSubmit(e) {
    e.preventDefault();
    clearAllFieldErrors();

    const fd = new FormData(formEl);
    const payload = {
      prenume:           fd.get('prenume'),
      nume:              fd.get('nume'),
      email:             fd.get('email'),
      telefon:           fd.get('telefon') || null,
      marca_masina:      fd.get('marca_masina'),
      model_masina:      fd.get('model_masina'),
      an_fabricatie:     parseInt(fd.get('an_fabricatie'), 10),
      marketing_consent: !!fd.get('marketing_consent'),
      privacy_consent:   !!fd.get('privacy_consent'),
      votes:             selection.map(s => ({ id: s.id, rank: s.rank })),
    };

    if (!validateClient(payload)) {
      // Focus first invalid
      const firstInvalid = $('[aria-invalid="true"]') || (selection.length === 0 ? map : null);
      if (firstInvalid && firstInvalid.scrollIntoView) {
        firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (firstInvalid.focus) firstInvalid.focus();
      }
      return;
    }

    if (!payload.privacy_consent) {
      // Browser will already block via required, but double-check
      return;
    }

    if (!csrfToken) {
      await fetchCsrf();
      if (!csrfToken) {
        flashVotesError(ERR_MSG.invalid_csrf);
        return;
      }
    }

    submitBtn.classList.add('is-loading');
    submitBtn.disabled = true;

    try {
      const res = await fetch(`${API_BASE}/api/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        showSuccess();
        // refresh leaderboard once after submit
        refreshLeaderboard();
        return;
      }

      // Handle structured errors
      let data = null;
      try { data = await res.json(); } catch {}
      const code = data?.error || 'server_error';

      if (code === 'invalid_input' && data?.fields) {
        for (const [k, v] of Object.entries(data.fields)) {
          if (k === 'votes') flashVotesError(ERR_MSG[v] || ERR_MSG.select_1_to_3);
          else setFieldError(k, ERR_MSG[v] || ERR_MSG.required);
        }
      } else if (code === 'email_exists') {
        setFieldError('email', ERR_MSG.email_exists);
      } else if (code === 'rate_limited') {
        flashVotesError(ERR_MSG.rate_limited);
      } else if (code === 'invalid_csrf') {
        // refetch and ask user to retry
        csrfToken = null;
        await fetchCsrf();
        flashVotesError(ERR_MSG.invalid_csrf);
      } else {
        flashVotesError(ERR_MSG.server_error);
      }
    } catch (err) {
      console.error('submit failed', err);
      flashVotesError(ERR_MSG.network);
    } finally {
      submitBtn.classList.remove('is-loading');
      submitBtn.disabled = false;
    }
  }

  function showSuccess() {
    formEl.hidden = true;
    successEl.hidden = false;
    successEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (leaderboardTimer) clearInterval(leaderboardTimer);
  }

  // -------------------------------------------------------------
  // Misc
  // -------------------------------------------------------------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Strip leading +40/0 for cleaner display? Keep raw input as user typed.
  // Live-clear errors on input
  $$('.field__in').forEach(input => {
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') {
        setFieldError(input.id, '');
      }
    });
  });

  // -------------------------------------------------------------
  // Init
  // -------------------------------------------------------------
  bindMap();
  renderSelection();
  fetchCsrf();
  startLeaderboardPolling();
  formEl.addEventListener('submit', onSubmit);
})();
