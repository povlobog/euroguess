// script.js — EuroGuess frontend (LOCAL <-> API auth preklopnik)
(function () {
  const $ = (s) => document.querySelector(s);

  // ================== PODESAVANJE ==================
  const BASE_API  = "http://localhost:8080"; // za deploy promeni na tvoj host
  const AUTH_MODE = "local";                  // "local" (danas) -> promeni u "api" kad ubacimo server auth

  // ================== STATE ==================
  let playersAll = [];            // svi igrači (GP >= 10) iz API-ja
  let validNames = new Set();     // skup normalizovanih imena (samo iz baze)
  let target = null, attempts = 0, revealed = 0, over = false;
  let tried = new Set();          // sprečava duple pokušaje

  // ================== SCORING ==================
  function pointsForAttempt(n) {
    const table = [100, 70, 50, 35, 25, 18, 12, 8, 5, 3]; // 1..10
    return n >= 1 && n <= table.length ? table[n - 1] : 0;
  }

  // ================== AUTH PROVIDERS ==================
  // -- LOCAL (trenutno aktivan) --
  const LocalAuth = (() => {
    const LS_USERS   = "EG_USERS_V1";
    const LS_SESSION = "EG_SESSION_V1";

    const loadUsers = () => { try { return JSON.parse(localStorage.getItem(LS_USERS)) || []; } catch { return []; } };
    const saveUsers = (u) => localStorage.setItem(LS_USERS, JSON.stringify(u));
    const setSession = (u) => localStorage.setItem(LS_SESSION, u);
    const clearSession = () => localStorage.removeItem(LS_SESSION);

    function currentUser() {
      const u = localStorage.getItem(LS_SESSION);
      if (!u) return null;
      return loadUsers().find(x => x.username === u) || null;
    }
    function getBalance() { const u = currentUser(); return u ? (u.balance || 0) : 0; }
    function addBalance(pts) {
      const u = currentUser(); if (!u) return;
      const list = loadUsers(); const i = list.findIndex(x => x.username === u.username);
      if (i >= 0) { list[i].balance = (list[i].balance || 0) + pts; saveUsers(list); }
    }
    function register(username, password) {
      username = (username || "").trim(); password = (password || "").trim();
      if (!username || !password) throw new Error("Missing fields");
      const list = loadUsers();
      if (list.some(u => u.username.toLowerCase() === username.toLowerCase()))
        throw new Error("Username already exists");
      list.push({ username, password, balance: 0 }); saveUsers(list); setSession(username);
      return { username, balance: 0 };
    }
    function login(username, password) {
      const u = loadUsers().find(x => x.username === username && x.password === password);
      if (!u) throw new Error("Invalid credentials");
      setSession(u.username); return { username: u.username, balance: u.balance };
    }
    return {
      type: "local",
      async register(u,p){ return register(u,p); },
      async login(u,p){ return login(u,p); },
      async logout(){ clearSession(); },
      async me(){ const u = currentUser(); return u ? { username:u.username, balance:u.balance } : null; },
      async getBalance(){ return getBalance(); },
      async addBalance(pts){ return addBalance(pts); },
    };
  })();

  // -- API (aktiviraj kasnije menjanjem AUTH_MODE="api") --
  const ApiAuth = (() => {
    const LS_TOKEN = "EG_TOKEN_V1";
    const setToken = (t) => localStorage.setItem(LS_TOKEN, t);
    const getToken = () => localStorage.getItem(LS_TOKEN);
    const clearToken = () => localStorage.removeItem(LS_TOKEN);

    async function api(path, opts = {}) {
      const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
      const token = getToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`${BASE_API}${path}`, Object.assign({}, opts, { headers }));
      return res;
    }
    return {
      type: "api",
      async register(username, password){
        const res = await api("/auth/register", { method:"POST", body: JSON.stringify({ username, password }) });
        const data = await res.json(); if(!res.ok) throw new Error(data.error || "Register failed");
        setToken(data.token); return { username: data.user.username, balance: data.user.balance };
      },
      async login(username, password){
        const res = await api("/auth/login", { method:"POST", body: JSON.stringify({ username, password }) });
        const data = await res.json(); if(!res.ok) throw new Error(data.error || "Login failed");
        setToken(data.token); return { username: data.user.username, balance: data.user.balance };
      },
      async logout(){ clearToken(); },
      async me(){
        const token = getToken(); if(!token) return null;
        const res = await api("/me"); if(!res.ok){ clearToken(); return null; }
        const data = await res.json(); return { username: data.username, balance: data.balance };
      },
      async getBalance(){
        const u = await this.me(); return u ? (u.balance || 0) : 0;
      },
      async addBalance(points){
        await api("/me/balance/add", { method:"POST", body: JSON.stringify({ points }) });
      },
    };
  })();

  const Auth = (AUTH_MODE === "api") ? ApiAuth : LocalAuth;

  // ================== UI REFS ==================
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

  async function refreshAuthUI() {
    const user = await Auth.me();
    if (!user) {
      ui.authStatus.textContent = "Not signed in";
      hide(ui.logoutBtn); show(ui.openLoginBtn); show(ui.openRegisterBtn); hide(ui.balanceBox);
    } else {
      ui.authStatus.textContent = `Signed in as ${user.username}`;
      show(ui.logoutBtn); hide(ui.openLoginBtn); hide(ui.openRegisterBtn); show(ui.balanceBox);
      ui.balanceVal.textContent = user.balance;
    }
  }

  // ================== API HELPERS ==================
  async function fetchAllPlayers() {
    const res = await fetch(`${BASE_API}/players`);
    if (!res.ok) throw new Error("Failed to load players");
    return await res.json();
  }
  async function fetchSuggestions(prefix) {
    if (!prefix) return [];
    const res = await fetch(`${BASE_API}/players?q=${encodeURIComponent(prefix)}`);
    if (!res.ok) return [];
    return await res.json();
  }

  // ================== GAME ==================
  const normalize = (s) => (s || "").trim().toLowerCase();
  function fmt(v) { if (v == null) return "?"; return typeof v === "number" ? Math.round(v * 10) / 10 : v; }
  const safe = (s) => s || "?";

  function buildValidNameSet(list) { validNames = new Set(list.map(p => normalize(p.name))); }
  function isValidName(name) { return validNames.has(normalize(name)); }

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

    // dozvoljeno samo ime iz baze (klik iz predloga)
    if (!isValidName(val)) {
      $("#result").textContent = "⚠️ Izaberi igrača iz liste (klik na predlog). Slobodan unos nije dozvoljen.";
      $("#result").className = "result bad";
      return;
    }

    const norm = normalize(val);

    // bez duplih pokušaja
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

    await Auth.addBalance(pts);   // local ili api, zavisi od AUTH_MODE
    await refreshAuthUI();

    $("#result").textContent = `🎉 Correct! It was ${target.name} — +${pts} pts`;
    $("#result").className = "result ok";
    ui.statusText.textContent = "Finished (WIN)";
  }

  // ================== AUTOCOMPLETE ==================
  function debounce(fn, wait = 200) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  }

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
      const filtered = list.filter(p => !tried.has(normalize(p.name))).slice(0, 8);

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

  // ================== EVENTS & INIT ==================
  function attachEvents() {
    $("#newGameBtn").addEventListener("click", reset);
    $("#submitGuessBtn").addEventListener("click", submitGuess);
    $("#guessInput").addEventListener("keydown", e => { if (e.key === "Enter") submitGuess(); });
    $("#guessInput").addEventListener("input", e => handleSuggest(e.target.value));

    document.addEventListener("click", (e) => {
      const s = $("#suggestions");
      if (s && !s.contains(e.target) && e.target.id !== "guessInput") s.classList.add("hidden");
    });

    // auth open/close
    $("#openLoginBtn").addEventListener("click", () => open($("#loginModal")));
    $("#openRegisterBtn").addEventListener("click", () => open($("#registerModal")));
    $("#logoutBtn").addEventListener("click", async () => { await Auth.logout(); await refreshAuthUI(); });

    // auth submit
    $("#loginSubmit").addEventListener("click", async () => {
      try {
        await Auth.login($("#loginUser").value, $("#loginPass").value);
        alert("✅ Uspešno ste se prijavili!");
        close(); await refreshAuthUI();
      } catch (err) { alert("❌ Neuspešan login: " + err.message); }
    });
    $("#registerSubmit").addEventListener("click", async () => {
      try {
        await Auth.register($("#regUser").value, $("#regPass").value);
        alert("✅ Uspešno ste se registrovali!");
        close(); await refreshAuthUI();
      } catch (err) { alert("❌ Greška: " + err.message); }
    });

    $("#modalMask").addEventListener("click", close);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  }

  (async function init() {
    attachEvents();
    await refreshAuthUI();
    ui.statusText.textContent = "Loading players…";
    try {
      playersAll = await fetchAllPlayers();
      validNames = new Set(playersAll.map(p => (p.name || "").trim().toLowerCase()));
      if (!playersAll.length) { ui.statusText.textContent = "No players loaded from API."; return; }
      reset();
    } catch (e) {
      console.error(e);
      ui.statusText.textContent = "Failed to load players from API.";
    }
  })();
})();
