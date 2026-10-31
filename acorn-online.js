/* 도토리 게임: 전체 닉네임 확인, 계정 로그인, 서버 저장, 랭킹. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const AUTH_KEY = "acorn_online_session_v1";
  const BACKUP_KEY = "acorn_local_backups_v1";
  let base = String(window.ACORN_SERVER_URL || "").replace(/\/+$/, "");
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    base = location.origin;
  } else if (!base && location.protocol !== "file:" && !location.hostname.endsWith(".github.io")) {
    base = location.origin;
  }
  let auth = null;
  try { auth = JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); } catch (_) {}
  if (!auth || typeof auth.token !== "string") auth = null;

  let connected = false, busy = false, ready = false, conflict = false;
  let saveTimer = null, inFlight = null, generation = 0, revision = 0;
  let availabilityTimer = null, availabilitySeq = 0, checkedNick = "", available = false;
  let resumeTried = false, importingTouched = false, signingOut = false;
  let metric = "acorns", rankingSeq = 0, cachedRanking = null;

  function status(message, bad = false) {
    for (const id of ["onlineConnection", "onlineSaveStatus"]) {
      const element = $(id);
      element.textContent = message;
      element.classList.toggle("is-error", bad);
    }
  }

  async function api(path, options = {}) {
    if (!base) throw new Error("서버 연결을 준비 중이에요.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}) };
      const token = options.token === undefined ? auth?.token : options.token;
      if (token) headers.Authorization = "Bearer " + token;
      const response = await fetch(base + path, {
        method: options.method || "GET", headers,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal, cache: "no-store", credentials: "omit",
        ...(options.keepalive ? { keepalive: true } : {})
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) {
        const error = new Error(data?.message || "서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.");
        error.status = response.status;
        error.code = data?.error;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.status) throw error;
      throw new Error("서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.");
    } finally { clearTimeout(timeout); }
  }

  function storeAuth() {
    if (auth) localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    else localStorage.removeItem(AUTH_KEY);
  }

  function backupLocal(nickname) {
    if (!Object.hasOwn(profiles, nickname)) return;
    try {
      const backups = JSON.parse(localStorage.getItem(BACKUP_KEY) || "[]");
      backups.unshift({ nickname, at: Date.now(), state: profiles[nickname] });
      localStorage.setItem(BACKUP_KEY, JSON.stringify(backups.slice(0, 5)));
    } catch (_) {}
  }

  function localEntries() {
    return Object.entries(profiles).filter(([, p]) => p && typeof p === "object" && !Array.isArray(p));
  }

  function fillLocalOptions() {
    const entries = localEntries();
    for (const id of ["importProfile", "offlineProfile"]) {
      const select = $(id), previous = select.value;
      select.replaceChildren();
      if (id === "importProfile") select.add(new Option("새 기록으로 시작", ""));
      for (const [nick] of entries) select.add(new Option(nick, nick));
      if ([...select.options].some(option => option.value === previous)) select.value = previous;
    }
    $("importWrap").hidden = entries.length === 0;
    $("offlineWrap").hidden = entries.length === 0;
  }

  function updateSignup() {
    const nickname = sanitizeNick(newNick.value);
    if (!importingTouched && Object.hasOwn(profiles, nickname)) $("importProfile").value = nickname;
    const password = $("newPassword").value;
    const confirm = $("confirmPassword").value;
    const validPassword = [...password].length >= 8 && [...password].length <= 128;
    $("newPassHint").textContent = password && !validPassword ? "비밀번호는 8~128자로 입력해 주세요." :
      confirm && password !== confirm ? "비밀번호가 서로 달라요." : "";
    if (nickname !== checkedNick) {
      checkedNick = nickname;
      available = false;
      clearTimeout(availabilityTimer);
      const sequence = ++availabilitySeq;
      if (isValidNick(nickname) && connected) {
        setMsg(newMsg, "전체 유저의 닉네임을 확인하고 있어요…", null);
        availabilityTimer = setTimeout(async () => {
          try {
            const data = await api("/api/nicknames/available?nickname=" + encodeURIComponent(nickname), { token: null });
            if (sequence !== availabilitySeq) return;
            available = data.available === true;
            setMsg(newMsg, available ? "사용 가능한 닉네임이에요." : "이미 누군가 사용 중인 닉네임이에요.", available ? "good" : "bad");
          } catch (error) {
            if (sequence !== availabilitySeq) return;
            available = false;
            setMsg(newMsg, error.message, "bad");
          }
          refreshSignupButton();
        }, 350);
      } else {
        setMsg(newMsg, nickname && !isValidNick(nickname) ? "닉네임은 1~20자로 입력해 주세요." :
          !connected ? "서버에 연결되면 닉네임을 확인할 수 있어요." : "", null);
      }
    }
    refreshSignupButton();
  }

  function refreshSignupButton() {
    const password = $("newPassword").value;
    newStart.disabled = !connected || busy || !available ||
      !isValidNick(sanitizeNick(newNick.value)) || [...password].length < 8 ||
      [...password].length > 128 || password !== $("confirmPassword").value;
  }

  function updateLogin() {
    oldEnter.disabled = !connected || busy || !isValidNick(sanitizeNick(oldNick.value)) ||
      [...$("oldPassword").value].length < 8;
  }

  function enterAccount(data, token) {
    generation++;
    ready = false;
    conflict = false;
    clearTimeout(saveTimer);
    saveTimer = null;
    backupLocal(data.nickname);
    auth = { nickname: data.nickname, token: token || data.token };
    storeAuth();
    revision = data.revision;
    if (data.state && Object.keys(data.state).length) {
      profiles[data.nickname] = data.state;
      saveProfiles(profiles);
      loadProfile(data.nickname);
    } else {
      createProfile(data.nickname);
    }
    overlay.style.display = "none";
    setLocked(false);
    nickWrap.style.display = "block";
    switchPage("home");
    render();
    ready = true;
    $("newPassword").value = "";
    $("confirmPassword").value = "";
    $("oldPassword").value = "";
    status("온라인 · 기록 자동 저장");
    saveCurrent();
  }

  async function register() {
    if (newStart.disabled || busy) return;
    busy = true;
    refreshSignupButton(); updateLogin();
    setMsg(newMsg, "닉네임을 등록하고 있어요…", null);
    try {
      const source = $("importProfile").value;
      const state = source && Object.hasOwn(profiles, source) ? profiles[source] : {};
      const data = await api("/api/register", { method: "POST", token: null, body: {
        nickname: sanitizeNick(newNick.value), password: $("newPassword").value, state
      } });
      enterAccount(data);
    } catch (error) {
      if (error.code === "nickname_taken") available = false;
      setMsg(newMsg, error.message, "bad");
    } finally { busy = false; refreshSignupButton(); updateLogin(); }
  }

  async function login() {
    if (oldEnter.disabled || busy) return;
    busy = true;
    refreshSignupButton(); updateLogin();
    setMsg(oldMsg, "기록을 불러오고 있어요…", null);
    try {
      const data = await api("/api/login", { method: "POST", token: null, body: {
        nickname: sanitizeNick(oldNick.value), password: $("oldPassword").value
      } });
      enterAccount(data);
    } catch (error) { setMsg(oldMsg, error.message, "bad"); }
    finally { busy = false; refreshSignupButton(); updateLogin(); }
  }

  function scheduleSave() {
    if (!ready || !auth || conflict || signingOut || currentNick !== auth.nickname || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 10000);
  }

  async function flush(keepalive = false) {
    if (inFlight) return inFlight;
    if (!ready || !auth || conflict || currentNick !== auth.nickname) return false;
    clearTimeout(saveTimer); saveTimer = null;
    const activeGeneration = generation;
    const token = auth.token;
    const state = buildSaveData();
    status("온라인 · 기록 저장 중…");
    inFlight = (async () => {
      try {
        const data = await api("/api/me/state", { method: "PUT", token, keepalive,
          body: { state, revision } });
        if (activeGeneration === generation) {
          revision = data.revision;
          status("온라인 · 서버에 저장했어요");
        }
        return true;
      } catch (error) {
        if (activeGeneration !== generation) return false;
        if (error.code === "save_conflict") {
          conflict = true; ready = false; backupLocal(currentNick);
          status("다른 창에서 기록이 바뀌었어요. 로그아웃 후 다시 로그인해 주세요.", true);
        } else if (error.status === 401) {
          ready = false; auth = null; storeAuth();
          status("로그인이 만료됐어요. 이 기기에는 저장됐고, 다시 로그인하면 온라인으로 연결돼요.", true);
        } else {
          status("이 기기에 저장했어요. 서버 연결 후 다시 저장할게요.", true);
          if (!signingOut) scheduleSave();
        }
        return false;
      } finally { inFlight = null; }
    })();
    return inFlight;
  }

  async function signOut() {
    if (signingOut) return;
    signingOut = true;
    setLocked(true);
    // Wait for an older save, then send the latest local state before revoking its token.
    if (inFlight) await inFlight;
    await flush();
    ready = false;
    const token = auth?.token;
    auth = null; storeAuth(); generation++; resumeTried = true;
    clearTimeout(saveTimer); saveTimer = null;
    if (token) {
      try { await api("/api/logout", { method: "POST", token }); } catch (_) {}
    }
    signingOut = false;
    finishLogout();
    status(connected ? "서버에 연결됐어요." : "현재 서버에 연결할 수 없어요.", !connected);
  }

  async function resume() {
    if (!connected || !auth || resumeTried || currentNick || busy || signingOut) return;
    resumeTried = true;
    busy = true; refreshSignupButton(); updateLogin();
    try { const data = await api("/api/me"); enterAccount(data, auth.token); }
    catch (error) {
      if (error.status === 401) { auth = null; storeAuth(); }
      else resumeTried = false;
      setMsg(oldMsg, error.message, "bad");
    } finally { busy = false; refreshSignupButton(); updateLogin(); }
  }

  function onOverlay() {
    fillLocalOptions();
    checkedNick = "\0"; available = false;
    updateSignup(); updateLogin();
    resume();
  }

  async function probe() {
    try {
      const data = await api("/api/health", { token: null });
      if (data.ok !== true || data.api !== 1) throw new Error("잘못된 서버");
      const wasConnected = connected;
      connected = true;
      if (!ready && !conflict) status("서버에 연결됐어요.");
      if (!wasConnected) { checkedNick = "\0"; updateSignup(); }
      updateLogin();
      if (overlay.style.display === "flex") resume();
      if (ready) scheduleSave();
    } catch (_) {
      connected = false; available = false;
      status("현재 서버에 연결할 수 없어요. 이 기기의 기존 기록은 오프라인으로 플레이할 수 있어요.", true);
      refreshSignupButton(); updateLogin();
    }
  }

  function setNumber(element, value) {
    element.textContent = fmtShort(value);
    element.title = Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 0 });
  }

  function drawRanking(data) {
    const first = data.rows[0];
    $("rankingChampion").hidden = !first;
    $("rankingEmpty").hidden = Boolean(first);
    if (first) {
      $("rankingChampionNick").textContent = first.nickname;
      setNumber($("rankingChampionAcorns"), first.acorns);
      setNumber($("rankingChampionTrophies"), first.trophies);
    }
    $("rankingPlayers").textContent = "전체 " + data.players.toLocaleString("ko-KR") + "명 · 상위 50명";
    const body = $("rankingRows");
    body.replaceChildren();
    for (const row of data.rows) {
      const tr = document.createElement("tr");
      if (row.nickname === auth?.nickname) tr.classList.add("is-me");
      const rank = document.createElement("td");
      rank.textContent = row.rank <= 3 ? ["🥇", "🥈", "🥉"][row.rank - 1] : String(row.rank);
      const nick = document.createElement("td");
      nick.textContent = row.nickname + (row.nickname === auth?.nickname ? " (나)" : "");
      const acorns = document.createElement("td"), trophies = document.createElement("td");
      setNumber(acorns, row.acorns); setNumber(trophies, row.trophies);
      tr.append(rank, nick, acorns, trophies); body.append(tr);
    }
  }

  async function loadRanking() {
    const sequence = ++rankingSeq;
    $("rankingStatus").textContent = "전체 유저의 기록을 불러오고 있어요…";
    $("rankingRefresh").disabled = true;
    try {
      if (ready) { if (inFlight) await inFlight; await flush(); }
      const data = await api("/api/leaderboard?metric=" + metric, { token: null });
      if (sequence !== rankingSeq) return;
      cachedRanking = data;
      drawRanking(data);
      $("rankingStatus").textContent = "마지막 갱신 " + new Date(data.updatedAt * 1000).toLocaleTimeString("ko-KR") + " · 약 10초마다 기록 저장";
    } catch (error) {
      if (sequence !== rankingSeq) return;
      $("rankingStatus").textContent = cachedRanking ? "연결이 끊겼어요. 마지막으로 받은 기록을 표시하고 있어요." : error.message;
    } finally { if (sequence === rankingSeq) $("rankingRefresh").disabled = false; }
  }

  window.AcornOnline = {
    updateSignup, updateLogin, register, login, scheduleSave, signOut, onOverlay,
    onPage(page) { if (page === "ranking") loadRanking(); }
  };

  for (const id of ["newPassword", "confirmPassword"]) $(id).addEventListener("input", updateSignup);
  $("oldPassword").addEventListener("input", () => { setMsg(oldMsg, "", null); updateLogin(); });
  $("oldPassword").addEventListener("keydown", event => {
    if (event.key === "Enter" && !oldEnter.disabled) login();
  });
  $("confirmPassword").addEventListener("keydown", event => {
    if (event.key === "Enter" && !newStart.disabled) register();
  });
  $("importProfile").addEventListener("change", () => { importingTouched = true; });
  $("offlineEnter").addEventListener("click", () => {
    if (busy || signingOut) return;
    const nickname = $("offlineProfile").value;
    if (!Object.hasOwn(profiles, nickname)) return;
    generation++; ready = false; auth = null; storeAuth(); resumeTried = true;
    clearTimeout(saveTimer); saveTimer = null;
    loadProfile(nickname);
    overlay.style.display = "none"; setLocked(false); nickWrap.style.display = "block";
    switchPage("home"); render();
    status("오프라인 플레이 · 온라인 순위에는 반영되지 않아요.");
  });
  $("rankingRefresh").addEventListener("click", loadRanking);
  document.querySelectorAll("[data-ranking-metric]").forEach(button => {
    button.addEventListener("click", () => {
      metric = button.dataset.rankingMetric;
      document.querySelectorAll("[data-ranking-metric]").forEach(tab => {
        const selected = tab === button;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-pressed", String(selected));
      });
      loadRanking();
    });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && ready) { saveCurrent(); flush(true); }
  });
  window.addEventListener("pagehide", () => { if (ready && !inFlight) flush(true); });
  setInterval(probe, 20000);
  setInterval(() => { if (currentPage === "ranking" && currentNick) loadRanking(); }, 20000);
  fillLocalOptions();
  status("서버에 연결하고 있어요…");
  probe();
  if (overlay.style.display === "flex") onOverlay();
})();
