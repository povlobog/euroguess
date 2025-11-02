// public/script.js
(function () {
  const $ = (s) => document.querySelector(s);

  // Ako front i API služe sa istog Render servera, koristi relativno:
  const BASE_API = ""; // npr. "https://euroguess.onrender.com" -> "" radi isto kad je sve na istom hostu
  const TOKEN_KEY = "EG_TOKEN_V1";

  // ===== STATE =====
  let playersAll = [];
  let validNames = new Set();
  let target = null, attempts = 0, revealed = 0, over = false;
  let tried = new Set();
  let me = null; // {username, balance} ili null

  // ===== utils =====
  const normalize = s => (s || "").trim().toLowerCase();
  const fmt = v => (v == null ? "?" : (typeof v === "number" ? Math.round(v * 10) / 10 : v));
  const safe = s => s || "?";
  const pointsForAttempt = (n) => {
    const table = [100,70,50,35,25,18,12,8,5,3];
    return n>=1 && n<=table.length ? table[n-1] : 0;
  };

  // ===== token helpers =====
  const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);

  // ===== fetch helpers =====
  async function apiGet(path) {
    const res = await fetch(BASE_API + path, { headers: { "Authorization": `Bearer ${getToken()||""}` }});
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  async function apiPost(path, body) {
    const res = await fetch(BASE_API + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getToken()||""}`
      },
      body: JSON.stringify(body || {})
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  // ===== auth API =====
  async function tryMe() {
    try { me = await apiGet("/me"); } catch { me = null; }
    refreshAuthUI();
  }
  async function doLogin(username, password) {
    const data = await apiPost("/auth/login", { username, password });
    setToken(data.token);
    me = data.user;
    refreshAuthUI();
  }
  async function doRegister(username, password) {
    const data = await apiPost("/auth/register", { username, password });
    setToken(data.token);
    me = data.user;
    refreshAuthUI();
  }
  function doLogout() {
    clearToken(); me = null; refreshAuthUI();
  }

  // ===== balance (posle pogođene igre) =====
  async function addBalance(points) {
    if (!me) return;
    const data = await apiPost("/me/balance/add", { points });
    me.balance = data.balance;
    refreshAuthUI();
    loadLeaderboard();
  }

  // ===== players & leaderboard =====
  async function fetchAllPlayers() {
    const res = await fetch(`${BASE_API}/players`);
    if (!res.ok) throw new Error("Failed to load players");
    return res.json();
  }
  async function fetchSuggestions(prefix) {
    if (!prefix) return [];
    const res = await fetch(`${BASE_API}/players?q=${encodeURIComponent(prefix)}`);
    if (!res.ok) return [];
    return res.json();
  }
  async function loadLeaderboard() {
    try {
      const res = await fetch(`${BASE_API}/leaderboard`);
      const top = await res.json();
      $("#lbList").innerHTML = top.map(u => `<li><strong>${u.username}</strong> — ${u.balance} pts</li>`).join("");
    } catch {
      $("#lbList").innerHTML = `<li>Failed to load leaderboard.</li>`;
    }
  }

  // ===== UI refs =====
  const ui = {
    // header
    authStatus: $("#authStatus"),
    logoutBtn: $("#logoutBtn"),
    balanceBox: $("#balanceBox"),
    balanceVal: $("#balanceVal"),

    // auth gate
    authGate: $("#authGate"),

    // game
    statusText: $("#statusText"),
    newGameBtn: $("#newGameBtn"),
    submitGuessBtn: $("#submitGuessBtn"),
    guessInput: $("#guessInput"),

    // modals
    modalMask: $("#modalMask"),
    loginModal: $("#loginModal"),
    registerModal: $("#registerModal"),
    openLoginBtn: $("#openLoginBtn"),
    openRegisterBtn: $("#openRegisterBtn"),
    loginSubmit: $("#loginSubmit"),
    registerSubmit: $("#registerSubmit"),
    loginUser: $("#loginUser"),
    loginPass: $("#loginPass"),
    regUser: $("#regUser"),
    regPass: $("#regPass")
  };

  // ===== modal helpers =====
  function show(el){ el.classList.remove("hidden"); }
  function hide(el){ el.classList.add("hidden"); }
  function openModal(modal){
    show(ui.modalMask); show(modal);
  }
  function closeModal(){
    hide(ui.modalMask); hide(ui.loginModal); hide(ui.registerModal);
  }

  // ===== auth UI / gate =====
  function refreshAuthUI() {
    if (me) {
      ui.authStatus.textContent = `Signed in as ${me.username}`;
      ui.balanceVal.textContent = me.balance ?? 0;
      ui.balanceBox.classList.remove("hidden");
      ui.logoutBtn.classList.remove("hidden");

      // otključaj igru
      $("#gameBox").classList.remove("blocked");
      ui.authGate?.classList.add("hidden");
      ui.newGameBtn.disabled = false;
      ui.submitGuessBtn.disabled = false;
      ui.guessInput.disabled = false;
    } else {
      ui.authStatus.textContent = "Not signed in";
      ui.balanceBox.classList.add("hidden");
      ui.logoutBtn.classList.add("hidden");

      // zaključa igru
      ui.authGate?.classList.remove("hidden");
      ui.newGameBtn.disabled = true;
      ui.submitGuessBtn.disabled = true;
      ui.guessInput.disabled = true;
    }
  }

  // ===== game =====
  function buildValidNameSet(list){ validNames = new Set(list.map(p => normalize(p.name))); }
  function isValidName(name){ return validNames.has(normalize(name)); }
  function pickRandom(){ return playersAll.length ? playersAll[Math.floor(Math.random()*playersAll.length)] : null; }

  function renderHints() {
    const s = (target && target.stats) || {};
    const out = [
      `PTS: ${fmt(s.pts)}`,
      `2P%: ${fmt(s.twoPct)}`,
      `3P%: ${fmt(s.threePct)}`,
      `AST: ${fmt(s.ast)}`,
      `TR: ${fmt(s.tr)}`
    ];
    if (revealed >= 1) out.push(`Position: ${safe(target.position)}`);
    if (revealed >= 2) out.push(`Country: ${safe(target.country)}`);
    if (revealed >= 3) out.push(`Team: ${safe(target.team)}`);
    $("#hintsList").innerHTML = out.map(x=>`<li>${x}</li>`).join("");
  }

  function reset() {
    target = pickRandom();
    attempts = 0; revealed = 0; over = false; tried = new Set();
    $("#attemptsList").innerHTML = "";
    $("#result").textContent = "";
    $("#result").className = "result";
    ui.statusText.textContent = target ? "Game in progress…" : "Loading players…";
    $("#gameBox").classList.remove("hidden");
    if (target) renderHints();
  }

  function submitGuess() {
    if (over || !target || !me) return;

    const input = ui.guessInput;
    const val = input.value.trim();
    if (!val) return;

    // dozvoljeno samo iz predloga/baze
    if (!isValidName(val)) {
      $("#result").textContent = "⚠️ Pick a player from the suggestions.";
      $("#result").className = "result bad";
      return;
    }

    const norm = normalize(val);
    if (tried.has(norm)) {
      input.value = "";
      $("#result").textContent = "⚠️ You already tried that player.";
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
    addBalance(pts); // upiše na /me/balance/add
    $("#result").textContent = `🎉 Correct! It was ${target.name} — +${pts} pts`;
    $("#result").className = "result ok";
    ui.statusText.textContent = "Finished (WIN)";
  }

  // ===== suggestions (debounce) =====
  function debounce(fn, wait=200){ let t=null; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args),wait);} }
  const handleSuggest = debounce(async (q) => {
    const box = $("#suggestions");
    const prefix = q.trim();
    if (prefix.length < 1) { box.classList.add("hidden"); box.innerHTML=""; return; }
    try {
      const list = await fetchSuggestions(prefix);
      const filtered = list.filter(p => !tried.has(normalize(p.name))).slice(0,8);
      if (!filtered.length){ box.classList.add("hidden"); box.innerHTML=""; return; }
      box.classList.remove("hidden");
      box.innerHTML = "<ul>" + filtered.map(p => `<li data-name="${p.name}">${p.name} — ${p.team || ""}</li>`).join("") + "</ul>";
      box.querySelectorAll("li").forEach(li => {
        li.addEventListener("click", () => {
          ui.guessInput.value = li.getAttribute("data-name");
          box.classList.add("hidden");
        });
      });
    } catch {
      box.classList.add("hidden"); box.innerHTML="";
    }
  }, 250);

  // ===== events =====
  function attachEvents(){
    // game
    ui.newGameBtn.addEventListener("click", reset);
    ui.submitGuessBtn.addEventListener("click", submitGuess);
    ui.guessInput.addEventListener("keydown", e => { if (e.key === "Enter") submitGuess(); });
    ui.guessInput.addEventListener("input", e => handleSuggest(e.target.value));
    document.addEventListener("click", (e) => {
      const s = $("#suggestions");
      if (s && !s.contains(e.target) && e.target.id !== "guessInput") s.classList.add("hidden");
    });

    // auth modals: otvaranje
    ui.openLoginBtn?.addEventListener("click", () => openModal(ui.loginModal));
    ui.openRegisterBtn?.addEventListener("click", () => openModal(ui.registerModal));

    // auth modals: submit
    ui.loginSubmit?.addEventListener("click", async () => {
      const u = ui.loginUser.value, p = ui.loginPass.value;
      try { await doLogin(u, p); closeModal(); alert("✅ Logged in!"); }
      catch { alert("❌ Login failed"); }
    });
    ui.registerSubmit?.addEventListener("click", async () => {
      const u = ui.regUser.value, p = ui.regPass.value;
      try { await doRegister(u, p); closeModal(); alert("✅ Registered!"); }
      catch { alert("❌ Register failed"); }
    });

    // logout
    ui.logoutBtn?.addEventListener("click", () => { doLogout(); });

    // modal mask + Escape -> close
    ui.modalMask?.addEventListener("click", closeModal);
    document.addEventListener("keydown", (e)=>{ if (e.key === "Escape") closeModal(); });
  }

  // ===== init =====
  (async function init(){
    attachEvents();
    refreshAuthUI();
    ui.statusText.textContent = "Loading players…";

    // 1) Ko je ulogovan?
    await tryMe();

    // 2) Leaderboard
    loadLeaderboard();

    // 3) Igrači
    try {
      playersAll = await fetchAllPlayers();
      validNames = new Set(playersAll.map(p => normalize(p.name)));
      if (me) reset();
      else ui.statusText.textContent = "Please log in to start a game.";
    } catch {
      ui.statusText.textContent = "Failed to load players from API.";
    }
  })();
})();
