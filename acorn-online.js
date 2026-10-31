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
    const validPassword = [...password].length >= 4;
    $("newPassHint").textContent = password && !validPassword ? "비밀번호는 4자 이상 입력해 주세요." :
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
        setMsg(newMsg, nickname && !isValidNick(nickname) ? "닉네임은 1자 이상 입력해 주세요." :
          !connected ? "서버에 연결되면 닉네임을 확인할 수 있어요." : "", null);
      }
    }
    refreshSignupButton();
  }

  function refreshSignupButton() {
    const password = $("newPassword").value;
    newStart.disabled = !connected || busy || !available ||
      !isValidNick(sanitizeNick(newNick.value)) || [...password].length < 4 ||
      password !== $("confirmPassword").value;
  }

  function updateLogin() {
    oldEnter.disabled = !connected || busy || !isValidNick(sanitizeNick(oldNick.value)) ||
      [...$("oldPassword").value].length < 4;
  }

  function enterAccount(data, token) {
    const cached=bestCache[data.nickname],epoch=Number(data.progressEpoch||0),local=profiles[data.nickname];
    const canRecover=cached?cached.epoch===epoch&&(!cached.accountId||cached.accountId===data.id):epoch===0;
    const recovered=canRecover?Math.max(Number(local?.jumpBestScore)||0,Number(cached?.score)||0):0;
    if(recovered>Number(data.state?.jumpBestScore||0))data.state={...(data.state||{}),jumpBestScore:recovered};
    generation++;
    ready = false;
    conflict = false;
    clearTimeout(saveTimer);
    saveTimer = null;
    backupLocal(data.nickname);
    auth = { id:data.id, nickname: data.nickname, token: token || data.token };
    accountInfo=data;progressEpoch=Number(data.progressEpoch||0);pendingPhoto=null;syncAccount(data);
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
    if(recovered>0)saveJumpRecord();
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
        nickname: sanitizeNick(newNick.value), password: $("newPassword").value, state, avatarDataUrl:profileCache[source]?.avatarDataUrl||""
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
    rememberBest();
    if (!ready || !auth || conflict || signingOut || profileBusy || currentNick !== auth.nickname || saveTimer) return;
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
          body: { state, revision, progressEpoch } });
        if (activeGeneration === generation) {
          revision = data.revision;
          syncAccount(data);
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
    if (signingOut || profileBusy) return;
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
    pendingPhoto=null;accountInfo={};clearProfilePasswords();
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
      if(!data.features?.profiles){connected=false;available=false;status("서버가 최신 기능을 준비 중이에요. 서버 업데이트 후 다시 접속해 주세요.",true);refreshSignupButton();updateLogin();profileStamp="";paintProfile();return;}
      const wasConnected = connected;
      connected = true;
      if (!ready && !conflict) status("서버에 연결됐어요.");
      if (!wasConnected) { checkedNick = "\0"; updateSignup(); }
      updateLogin();
      if (overlay.style.display === "flex") resume();
      if (ready) { await refreshAccount(); scheduleSave(); }
      profileStamp="";paintProfile();
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
      $("rankingChampionTrophies").textContent=exactNumber(first.trophies);
      const tier=first.trophyRank||tierFor(first.trophies);
      paintAvatar($("rankingChampionAvatarFrame"),$("rankingChampionAvatar"),imageSource(first.avatarUrl),tier);
      paintTier($("rankingChampionTier"),tier);
      setNumber($("rankingChampionJump"), first.jumpBestScore ?? 0);
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
      const tier=row.trophyRank||tierFor(row.trophies),person=document.createElement("div");person.className="rank-person";
      const frame=document.createElement("span"),photo=document.createElement("img"),fallback=document.createElement("span");
      frame.className="avatar-frame";fallback.className="avatar-fallback";fallback.textContent="🌰";photo.alt=row.nickname+"의 프로필 사진";
      frame.append(photo,fallback);paintAvatar(frame,photo,imageSource(row.avatarUrl),tier);
      const label=document.createElement("span");label.className="rank-person-name";label.textContent=row.nickname+(row.nickname===auth?.nickname?" (나)":"");person.append(frame,label);nick.append(person);
      const acorns = document.createElement("td"), trophies = document.createElement("td");
      const jump = document.createElement("td");
      setNumber(acorns, row.acorns);
      const count=document.createElement("strong"),grade=document.createElement("span");count.className="rank-trophy-count";count.textContent=exactNumber(row.trophies);grade.className="rank-tier";grade.textContent=[tier.medal,tier.name,tier.stars].filter(Boolean).join(" ");grade.style.setProperty("--rank-color",tier.color);trophies.append(count,grade);
      setNumber(jump, row.jumpBestScore ?? 0);
      tr.append(rank, nick, acorns, trophies, jump); body.append(tr);
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

  const TIER_COLORS = {unranked:"#8c849b",bronze:"#c4864d",silver:"#d7dce7",gold:"#ffd84d",platinum:"#e9f0f8",emerald:"#5adca0",diamond:"#78beff",reddiamond:"#ff6e82",hero:"#ffbc5e",myth:"#b081ff",legend:"#ffd65c",master:"#f0faff"};
  function readCache(key) { try { const value=JSON.parse(localStorage.getItem(key)||"{}");return value&&typeof value==="object"&&!Array.isArray(value)?value:{}; } catch (_) {return {};} }
  const profileCache=readCache("acorn_profile_meta_v1"), bestCache=readCache("acorn_jump_best_v1");
  let accountInfo={},progressEpoch=0,profileBusy=false,pendingPhoto=null,beforeProfile="home",profileStamp="",criticalSave=null;
  let profileNickTimer=null,profileNickSeq=0,profileNickAvailable=false;
  function saveCaches(){try{localStorage.setItem("acorn_profile_meta_v1",JSON.stringify(profileCache));localStorage.setItem("acorn_jump_best_v1",JSON.stringify(bestCache));}catch(_){}}
  function rememberBest(){
    if(!currentNick)return;
    const prior=bestCache[currentNick],epoch=auth?progressEpoch:(profileCache[currentNick]?.progressEpoch||0);
    const next={score:Math.max(Number(jumpBestScore)||0,prior?.epoch===epoch?Number(prior.score)||0:0),epoch,accountId:auth?.id||profileCache[currentNick]?.id||null};
    if(prior&&prior.score===next.score&&prior.epoch===next.epoch&&prior.accountId===next.accountId)return;
    bestCache[currentNick]=next;saveCaches();
  }
  function tierFor(value){let rank={name:"무등급",kind:"unranked",stars:"",medal:"🌰",need:0};for(const item of TROPHY_RANKS){if(value>=item.need)rank=item;}return {...rank,color:TIER_COLORS[rank.kind]};}
  function imageSource(value){return /^\/api\/avatars\/[0-9]+\/[0-9]+$/.test(value||"")?base+value:"";}
  function ownPhoto(){const meta=profileCache[currentNick]||{};return auth&&auth.nickname===currentNick?imageSource(accountInfo.avatarUrl):meta.avatarDataUrl||imageSource(meta.avatarUrl);}
  function paintAvatar(frame,img,source,rank){
    frame.style.setProperty("--rank-color",rank.color||TIER_COLORS.unranked);
    if(img.dataset.source===source)return;
    img.dataset.source=source;const fallback=frame.querySelector(".avatar-fallback");img.hidden=!source;fallback.hidden=Boolean(source);
    img.onerror=()=>{img.hidden=true;fallback.hidden=false;};
    if(source)img.src=source;else img.removeAttribute("src");
  }
  function paintTier(element,rank){element.textContent=[rank.medal,rank.name,rank.stars].filter(Boolean).join(" ");element.style.setProperty("--rank-color",rank.color);}
  function exactNumber(value){return Number(value||0).toLocaleString("ko-KR",{maximumFractionDigits:0});}
  function syncAccount(data){
    if(!data?.nickname)return;
    const resetElsewhere=Boolean(currentNick&&ready&&Number(data.progressEpoch||0)!==progressEpoch);
    if(resetElsewhere){ready=false;conflict=true;status("다른 기기에서 기록이 초기화됐어요. 로그아웃 후 다시 로그인해 주세요.",true);}
    const old=currentNick;
    if(old&&auth&&data.id===auth.id&&old!==data.nickname){
      backupLocal(old);backupLocal(data.nickname);profiles[data.nickname]=buildSaveData();delete profiles[old];
      if(profileCache[old]){profileCache[data.nickname]=profileCache[old];delete profileCache[old];}
      if(bestCache[old]){bestCache[data.nickname]=bestCache[old];delete bestCache[old];}
      currentNick=data.nickname;saveProfiles(profiles);
    }
    accountInfo={...accountInfo,...data};if(!resetElsewhere)progressEpoch=Number(data.progressEpoch||0);
    if(!resetElsewhere&&ready&&Number(data.jumpBestScore)>jumpBestScore){jumpBestScore=Number(data.jumpBestScore);profiles[currentNick]=buildSaveData();saveProfiles(profiles);rememberBest();updateJumpTexts();}
    if(auth){auth.id=data.id;auth.nickname=data.nickname;storeAuth();}
    const prior=profileCache[data.nickname]||{};
    profileCache[data.nickname]={...prior,id:data.id,avatarUrl:data.avatarUrl||"",progressEpoch,
      avatarDataUrl:prior.avatarUrl===data.avatarUrl?prior.avatarDataUrl||"":""};saveCaches();profileStamp="";paintProfile();
  }
  function paintProfile(){
    if(!currentNick)return;
    const rank=tierFor(achievementCount),photo=ownPhoto();
    paintAvatar($("nickAvatarFrame"),$("nickAvatar"),photo,rank);
    const stamp=JSON.stringify([currentNick,rank.name,achievementCount,photo,pendingPhoto,profileBusy,ready,connected,conflict]);
    if(stamp===profileStamp)return;profileStamp=stamp;
    $("profileDisplayNick").textContent=currentNick;paintTier($("profileTier"),rank);
    $("profileTrophies").textContent="현재 트로피 "+exactNumber(achievementCount)+"개";
    paintAvatar($("profileAvatarFrame"),$("profileAvatar"),pendingPhoto===null?photo:pendingPhoto,rank);
    const canEdit=Boolean(auth&&ready&&connected&&!conflict&&!profileBusy);
    $("profileOnlineHint").hidden=Boolean(auth&&ready);
    for(const id of ["profileNickname","profileCurrentPassword","profileNewPassword","profileConfirmPassword"])$(id).disabled=!canEdit;
    $("profileChoosePhoto").disabled=profileBusy;$("profileDefaultPhoto").disabled=profileBusy;
    $("btnLogout").disabled=profileBusy;$("btnResetNick").disabled=profileBusy;
    $("profileSavePhoto").disabled=profileBusy||pendingPhoto===null;
    $("profileSaveNickname").disabled=!canEdit||!profileNickAvailable||sanitizeNick($("profileNickname").value)===currentNick;
    updateProfilePassword();
  }
  function updateProfilePassword(){
    const a=$("profileCurrentPassword").value,b=$("profileNewPassword").value,c=$("profileConfirmPassword").value;
    $("profileSavePassword").disabled=!auth||!ready||!connected||profileBusy||[...a].length<4||[...b].length<4||b!==c;
  }
  function clearProfilePasswords(){for(const id of ["profileCurrentPassword","profileNewPassword","profileConfirmPassword"])$(id).value="";}
  function openProfile(){
    if(!currentNick)return;
    if(currentPage!=="profile")beforeProfile=currentPage==="jumpgame"?"minigame":currentPage;
    $("profileNickname").value=currentNick;profileNickAvailable=false;profileNickSeq++;clearProfilePasswords();
    for(const id of ["profileNicknameMessage","profilePasswordMessage","profileAccountMessage"])setMsg($(id),"",null);
    closeNickMenu();switchPage("profile");profileStamp="";paintProfile();
  }
  function checkProfileNickname(){
    clearTimeout(profileNickTimer);const sequence=++profileNickSeq;profileNickAvailable=false;
    const nickname=sanitizeNick($("profileNickname").value);
    $("profileSaveNickname").disabled=true;
    if(!auth||!ready||!isValidNick(nickname)||nickname===currentNick){setMsg($("profileNicknameMessage"),nickname===currentNick?"현재 닉네임이에요.":"닉네임은 1자 이상 입력해 주세요.",null);return;}
    setMsg($("profileNicknameMessage"),"닉네임을 확인하고 있어요…",null);
    profileNickTimer=setTimeout(async()=>{try{const data=await api("/api/nicknames/available?nickname="+encodeURIComponent(nickname));if(sequence!==profileNickSeq)return;profileNickAvailable=data.available;setMsg($("profileNicknameMessage"),data.available?"사용 가능한 닉네임이에요.":"이미 누군가 사용 중인 닉네임이에요.",data.available?"good":"bad");}catch(error){if(sequence===profileNickSeq)setMsg($("profileNicknameMessage"),error.message,"bad");}profileStamp="";paintProfile();},350);
  }
  async function profileAction(messageId,action){
    if(profileBusy||signingOut)return;profileBusy=true;profileStamp="";paintProfile();
    try{if(inFlight)await inFlight;if(auth&&ready&&!await flush())throw new Error("서버 기록을 저장하지 못했어요. 연결 상태를 확인해 주세요.");await action();}
    catch(error){setMsg($(messageId),error.message,"bad");}
    finally{profileBusy=false;profileStamp="";paintProfile();scheduleSave();}
  }
  async function choosePhoto(){
    const file=$("profilePhotoInput").files?.[0];if(!file)return;
    const selectedFor=currentNick,selectedGeneration=generation;
    if(file.size>15*1024*1024){setMsg($("profilePhotoMessage"),"15MB 이하의 사진을 선택해 주세요.","bad");return;}
    if(file.type==="image/svg+xml"||!(/\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(file.name)||/^image\/(jpeg|png|webp|gif|avif|heic|heif)$/.test(file.type))){setMsg($("profilePhotoMessage"),"JPG·PNG·WebP 등의 사진을 선택해 주세요.","bad");return;}
    const url=URL.createObjectURL(file);
    try{
      const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});
      const canvas=document.createElement("canvas");canvas.width=256;canvas.height=256;
      const ctx=canvas.getContext("2d"),size=Math.min(image.naturalWidth,image.naturalHeight);if(!size||!ctx)throw new Error();
      ctx.fillStyle="#21192e";ctx.fillRect(0,0,256,256);ctx.drawImage(image,(image.naturalWidth-size)/2,(image.naturalHeight-size)/2,size,size,0,0,256,256);
      if(selectedFor!==currentNick||selectedGeneration!==generation)return;
      pendingPhoto=canvas.toDataURL("image/jpeg",0.85);profileStamp="";paintProfile();setMsg($("profilePhotoMessage"),"미리보기예요. 사진 저장을 누르면 반영돼요.",null);
    }catch(_){setMsg($("profilePhotoMessage"),"이 사진을 읽을 수 없어요. JPG나 PNG로 다시 선택해 주세요.","bad");}
    finally{URL.revokeObjectURL(url);$("profilePhotoInput").value="";}
  }
  async function savePhoto(){
    if(pendingPhoto===null)return;
    await profileAction("profilePhotoMessage",async()=>{
      const photo=pendingPhoto;
      if(auth&&ready){const data=await api("/api/me/profile",{method:"POST",body:{avatarDataUrl:photo}});syncAccount(data);}
      profileCache[currentNick]={...(profileCache[currentNick]||{}),avatarDataUrl:photo};saveCaches();pendingPhoto=null;
      setMsg($("profilePhotoMessage"),auth&&ready?"프로필 사진을 저장했어요.":"이 기기에 프로필 사진을 저장했어요.","good");
    });
  }
  async function saveNickname(){
    if($("profileSaveNickname").disabled)return;
    await profileAction("profileNicknameMessage",async()=>{
      const data=await api("/api/me/profile",{method:"POST",body:{nickname:sanitizeNick($("profileNickname").value)}});
      syncAccount(data);$("profileNickname").value=currentNick;profileNickAvailable=false;render();saveCurrent();
      setMsg($("profileNicknameMessage"),"닉네임을 변경했어요.","good");
    });
  }
  async function changePassword(){
    if($("profileSavePassword").disabled)return;
    await profileAction("profilePasswordMessage",async()=>{
      const data=await api("/api/me/password",{method:"POST",body:{currentPassword:$("profileCurrentPassword").value,newPassword:$("profileNewPassword").value}});
      generation++;auth.token=data.token;storeAuth();syncAccount(data);clearProfilePasswords();setMsg($("profilePasswordMessage"),"비밀번호를 변경했어요. 다른 기기에서는 다시 로그인해 주세요.","good");
    });
  }
  async function saveJumpRecord(){
    rememberBest();if(criticalSave)return criticalSave;
    const mine=generation;
    criticalSave=(async()=>{if(inFlight)await inFlight;if(mine!==generation||profileBusy||signingOut)return false;return flush();})();
    try{return await criticalSave;}finally{criticalSave=null;}
  }
  async function resetProgress(){
    await profileAction("profileAccountMessage",async()=>{
      const wasOnline=Boolean(auth&&ready&&!conflict);
      if(wasOnline){const data=await api("/api/me/reset",{method:"POST",body:{revision,progressEpoch}});revision=data.revision;progressEpoch=data.progressEpoch;syncAccount(data);generation++;}
      ready=false;bestCache[currentNick]={score:0,epoch:progressEpoch,accountId:auth?.id||null};saveCaches();
      resetCurrentNickProgress();render();ready=wasOnline&&Boolean(auth&&!conflict);rememberBest();
      setMsg($("profileAccountMessage"),wasOnline?"게임 진행상황을 초기화했어요.":"이 기기의 게임 진행상황을 초기화했어요.","good");
    });
  }
  async function refreshAccount(){
    if(!auth||!ready||profileBusy||signingOut)return;const token=auth.token;
    try{const data=await api("/api/me/profile",{token});if(auth?.token===token)syncAccount(data);}
    catch(error){if(error.status===401&&auth?.token===token){ready=false;auth=null;storeAuth();status("다시 로그인해 주세요. 이 기기의 기록은 유지돼요.",true);profileStamp="";paintProfile();}}
  }
  $("profileBack").addEventListener("click",()=>switchPage(beforeProfile));
  $("profileChoosePhoto").addEventListener("click",()=>$("profilePhotoInput").click());
  $("profilePhotoInput").addEventListener("change",choosePhoto);
  $("profileDefaultPhoto").addEventListener("click",()=>{pendingPhoto="";profileStamp="";paintProfile();setMsg($("profilePhotoMessage"),"사진 저장을 누르면 기본 사진으로 바뀌어요.",null);});
  $("profileSavePhoto").addEventListener("click",savePhoto);
  $("profileNickname").addEventListener("input",checkProfileNickname);
  $("profileSaveNickname").addEventListener("click",saveNickname);
  for(const id of ["profileCurrentPassword","profileNewPassword","profileConfirmPassword"])$(id).addEventListener("input",updateProfilePassword);
  $("profileSavePassword").addEventListener("click",changePassword);

  window.AcornOnline = {
    updateSignup, updateLogin, register, login, scheduleSave, signOut, onOverlay,
    openProfile,onRender:paintProfile,resetProgress,saveJumpRecord,
    onPage(page) { if (page === "ranking") loadRanking(); if(page!=="profile")clearProfilePasswords();else {profileStamp="";paintProfile();} }
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
    progressEpoch=profileCache[nickname]?.progressEpoch||0;accountInfo={};pendingPhoto=null;
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
