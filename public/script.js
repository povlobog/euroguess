(function () {
  const $ = (s) => document.querySelector(s);

  // === API base: produkcija => isti origin, lokalno => localhost:8080 ===
  const BASE_API =
    (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? 'http://localhost:8080'
      : ''; // relativni put na istom originu

  // ===== STATE =====
  let playersAll = [];            // skup igrača (GP >= 10)
  let validNames = new Set();     // skup normalizovanih imena
  let target = null, attempts = 0, revealed = 0, over = false;
  let tried = new Set();          // sprečava duple pokušaje

  // ===== SCORING =====
  function pointsForAttempt(n) {
    const table = [100, 70, 50, 35, 25, 18, 12, 8, 5, 3]; // 1..10
    return n >= 1 && n <= table.length ? table[n - 1] : 0;
  }

  // ===== AUTH (pravi API) =====
  const LS_TOKEN = 'EG_JWT_V1';

  function saveToken(t) { localStorage.setItem(LS_TOKEN, t); }
  function getToken()   { return localStorage.getItem(LS_TOKEN); }
  function clearToken() { localStorage.removeItem(LS_TOKEN); }

  async function apiRegister(username, password) {
    const r = await fetch(`${BASE_API}/auth/register`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, password })
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Register failed');
    return r.json(); // {token, user:{username,balance}}
  }

  async function apiLogin(username, password) {
    const r = await fetch(`${BASE_API}/auth/login`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, password })
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Login failed');
    return r.json(); // {token, user:{username,balance}}
  }

  async function apiMe() {
    const tok = getToken(); if (!tok) return null;
    const r = await fetch(`${BASE_API}/me`, {
      headers: { Authorization: `Bearer ${tok}` }
    });
    if (!r.ok) return null;
    return r.json(); // {username, balance}
  }

  async function apiAddBalance(points) {
    const tok = getToken(); if (!tok) throw new Error('Not signed in');
    const r = await fetch(`${BASE_API}/me/balance/add`, {
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        Authorization: `Bearer ${tok}`
      },
      body: JSON.stringify({ points })
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Balance add failed');
    return r.json(); // {balance}
  }

  // ===== UI refs =====
  const ui = {
    authStatus: $("#authStatus"),
    balanceBox: $("#balanceBox"),
    balanceVal: $("#balanceVal"),
    loginModal: $("#loginModal"),
    registerModal: $("#registerModal"),
    modalMask: $("#modalMask"),
    openLoginBtn: $("#openLoginBtn"),
    openRegisterBtn: $("#openRegisterBtn"),
    logoutBtn: $("#logoutBtn"),
    loginSubmit: $("#loginSubmit"),
    registerSubmit: $("#registerSubmit"),
    loginUser: $("#loginUser"),
    loginPass: $("#loginPass"),
    regUser: $("#regUser"),
    regPass: $("#regPass"),
    statusText: $("#statusText"),
  };

  const show  = (el) => el.classList.remove("hidden");
  const hide  = (el) => el.classList.add("hidden");
  const open  = (m)  => { show(ui.modalMask); show(m); };
  const close = ()    => { hide(ui.modalMask); hide(ui.loginModal); hide(ui.registerModal); };

  // ==== AUTH UI ====
  async function refreshAuthUI() {
    const me = await apiMe();
    if (!me) {
      ui.authStatus.textContent = "Not signed in";
      hide(ui.logoutBtn); show(ui.openLoginBtn); show(ui.openRegisterBtn); hide(ui.balanceBox);
      ui.balanceVal.textContent = '0';
      return;
    }
    ui.authStatus.textContent = `Signed in as ${me.username}`;
    show(ui.logoutBtn); hide(ui.openLoginBtn); hide(ui.openRegisterBtn); show(ui.balanceBox);
    ui.balanceVal.textContent = me.balance ?? 0;
  }

  // ===== API helpers =====
  async function fetchAllPlayers() {
    const res = await fetch(`${BASE_API}/players`);
    if (!res.ok) throw new Error("Failed to load players");
    return await res.json(); // [{name, team, country, position, stats:{...}}, ...]
  }
  async function fetchSuggestions(prefix) {
    if (!prefix) return [];
    const res = await fetch(`${BASE_API}/players?q=${encodeURIComponent(prefix)}`);
    if (!res.ok) return [];
    return await res.json();
  }

  // ===== GAME =====
  const normalize = (s) => (s || "").trim().toLowerCase();
  function fmt(v) { if (v == null) return "?"; return typeof v === "number" ? Math.round(v * 10) / 10 : v; }
  const safe = (s) => s || "?";

  function buildValidNameSet(list) {
    validNames = new Set(list.map(p => normalize(p.name)));
  }
  function isValidName(name) {
    return validNames.has(normalize(name));
  }

  function pickRandom() {
    if (!playersAll.length) return null;
    return playersAll[Math.floor(Math.random() * playersAll.length)];
  }

  function renderHints() {
    const s = (target && target.stats) || {};
    const out = [`PTS: ${fmt(s.pts)}, 2P%: ${fmt(s.twoPct)}, 3P%: ${fmt(s.threePct)}`];
    if (revealed >= 1) out.push(`Position: ${safe(target.position)}`);
    if (revealed >= 2) out.push(`Country: ${safe(target.country)}`);
    if (revealed >= 3) out.push(`Team: ${safe(target.team)}`);
    $("#hintsList").innerHTML = out.map(x => `<li>${x}</li>`).join("");
  }

  function reset() {
    target = pickRandom();
    attempts = 0;
    revealed = 0;
    over = false;
    tried = new Set();

    $("#attemptsList").innerHTML = "";
    $("#result").textContent = "";
    $("#result").className = "result";
    ui.statusText.textContent = target ? "Game in progress…" : "Loading players…";
    $("#gameBox").classList.remove("hidden");
    if (target) renderHints();
  }

  async function submitGuess() {
    if (over || !target) return;

    const input = $("#guessInput");
    const val = input.value.trim();
    if (!val) return;

    // Dozvoli samo imena iz baze (klik iz predloga)
    if (!isValidName(val)) {
      $("#result").textContent = "⚠️ Izaberi igrača iz liste (klik na predlog). Slobodan unos nije dozvoljen.";
      $("#result").className = "result bad";
      return;
    }

    const norm = normalize(val);

    // blokiraj dupli pokušaj
    if (tried.has(norm)) {
      input.value = "";
      $("#result").textContent = "⚠️ Već si pokušao tog igrača. Izaberi nekog drugog.";
      $("#result").className = "result bad";
      return;
    }

    input.value = "";
    tried.add(norm);

    const correct = norm === normalize(target.name);
    attempts++;

    const li = document.createElement("li");
    li.textContent = val + (correct ? " ✅" : " ❌");
    $("#attemptsList").appendChild(li);

    if (!correct) {
      if (attempts === 3) revealed = Math.max(revealed, 1);
      if (attempts === 5) revealed = Math.max(revealed, 2);
      if (attempts === 7) revealed = Math.max(revealed, 3);
      if (attempts >= 10) {
        over = true;
        $("#result").textContent = `❌ Game over. Answer: ${target.name}`;
        $("#result").className = "result bad";
        ui.statusText.textContent = "Finished (LOSE)";
      }
      renderHints();
      return;
    }

    // pogođeno
    over = true;
    const pts = pointsForAttempt(attempts);

    // ako je ulogovan — sačuvaj poene u bazi
    try {
      const tok = getToken();
      if (tok) {
        const { balance } = await apiAddBalance(pts);
        ui.balanceVal.textContent = balance ?? 0;
      } else {
        // nije ulogovan — samo upozorenje, igra radi
        console.warn('Not signed in, points not saved.');
      }
    } catch (e) {
      console.error(e);
    }

    $("#result").textContent = `🎉 Correct! It was ${target.name} — +${pts} pts`;
    $("#result").className = "result ok";
    ui.statusText.textContent = "Finished (WIN)";
  }

  // Debounce util
  function debounce(fn, wait = 200) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  // Autocomplete: API ?q= prefix (od 1 slova, sa debounce; filtrira već pokušane)
  const handleSuggest = debounce(async (q) => {
    const box = $("#suggestions");
    const prefix = q.trim();

    if (prefix.length < 1) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }

    try {
      const list = await fetchSuggestions(prefix);
      const filtered = list
        .filter(p => !tried.has(normalize(p.name)))
        .slice(0, 8);

      if (!filtered.length) { box.classList.add("hidden"); box.innerHTML = ""; return; }

      box.classList.remove("hidden");
      box.innerHTML = "<ul>" + filtered
        .map(p => `<li data-name="${p.name}">${p.name} — ${p.team || ""}</li>`)
        .join("") + "</ul>";

      box.querySelectorAll("li").forEach(li => {
        li.addEventListener("click", () => {
          $("#guessInput").value = li.getAttribute("data-name");
          box.classList.add("hidden");
        });
      });
    } catch {
      box.classList.add("hidden");
      box.innerHTML = "";
    }
  }, 200);

  function attachEvents() {
    $("#newGameBtn").addEventListener("click", reset);

    $("#submitGuessBtn").addEventListener("click", submitGuess);
    $("#guessInput").addEventListener("keydown", e => { if (e.key === "Enter") submitGuess(); });
    $("#guessInput").addEventListener("input", e => handleSuggest(e.target.value));

    document.addEventListener("click", (e) => {
      const s = $("#suggestions");
      if (s && !s.contains(e.target) && e.target.id !== "guessInput") s.classList.add("hidden");
    });

    // auth modali
    $("#openLoginBtn").addEventListener("click", () => open($("#loginModal")));
    $("#openRegisterBtn").addEventListener("click", () => open($("#registerModal")));
    $("#logoutBtn").addEventListener("click", () => { clearToken(); refreshAuthUI(); });

    // submit login/register
    $("#loginSubmit").addEventListener("click", async () => {
      try {
        const out = await apiLogin($("#loginUser").value, $("#loginPass").value);
        saveToken(out.token);
        alert("✅ Uspešno ste se prijavili!");
        close();
        await refreshAuthUI();
      } catch (err) {
        alert("❌ Neuspešan login: " + err.message);
      }
    });

    $("#registerSubmit").addEventListener("click", async () => {
      try {
        const out = await apiRegister($("#regUser").value, $("#regPass").value);
        saveToken(out.token);
        alert("✅ Uspešno ste se registrovali!");
        close();
        await refreshAuthUI();
      } catch (err) {
        alert("❌ Greška: " + err.message);
      }
    });

    // zatvaranje modala klikom na masku ili Escape
    $("#modalMask").addEventListener("click", close);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  }

  // ===== INIT =====
  (async function init() {
    attachEvents();
    ui.statusText.textContent = "Loading players…";

    try {
      // auth UI (ako već postoji token)
      await refreshAuthUI();

      // igrači
      playersAll = await fetchAllPlayers();      // backend već filtrira GP ≥ 10
      validNames = new Set(playersAll.map(p => normalize(p.name)));
      if (!playersAll.length) {
        ui.statusText.textContent = "No players loaded from API.";
        return;
      }
      reset();
    } catch (e) {
      console.error(e);
      ui.statusText.textContent = "Failed to load players from API.";
    }
  })();
})();
