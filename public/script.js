(() => {
  'use strict';

  const API_BASE = '';  // same-origin meet.vekt.ro/api/*

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

  // ---- State ----
  let picks = [];  // [{county_id, county_name, vote_rank}], max 3
  let csrfToken = '';
  let countyData = {};  // id -> {votes, points}

  // ---- Cookie consent ----
  // Key: 'vekt_cookie_consent', values: 'all' | 'essential' | null
  // Valid 12 luni. La accept 'all': window.vektAnalyticsConsent = true
  // Banner: class 'cookie--visible' pe #cookie-banner

  function initCookieBanner() {
    const stored = localStorage.getItem('vekt_cookie_consent');
    const storedAt = localStorage.getItem('vekt_cookie_consent_at');
    const YEAR_MS = 365 * 24 * 3600 * 1000;
    const expired = storedAt && (Date.now() - parseInt(storedAt, 10)) > YEAR_MS;

    if (stored && !expired) {
      // Apply consent
      if (stored === 'all') window.vektAnalyticsConsent = true;
      return;
    }

    const banner = document.getElementById('cookie-banner');
    if (!banner) return;
    setTimeout(() => banner.classList.add('cookie--visible'), 800);

    function saveConsent(val) {
      localStorage.setItem('vekt_cookie_consent', val);
      localStorage.setItem('vekt_cookie_consent_at', Date.now());
      banner.classList.remove('cookie--visible');
      banner.setAttribute('aria-hidden', 'true');
      if (val === 'all') window.vektAnalyticsConsent = true;
    }

    document.getElementById('cookie-accept')?.addEventListener('click', () => saveConsent('all'));
    document.getElementById('cookie-reject')?.addEventListener('click', () => saveConsent('essential'));
  }

  // ---- CSRF ----
  async function fetchCsrf() {
    try {
      const r = await fetch(`${API_BASE}/api/csrf`);
      const d = await r.json();
      csrfToken = d.token || '';
    } catch (e) {
      console.warn('csrf fetch failed', e);
    }
  }

  // ---- Counties / Leaderboard ----
  async function fetchCounties() {
    try {
      const r = await fetch(`${API_BASE}/api/counties`);
      const d = await r.json();
      if (d.counties) {
        countyData = {};
        d.counties.forEach(c => { countyData[c.id] = c; });
        updateCountySvgCounts();
        renderLeaderboard(d.counties);
      }
    } catch (e) {
      console.warn('counties fetch failed', e);
    }
  }

  function updateCountySvgCounts() {
    document.querySelectorAll('.county').forEach(el => {
      const id = el.dataset.id;
      const cnt = el.querySelector('.cnt');
      if (cnt && countyData[id]) cnt.textContent = countyData[id].points || 0;
    });
  }

  function renderLeaderboard(counties) {
    const board = document.getElementById('leaderboard');
    if (!board) return;
    const top5 = counties.filter(c => c.points > 0).slice(0, 5);
    if (!top5.length) {
      board.innerHTML = '<li class="board__empty">Primele voturi...</li>';
      return;
    }
    const maxPts = top5[0].points || 1;
    board.innerHTML = top5.map((c, i) => `
      <li class="board__row">
        <span class="board__pos">${String(i + 1).padStart(2, '0')}</span>
        <span class="board__name">${c.name}</span>
        <span class="board__bar-wrap"><span class="board__bar" style="transform:scaleX(${c.points / maxPts})"></span></span>
        <span class="board__pts">${c.points}</span>
      </li>
    `).join('');
    // Animate bars after paint
    requestAnimationFrame(() => {
      board.querySelectorAll('.board__bar').forEach(b => {
        b.style.transition = 'transform 0.8s ease-out';
      });
    });
  }

  // ---- Map interaction ----
  function initMap() {
    const svg = document.getElementById('romania-map');
    if (!svg) return;

    // Tooltip
    const tooltip = document.getElementById('map-tooltip');

    svg.addEventListener('click', e => {
      const county = e.target.closest('.county');
      if (!county) return;
      toggleCounty(county.dataset.id, county.dataset.name);
    });

    if (tooltip) {
      svg.addEventListener('mousemove', e => {
        const county = e.target.closest('.county');
        if (!county) { tooltip.style.opacity = '0'; return; }
        const id = county.dataset.id;
        const name = county.dataset.name;
        const pts = countyData[id]?.points ?? 0;
        tooltip.querySelector('.map__tooltip-name').textContent = name;
        tooltip.querySelector('.map__tooltip-pts').textContent = pts ? `${pts} pct` : '';
        const rect = svg.getBoundingClientRect();
        tooltip.style.left = (e.clientX - rect.left + 12) + 'px';
        tooltip.style.top  = (e.clientY - rect.top - 8) + 'px';
        tooltip.style.opacity = '1';
      });
      svg.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; });
    }

    // Touch tooltip (show briefly on tap before toggle)
    svg.addEventListener('touchstart', e => {
      const county = e.target.closest('.county');
      if (!county || !tooltip) return;
      tooltip.querySelector('.map__tooltip-name').textContent = county.dataset.name;
      tooltip.querySelector('.map__tooltip-pts').textContent = '';
      tooltip.style.opacity = '1';
      setTimeout(() => { tooltip.style.opacity = '0'; }, 1200);
    }, { passive: true });
  }

  function toggleCounty(id, name) {
    const existing = picks.findIndex(p => p.county_id === id);
    if (existing !== -1) {
      // Deselect
      picks.splice(existing, 1);
      // Re-rank remaining
      picks = picks.map((p, i) => ({ ...p, vote_rank: i + 1 }));
    } else {
      if (picks.length >= 3) return;  // max 3
      picks.push({ county_id: id, county_name: name, vote_rank: picks.length + 1 });
    }
    updateMapState();
    updatePicksList();
    clearVotesError();
  }

  function updateMapState() {
    document.querySelectorAll('.county').forEach(el => {
      const id = el.dataset.id;
      const pick = picks.find(p => p.county_id === id);
      if (pick) {
        el.setAttribute('data-rank', pick.vote_rank);
      } else {
        el.removeAttribute('data-rank');
      }
    });
  }

  function updatePicksList() {
    const list = document.getElementById('picks');
    if (!list) return;
    [1, 2, 3].forEach(rank => {
      const li = list.querySelector(`[data-rank="${rank}"]`);
      if (!li) return;
      const nameEl = li.querySelector('.pick__name');
      const pick = picks.find(p => p.vote_rank === rank);
      if (pick) {
        nameEl.textContent = pick.county_name;
        nameEl.classList.remove('pick__name--empty');
      } else {
        const defaults = ['Prima alegere', 'A doua alegere', 'A treia alegere'];
        nameEl.textContent = defaults[rank - 1];
        nameEl.classList.add('pick__name--empty');
      }
    });
  }

  function clearVotesError() {
    const el = document.getElementById('votes-err');
    if (el) el.textContent = '';
  }

  // ---- Reset ----
  function initReset() {
    document.getElementById('reset-selection')?.addEventListener('click', () => {
      picks = [];
      updateMapState();
      updatePicksList();
      clearVotesError();
    });
  }

  // ---- Validation helpers ----
  const ERR = {
    required: 'Câmp obligatoriu.',
    min_2_chars: 'Minim 2 caractere.',
    invalid_email: 'Email invalid.',
    invalid_phone: 'Telefon invalid.',
    invalid_an: 'An invalid (1950-2026).',
    privacy_required: 'Trebuie să fii de acord cu politica de confidențialitate.',
    marketing_required: 'Consimțământul pentru comunicări VEKT este obligatoriu.',
    min_1_vote: 'Selectează cel puțin un județ.',
  };

  function validateField(input) {
    const id = input.id;
    const val = input.value.trim();
    let err = '';

    if (input.required && !val) { err = ERR.required; }
    else if (id === 'prenume' || id === 'nume') { if (val.length < 2) err = ERR.min_2_chars; }
    else if (id === 'email') { if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val)) err = ERR.invalid_email; }
    else if (id === 'telefon' && val) { if (!/^[\d\s+\-()]{6,20}$/.test(val)) err = ERR.invalid_phone; }
    else if (id === 'an_fabricatie') {
      const an = parseInt(val, 10);
      if (isNaN(an) || an < 1950 || an > new Date().getFullYear() + 1) err = ERR.invalid_an;
    }
    else if (id === 'privacy_consent' && !input.checked) { err = ERR.privacy_required; }
    else if (id === 'marketing_consent' && !input.checked) { err = ERR.marketing_required; }

    const errEl = document.querySelector(`[data-for="${id}"]`);
    if (errEl) errEl.textContent = err;
    return !err;
  }

  function initValidation() {
    document.querySelectorAll('.field__in').forEach(input => {
      input.addEventListener('blur', () => validateField(input));
      input.addEventListener('input', () => {
        const errEl = document.querySelector(`[data-for="${input.id}"]`);
        if (errEl && errEl.textContent) validateField(input);
      });
    });
    document.getElementById('privacy_consent')?.addEventListener('change', e => validateField(e.target));
    document.getElementById('marketing_consent')?.addEventListener('change', e => validateField(e.target));
  }

  // ---- Form submit ----
  function initForm() {
    const form = document.getElementById('vekt-form');
    if (!form) return;

    form.addEventListener('submit', async e => {
      e.preventDefault();

      // Validate all fields
      let valid = true;
      form.querySelectorAll('.field__in').forEach(input => {
        if (!validateField(input)) valid = false;
      });
      const privacyCb = document.getElementById('privacy_consent');
      if (privacyCb && !validateField(privacyCb)) valid = false;
      const marketingCb = document.getElementById('marketing_consent');
      if (marketingCb && !validateField(marketingCb)) valid = false;

      // Validate votes
      const votesErr = document.getElementById('votes-err');
      if (picks.length < 1) {
        if (votesErr) votesErr.textContent = ERR.min_1_vote;
        valid = false;
      }

      if (!valid) return;

      const btn = document.getElementById('submit-btn');
      const btnTxt = btn?.querySelector('.cta__txt');
      if (btn) btn.disabled = true;
      if (btnTxt) btnTxt.textContent = 'SE TRIMITE...';

      const data = {
        csrf:              csrfToken,
        prenume:           form.prenume.value.trim(),
        nume:              form.nume.value.trim(),
        email:             form.email.value.trim(),
        telefon:           form.telefon?.value?.trim() || '',
        marca_masina:      form.marca_masina.value.trim(),
        model_masina:      form.model_masina.value.trim(),
        an_fabricatie:     parseInt(form.an_fabricatie.value, 10),
        marketing_consent: form.marketing_consent?.checked || false,
        privacy_consent:   true,
        votes:             picks,
      };

      try {
        const res = await fetch(`${API_BASE}/api/register`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify(data),
        });
        const result = await res.json();

        if (res.ok && result.ok) {
          showSuccess();
        } else {
          handleSubmitError(result.error, btn, btnTxt);
        }
      } catch (err) {
        console.error('submit error', err);
        if (btn) btn.disabled = false;
        if (btnTxt) btnTxt.textContent = 'VOTEAZĂ ȘI ÎNSCRIE-TE';
        if (votesErr) votesErr.textContent = 'Eroare de rețea. Încearcă din nou.';
      }
    });
  }

  function handleSubmitError(errCode, btn, btnTxt) {
    const msg = {
      email_exists:    'Această adresă de email a fost deja înregistrată.',
      rate_limited:    'Prea multe încercări. Încearcă mai târziu.',
      invalid_csrf:    'Token expirat. Reîncarcă pagina.',
      duplicate_vote:  'Vot duplicat detectat.',
      db_error:        'Eroare server. Încearcă din nou.',
    }[errCode] || 'Eroare. Încearcă din nou.';

    const votesErr = document.getElementById('votes-err');
    if (votesErr) votesErr.textContent = msg;
    if (btn) btn.disabled = false;
    if (btnTxt) btnTxt.textContent = 'VOTEAZĂ ȘI ÎNSCRIE-TE';
  }

  function showSuccess() {
    const form = document.getElementById('vekt-form');
    const success = document.getElementById('success');
    if (form) form.hidden = true;
    if (!success) return;
    success.hidden = false;

    // Populate voted counties list
    const list = document.getElementById('success-picks');
    if (list) {
      const labels = ['Prima alegere', 'A doua alegere', 'A treia alegere'];
      list.innerHTML = picks
        .sort((a, b) => a.vote_rank - b.vote_rank)
        .map(p => `<li><span class="pick-rank">${labels[p.vote_rank - 1]}</span>${p.county_name}</li>`)
        .join('');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });

    document.getElementById('success-back')?.addEventListener('click', () => {
      success.hidden = true;
      if (form) form.hidden = false;
      const harta = document.getElementById('harta');
      if (harta) harta.scrollIntoView({ behavior: 'smooth' });
    }, { once: true });
  }

  // ---- Scroll animations (IntersectionObserver) ----
  function initAnimations() {
    const pref = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (pref) return;

    // Generic reveal
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('revealed'); obs.unobserve(e.target); }
      });
    }, { threshold: 0.15 });

    document.querySelectorAll('.reveal').forEach(el => obs.observe(el));

    // Manifesto clip-path reveal
    const manifesto = document.querySelector('.manifesto__text');
    if (manifesto) {
      manifesto.style.clipPath = 'inset(0 100% 0 0)';
      const mObs = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) {
          manifesto.style.transition = 'clip-path 800ms cubic-bezier(.7,0,.3,1)';
          manifesto.style.clipPath = 'inset(0 0% 0 0)';
          mObs.disconnect();
        }
      }, { threshold: 0.3 });
      mObs.observe(manifesto);
    }

    // Map counties pulse on first appear
    const mapEl = document.getElementById('romania-map');
    if (mapEl) {
      const mapObs = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) {
          document.querySelectorAll('.county').forEach((el, i) => {
            setTimeout(() => el.classList.add('county--appeared'), Math.random() * 400);
          });
          mapObs.disconnect();
        }
      }, { threshold: 0.1 });
      mapObs.observe(mapEl);
    }

    // Hero title stagger
    document.querySelectorAll('.hero__line').forEach((line, i) => {
      line.style.opacity = '0';
      line.style.transform = 'translateY(20px)';
      line.style.transition = `opacity 0.6s ease-out ${i * 100}ms, transform 0.6s ease-out ${i * 100}ms`;
    });
    const heroSub = document.querySelector('.hero__sub');
    if (heroSub) {
      heroSub.style.opacity = '0';
      heroSub.style.transform = 'translateY(20px)';
      heroSub.style.transition = 'opacity 0.6s ease-out 200ms, transform 0.6s ease-out 200ms';
    }
    requestAnimationFrame(() => {
      setTimeout(() => {
        document.querySelectorAll('.hero__line, .hero__sub').forEach(el => {
          el.style.opacity = '1';
          el.style.transform = 'translateY(0)';
        });
      }, 100);
    });
  }

  // ---- Year in footer ----
  function initYear() {
    const el = document.getElementById('year');
    if (el) el.textContent = new Date().getFullYear();
  }

  // ---- Periodic leaderboard refresh ----
  function startLeaderboardPolling() {
    setInterval(fetchCounties, 30000);
  }

  // ---- Init ----
  function init() {
    initCookieBanner();
    initYear();
    initMap();
    initReset();
    initValidation();
    initForm();
    initAnimations();
    fetchCsrf();
    fetchCounties();
    startLeaderboardPolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
