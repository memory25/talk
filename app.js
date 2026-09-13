// ============================================================
//  talk —— 主程式
// ============================================================

import {
  firebaseConfig, ROOM_ID, USERS, OPTIONS,
  QUICK_EMOJI, EMOJI_GROUPS, REACTIONS, RETRACT, IPHONE_MODELS,
  PHOTO, QUOTA, VOICE, GEO,
} from "./config.js";

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase, ref, push, set, update, remove, serverTimestamp,
  query, limitToLast, onChildAdded, onChildChanged,
  onValue, onDisconnect, off, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ------------------------------------------------------------
//  小工具
// ------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const STORE_KEY = "talk.identity";
const SOUND_KEY = "talk.sound";

/** 正規化輸入：去空白、統一大小寫，讓 a 和 A 都算數。 */
const normalize = (text) => String(text).normalize("NFKC").trim().toUpperCase();

/** 解析輸入，找出對應的使用者與顯示模式。 */
const matchUser = (typed) => {
  let key = normalize(typed);
  if (!key) return null;

  let showPresence = false;
  const suffix = key.match(/(?:\.{3}|…|。{3})$/);
  if (suffix) {
    showPresence = true;
    key = key.slice(0, -suffix[0].length).trim();
  }

  const user = USERS.find((u) =>
    (u.keys ?? []).some((k) => normalize(k) === key));
  return user ? { ...user, showPresence } : null;
};

/** 轉義 HTML，再把網址變成可點擊的連結。訊息內容一律走這裡。 */
function renderText(raw) {
  const escaped = raw.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  return escaped.replace(
    /\b(https?:\/\/[^\s<]+[^\s<.,;:!?)"'])/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
}

/** 整則訊息只有 emoji（最多 3 個）時放大顯示，聊天軟體的慣例。 */
const isJumbo = (text) => {
  const t = text.trim();
  if (!t) return false;
  const bare = t.replace(/[\s️‍]/g, "");
  if (!bare) return false;
  const chars = [...bare];
  return chars.length <= 3 &&
    chars.every((c) => /\p{Extended_Pictographic}/u.test(c));
};

const timeOf = (ms) =>
  new Date(ms).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });

const dayOf = (ms) => {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "今天";
  if (same(d, yesterday)) return "昨天";
  return d.toLocaleDateString("zh-TW", {
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
    month: "long", day: "numeric", weekday: "short",
  });
};

/** 用 WebAudio 合成一聲短提示音，免去外部音檔。 */
const beep = (() => {
  let ctx;
  return () => {
    if (!state.sound) return;
    try {
      ctx ||= new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime;
      osc.type = "sine";
      osc.frequency.setValueAtTime(660, t);
      osc.frequency.setValueAtTime(880, t + 0.09);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.14, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.28);
    } catch { /* 瀏覽器不給播就算了，不是關鍵功能 */ }
  };
})();

/**
 * 短暫浮現的提示，取代 alert——不必按確定，也不會打斷手上的動作。
 * tone "bad" 會用警示色，其餘是一般訊息。
 */
function toast(message, tone = "info") {
  const host = $("toasts");
  if (!host) return;

  const el = document.createElement("div");
  el.className = `toast toast-${tone}`;
  el.textContent = message;
  host.appendChild(el);

  // 動畫跑完才真的移除，不然會看到它硬生生消失
  const kill = () => {
    el.classList.add("is-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    // 萬一動畫沒觸發（減少動態偏好設定），保底移除
    setTimeout(() => el.remove(), 400);
  };
  const timer = setTimeout(kill, 3200);
  el.onclick = () => { clearTimeout(timer); kill(); };
}

/**
 * 取代 confirm 的自訂確認框。回傳 Promise<boolean>，
 * 所以呼叫端只要加個 await，其餘邏輯照舊。
 */
function ask({ title, body = "", yes = "確定", no = "取消", danger = false }) {
  return new Promise((resolve) => {
    const box = $("ask");
    const yesBtn = $("ask-yes");
    const noBtn = $("ask-no");

    $("ask-title").textContent = title;
    $("ask-body").textContent = body;
    $("ask-body").hidden = !body;
    yesBtn.textContent = yes;
    noBtn.textContent = no;
    yesBtn.classList.toggle("is-danger", danger);

    const close = (answer) => {
      box.hidden = true;
      yesBtn.onclick = noBtn.onclick = box.onclick = null;
      document.removeEventListener("keydown", onKey, true);
      resolve(answer);
    };

    // 確認框開著時，Escape / Enter 只屬於它——
    // 不攔的話同一個按鍵還會去關選單、取消回覆或送出訊息。
    const onKey = (e) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close(e.key === "Enter");
    };

    yesBtn.onclick = () => close(true);
    noBtn.onclick = () => close(false);
    box.onclick = (e) => { if (e.target === box) close(false); };
    // capture 階段：其他 keydown listener 都掛在 document 上，
    // 這裡要先攔到才有辦法擋下它們。
    document.addEventListener("keydown", onKey, true);

    box.hidden = false;
    // 預設落在「取消」上，避免連按 Enter 就誤觸破壞性動作
    noBtn.focus();
  });
}

function fatal(message) {
  $("gate-error").textContent = message;
  $("gate-error").hidden = false;
  $("gate-submit").disabled = true;
}

/**
 * 收集這台裝置不需要授權就能拿到的資訊，寫進資料庫給對方看。
 * 全部是雙向對等的——兩個人看得到的欄位一模一樣。
 */
async function collectDevice() {
  const ua = navigator.userAgent;

  // 從 UA 粗略判斷裝置類型
  let kind = "電腦";
  if (/iPad|Tablet/.test(ua)) kind = "平板";
  else if (/iPhone|Android.*Mobile|Mobile/.test(ua)) kind = "手機";

  // 作業系統
  let os = "未知";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Linux/.test(ua)) os = "Linux";

  // 瀏覽器（順序有講究：Edge 也含 Chrome 字樣）
  let browser = "未知";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";

  // 手機橫放時 screen 的寬高會對調，統一成直向才查得到表、
  // 也才不會同一支手機轉個方向就顯示成不同尺寸。
  const shorter = Math.min(screen.width, screen.height);
  const longer = Math.max(screen.width, screen.height);
  const dpr = Math.round(window.devicePixelRatio || 1);

  const dev = {
    kind,
    os,
    browser,
    screen: `${shorter}×${longer}`,
    lang: navigator.language || "",
    tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ""; } })(),
  };

  // 機型：Android 的 UA 帶著真型號，iPhone 只能靠螢幕尺寸猜。
  // 兩者準確度差很多，所以分成 model（確定）與 maybeModel（推測）。
  //
  // 近年的 Android Chrome 為了防指紋追蹤，會把型號改寫成單一個 "K"，
  // 也有些瀏覽器留下 "Android"、"Mobile" 這類沒有資訊量的字。
  // 這些一律當作沒抓到，不然畫面上會出現「機型：K」這種怪東西。
  const android = ua.match(/Android[^;)]*;\s*([^;)]+?)\s*(?:Build\/|[;)])/);
  const model = android?.[1]?.trim();
  if (model && model.length > 1 && !/^(K|Android|Mobile|Linux)$/i.test(model)) {
    dev.model = model.slice(0, 40);
  } else if (/iPhone/.test(ua)) {
    const hit = IPHONE_MODELS.find(
      (m) => m.size === `${shorter}×${longer}` && m.dpr === dpr);
    if (hit) dev.maybeModel = hit.names.join("／");
  }

  // 電量（部分瀏覽器已移除這個 API，拿不到就算了）
  try {
    if (navigator.getBattery) {
      const b = await navigator.getBattery();
      dev.battery = Math.round(b.level * 100);
      dev.charging = b.charging;
    }
  } catch { /* 沒有就沒有 */ }

  // 大略位置：靠免費 IP 定位服務，城市級、可能失敗
  try {
    const r = await fetch("https://ipapi.co/json/", { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json();
      dev.city = j.city || "";
      dev.region = j.region || "";
      dev.country = j.country_name || "";
    }
  } catch { /* 服務擋掉或逾時就略過位置 */ }

  return dev;
}

// ------------------------------------------------------------
//  照片
// ------------------------------------------------------------

/** 這個月的帳記在哪一格，例如 "2026-09"。 */
const usageKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/**
 * 把使用者選的圖片壓成適合塞進資料庫的 JPEG data URL。
 * 長邊縮到 PHOTO.maxEdge，並且統一轉成 JPEG——
 * iPhone 拍的 HEIC 瀏覽器不一定解得開，能畫進 canvas 的就都能轉出 JPEG。
 */
async function compressImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("這個格式讀不出來");

  const { width: w0, height: h0 } = bitmap;
  const scale = Math.min(1, PHOTO.maxEdge / Math.max(w0, h0));
  const w = Math.round(w0 * scale);
  const h = Math.round(h0 * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL("image/jpeg", PHOTO.quality);
  return { dataUrl, w, h, bytes: dataUrl.length };
}

/** 把用掉的位元組累加到這個月的帳上。 */
function chargeUsage(bytes) {
  const path = `rooms/${ROOM_ID}/usage/${usageKey()}`;
  runTransaction(ref(state.db, path), (cur) => (cur || 0) + bytes)
    .catch(() => { /* 記帳失敗不該擋住聊天 */ });
}

/** 這個月用掉的比例（0～1 以上）。額度是估的，寧可早一點停。 */
const usageRatio = () =>
  (state.usage * QUOTA.overhead) / QUOTA.monthlyBytes;

const quotaBlocked = () => usageRatio() >= QUOTA.stopUploadAt;

// ------------------------------------------------------------
//  語音
// ------------------------------------------------------------

/**
 * 挑一個這台裝置錄得出來、對方也播得動的格式。
 *
 * iOS Safari 要到 18.4 才支援 WebM，在那之前只錄得出 MP4/AAC；
 * 而兩邊裝置可能不同，所以優先挑相容性最好的 MP4——
 * 檔案略大一點，但不會發生「錄得出來卻播不了」。
 */
function pickAudioType() {
  if (typeof MediaRecorder === "undefined") return null;
  const wanted = [
    "audio/mp4",                  // iOS 一定有，其他家多半也讀得動
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  return wanted.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

/** blob 轉 data URL，才能塞進 Realtime Database。 */
const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result);
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(blob);
});

const fmtDuration = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// ------------------------------------------------------------
//  狀態
// ------------------------------------------------------------

const state = {
  me: null,          // USERS 裡的我
  peer: null,        // USERS 裡的對方
  db: null,
  refs: {},
  sound: localStorage.getItem(SOUND_KEY) !== "off",
  lastAuthor: null,  // 用來判斷連續發言
  lastDay: null,
  typingTimer: null,
  typingSent: false,
  booted: false,     // 首批歷史訊息載完前不播音
  seen: new Set(),   // 已渲染的訊息 key，避免樂觀泡泡重複
  msgs: new Map(),   // key -> 訊息內容，回覆預覽與收回要用
  replyTo: null,     // 正在回覆哪一則
  actionsFor: null,  // 動作選單目前針對哪一則
  reactions: {},     // key -> { emoji: [誰, 誰] }
  peerPresence: null,// 對方最後回報的狀態，由計時器定期重新評估
  peerDevice: null,  // 最後看過的對方裝置資訊，當作下保險
  showPresence: false,
  photos: new Map(),  // 圖片 id -> { data, from, at, seenAt }
  usage: 0,           // 這個月自己記的帳（位元組）
  seenTimers: new Map(), // 圖片 id -> 停留計時器，看滿才算已讀
  photoObserver: null,
  retractionLog: [],  // 收回紀錄，只有走後門時才會填
  voices: new Map(),  // 語音 id -> { data, from, at, heardAt }
  rec: null,          // 正在錄音時的狀態
  geoWatch: null,     // GPS 監看的 id
  geoTimer: null,     // 定期重新定位的計時器
  peerGeo: null,      // 最後看過的對方座標，定位暫時失敗時沿用
};

// ------------------------------------------------------------
//  進場
// ------------------------------------------------------------

function checkConfig() {
  if (firebaseConfig.apiKey.startsWith("PASTE_")) {
    fatal("還沒設定 Firebase。\n請打開 config.js，把 Firebase 主控台的設定貼進去。");
    return false;
  }
  if (USERS.some((u) => !u.keys?.length)) {
    fatal("還沒設定身分。\n請打開 config.js，填好每個人的 keys 欄位。");
    return false;
  }
  return true;
}

async function onGateSubmit(event) {
  event.preventDefault();
  const btn = $("gate-submit");
  const err = $("gate-error");
  err.hidden = true;

  const me = matchUser($("passphrase").value);
  if (!me) {
    // 刻意不說正確答案是什麼
    err.textContent = "這裡沒有這個角色。";
    err.hidden = false;
    $("passphrase").select();
    return;
  }

  btn.disabled = true;
  btn.textContent = "進入中…";

  try {
    if ($("remember").checked) {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        id: me.id,
        showPresence: me.showPresence,
      }));
    }
    await enterRoom(me);
  } catch (e) {
    console.error(e);
    err.textContent = "連不上，檢查一下網路再試。";
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "進入";
  }
}

/** 曾經勾過「記住我」的話，直接復原上次的身分。 */
async function tryRestore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    const user = saved && USERS.find((u) => u.id === saved.id);
    if (!user) {
      localStorage.removeItem(STORE_KEY);
      return false;
    }
    await enterRoom({ ...user, showPresence: Boolean(saved.showPresence) });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
//  進入聊天室
// ------------------------------------------------------------

async function enterRoom(me) {
  state.me = me;
  state.peer = USERS.find((u) => u.id !== me.id) ?? me;

  document.documentElement.style.setProperty("--me", state.me.accent);
  document.documentElement.style.setProperty("--you", state.peer.accent);

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  state.db = getDatabase(app);

  // Realtime Database 規則會擋掉未登入的請求，所以先匿名登入。
  await signInAnonymously(auth);
  await new Promise((resolve) => {
    // onAuthStateChanged 可能同步就回呼（已有快取憑證時），
    // 所以先記下 user 再取消訂閱，不能在回呼裡直接用 unsub。
    let done = false;
    let unsub = null;
    const finish = (user) => {
      if (done) return;
      done = true;
      if (unsub) unsub();
      resolve(user);
    };
    unsub = onAuthStateChanged(auth, (user) => { if (user) finish(user); });
    if (done && unsub) unsub();
  });

  const room = `rooms/${ROOM_ID}`;
  state.refs = {
    messages: ref(state.db, `${room}/messages`),
    reactions: ref(state.db, `${room}/reactions`),
    retractions: ref(state.db, `${room}/retractions`),
    photos: ref(state.db, `${room}/photos`),
    voices: ref(state.db, `${room}/voices`),
    usage: ref(state.db, `${room}/usage/${usageKey()}`),
    myPresence: ref(state.db, `${room}/presence/${me.id}`),
    peerPresence: ref(state.db, `${room}/presence/${state.peer.id}`),
    myTyping: ref(state.db, `${room}/typing/${me.id}`),
    peerTyping: ref(state.db, `${room}/typing/${state.peer.id}`),
  };

  $("gate").hidden = true;
  $("chat").hidden = false;
  $("sound-toggle").setAttribute("aria-pressed", String(state.sound));

  state.showPresence = Boolean(me.showPresence);
  $("peer-name").textContent = state.showPresence ? state.peer.label : "";
  $("peer-dot").hidden = !state.showPresence;
  $("peer-state").hidden = !state.showPresence;

  // 沒走後門時，標題列不能點開（連 caret 都不出現）
  if (state.showPresence) {
    $("peer").onclick = () => {
      const panel = $("device-panel");
      if ($("peer-caret").hidden) return;   // 對方還沒回報裝置資訊
      const open = panel.hidden;
      panel.hidden = !open;
      $("peer").setAttribute("aria-expanded", String(open));
      $("peer-caret").textContent = open ? "▴" : "▾";
    };
  } else {
    $("peer").style.cursor = "default";
  }

  watchMessages();
  watchReactions();
  watchPhotos();
  watchVoices();
  watchUsage();
  watchRetractionLog();
  watchPresence();
  watchTyping();
  wireActions();
  buildEmoji();
  wireComposer();

  $("input").focus();
}

// ------------------------------------------------------------
//  訊息
// ------------------------------------------------------------

function watchMessages() {
  const recent = query(state.refs.messages, limitToLast(OPTIONS.messageLimit));

  // onChildAdded 會先把既有歷史一筆筆送過來，之後才是即時新訊息。
  // 用一個 microtask 之後的旗標區分兩者，才不會一進門就響一串提示音。
  onChildAdded(recent, (snap) => {
    const msg = snap.val();
    if (!msg || typeof msg.text !== "string") return;
    if (state.seen.has(snap.key)) return;
    state.seen.add(snap.key);

    // 已經被刪除的舊訊息：連泡泡都不用畫，但仍要記在 msgs 裡，
    // 這樣回覆它的那則訊息點引用時才知道原訊息已經不在了。
    if (msg.retracted === "remove") {
      state.msgs.set(snap.key, {
        text: msg.text, from: msg.from, retracted: "remove",
      });
      return;
    }

    // 樂觀泡泡：自己送的訊息已經先畫出來了，這裡把它換成正式的。
    // nonce 是本地產生的，字元固定是 [a-z0-9-]，不需要額外轉義。
    const optimistic = msg.nonce && /^[a-z0-9-]+$/i.test(msg.nonce)
      ? document.querySelector(`[data-nonce="${msg.nonce}"]`)
      : null;
    if (optimistic) {
      optimistic.dataset.key = snap.key;
      delete optimistic.dataset.nonce;
      const stamp = optimistic.nextElementSibling;
      if (stamp?.classList.contains("stamp")) {
        stamp.innerHTML = timeOf(msg.at || Date.now());
      }
      // 補登記，剛送出的訊息才能被回覆、按反應或收回
      state.msgs.set(snap.key, {
        text: msg.text, from: msg.from, retracted: null,
      });

      // 照片：樂觀泡泡建立時還不知道圖片 id（要等寫入才拿得到），
      // 這裡補上去，renderPhoto 才找得到這個泡泡。
      if (msg.photo) {
        optimistic.dataset.photo = msg.photo;
        const photo = state.photos.get(msg.photo);
        if (photo) renderPhoto(msg.photo, photo);
      }
      if (msg.voice) {
        optimistic.dataset.voice = msg.voice;
        const voice = state.voices.get(msg.voice);
        if (voice) renderVoice(msg.voice, voice);
      }

      renderReactions(snap.key);
      return;
    }

    const mine = msg.from === state.me.id;
    appendMessage({ ...msg, key: snap.key }, mine);
    // 圖片資料可能已經先到了（或早就過期被清掉了），補畫一次
    if (msg.photo) {
      const photo = state.photos.get(msg.photo);
      if (photo) {
        renderPhoto(msg.photo, photo);
      } else {
        const bubble = document.querySelector(`.msg[data-photo="${msg.photo}"]`);
        if (bubble) markPhotoGone(bubble);
      }
    }
    if (msg.voice) {
      const voice = state.voices.get(msg.voice);
      if (voice) {
        renderVoice(msg.voice, voice);
      } else {
        const bubble = document.querySelector(`.msg[data-voice="${msg.voice}"]`);
        if (bubble) markVoiceGone(bubble);
      }
    }
    if (!mine && state.booted) beep();
  });

  // 收回是就地改寫既有的那一筆，所以要另外聽 changed——
  // 對方在你眼前按下收回時，畫面才會立刻跟著變。
  onChildChanged(recent, (snap) => {
    const msg = snap.val();
    if (!msg) return;
    const known = state.msgs.get(snap.key);
    if (known) state.msgs.set(snap.key, { ...known, retracted: msg.retracted });
    if (msg.retracted) applyRetraction(snap.key, msg);
  });

  // 首批歷史送完後才開始播音
  onValue(recent, () => {
    if (!state.booted) setTimeout(() => { state.booted = true; }, 300);
    // 進場第一眼一定要看到最新的訊息，
    // 不該受「接近底部才捲」那個判斷影響。
    settleToEnd();
  }, { onlyOnce: true });
}

function appendMessage(msg, mine, pending = false) {
  const stream = $("stream");
  $("stream-empty").hidden = true;

  const at = msg.at || Date.now();
  const day = dayOf(at);
  if (day !== state.lastDay) {
    const sep = document.createElement("div");
    sep.className = "day";
    sep.textContent = day;
    stream.appendChild(sep);
    state.lastDay = day;
    state.lastAuthor = null;
  }

  const run = state.lastAuthor === msg.from;

  const recalled = msg.retracted === "recall";

  const bubble = document.createElement("div");
  const isPhoto = msg.type === "photo" || msg.photoPending;
  const isVoice = msg.type === "voice" || msg.voicePending;
  bubble.className = `msg ${mine ? "mine" : "theirs"}${run ? " run-mid" : " run-start"}`
    + (recalled ? " recalled"
      : isPhoto ? " photo-msg"
      : isVoice ? " voice-msg"
      : isJumbo(msg.text) ? " jumbo" : "");
  if (msg.key) bubble.dataset.key = msg.key;
  if (pending && msg.nonce) bubble.dataset.nonce = msg.nonce;

  // 引用被回覆的那則（存的是快照，原訊息之後就算變了也不影響）
  if (!recalled && msg.reply?.text) {
    const quote = document.createElement("div");
    const who = USERS.find((u) => u.id === msg.reply.from);
    const self = msg.reply.from === state.me?.id;

    // 用被回覆者的代表色，一眼看出在回誰
    quote.className = `quote ${self ? "to-me" : "to-peer"}`;
    if (who?.accent) quote.style.setProperty("--quote", who.accent);

    quote.innerHTML =
      `<span class="quote-who">${self ? "自己" : "對方"}</span>` +
      `<span class="quote-text">${renderText(msg.reply.text)}</span>`;
    // 點引用可以跳回原訊息
    if (msg.reply.key) {
      quote.dataset.jump = msg.reply.key;
      quote.title = "跳到原訊息";
    }
    bubble.appendChild(quote);
  }

  const body = document.createElement("div");
  body.className = "msg-body";
  if (recalled) {
    body.textContent = `${RETRACT.recall.icon} ` +
      (mine ? RETRACT.recall.noticeMine : RETRACT.recall.noticeTheirs);
  } else if (msg.type === "photo" || msg.photoPending) {
    // 先放佔位，圖片本體到了再由 renderPhoto 換掉
    body.textContent = msg.photoPending ? "📷 傳送中…" : "📷 照片載入中…";
    if (msg.photo) bubble.dataset.photo = msg.photo;
  } else if (msg.type === "voice" || msg.voicePending) {
    body.textContent = msg.voicePending ? "🎤 傳送中…" : "🎤 語音載入中…";
    if (msg.voice) bubble.dataset.voice = msg.voice;
  } else {
    body.innerHTML = renderText(msg.text);
  }
  bubble.appendChild(body);

  const stamp = document.createElement("div");
  stamp.className = `stamp ${mine ? "mine" : "theirs"}`;
  stamp.innerHTML = pending
    ? '<span class="pending">傳送中…</span>'
    : timeOf(at);

  // 連續發言時，把上一則的時間戳收掉，只留最後一則
  const prevStamp = stream.lastElementChild;
  if (run && prevStamp?.classList.contains("stamp")) prevStamp.remove();

  stream.append(bubble, stamp);
  state.lastAuthor = msg.from;

  if (msg.key) {
    state.msgs.set(msg.key, {
      text: msg.text, from: msg.from, retracted: msg.retracted ?? null,
      photo: msg.photo ?? null, voice: msg.voice ?? null,
    });
    // 收回後的泡泡不掛反應，舊的反應也跟著訊息一起收掉
    if (!recalled) renderReactions(msg.key);
  }

  scrollToEnd();
  return { bubble, stamp };
}

/**
 * 捲到最新的訊息。
 *
 * force 為真時一定捲到底；否則只有在使用者本來就在底部
 * 附近時才跟進——往上翻歷史時不該把人硬拉回來。
 */
function scrollToEnd(force = false) {
  const stream = $("stream");
  const nearBottom =
    stream.scrollHeight - stream.scrollTop - stream.clientHeight < 160;
  if (force || nearBottom) stream.scrollTop = stream.scrollHeight;
}

/**
 * 確實捲到底。
 *
 * 圖片與語音是在訊息畫完之後才載入的，載入完才會擐開高度，
 * 所以只捲一次會停在半空中。這裡在接下來的幾個時間點再捲幾次，
 * 把陸續擐開的那段高度追回來。
 */
function settleToEnd() {
  scrollToEnd(true);
  // 排版完成、緊接著的幾幀、以及圖片差不多該載完的時間
  requestAnimationFrame(() => scrollToEnd(true));
  [60, 200, 500, 1200].forEach((ms) => setTimeout(() => scrollToEnd(true), ms));
}

async function sendMessage(text, replyTo = null) {
  const body = text.trim();
  if (!body) return;

  // 引用存的是快照：原訊息就算之後被刪，回覆裡的引用還在
  const reply = replyTo && {
    key: replyTo.key,
    from: replyTo.from,
    text: replyTo.text.slice(0, 120),
  };

  const nonce = `${state.me.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { bubble, stamp } = appendMessage(
    { text: body, from: state.me.id, at: Date.now(), nonce, reply },
    true, true,
  );

  try {
    const payload = {
      text: body,
      from: state.me.id,
      at: serverTimestamp(),
      nonce,
    };
    if (reply) payload.reply = reply;
    await set(push(state.refs.messages), payload);
  } catch (e) {
    console.error("send failed:", e);
    stamp.innerHTML = '<span class="failed">沒送出去，點一下重試</span>';
    stamp.style.cursor = "pointer";
    stamp.onclick = () => {
      bubble.remove();
      stamp.remove();
      state.lastAuthor = null;
      sendMessage(body, replyTo);
    };
  }
}

/**
 * 送出一張照片。圖片本體另外存在 photos 底下，訊息只留一個 id——
 * 這樣 limitToLast 拉歷史訊息時不會把每張圖都重新下載一次。
 */
async function sendPhoto(file) {
  if (quotaBlocked()) {
    toast(`本月額度已用約 ${Math.round(usageRatio() * 100)}%，暫停傳照片`, "bad");
    return;
  }
  if (!file.type.startsWith("image/")) {
    toast("這不是圖片檔", "bad");
    return;
  }

  let shot;
  try {
    shot = await compressImage(file);
  } catch (e) {
    console.error("compress failed:", e);
    toast("這張圖讀不出來，換一張試試", "bad");
    return;
  }

  if (shot.bytes > PHOTO.maxBytes) {
    toast("這張圖太大了，壓縮後還是超過上限", "bad");
    return;
  }

  const nonce = `${state.me.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { bubble, stamp } = appendMessage(
    { text: "", from: state.me.id, at: Date.now(), nonce, photoPending: true },
    true, true,
  );

  try {
    const photoRef = push(state.refs.photos);
    const id = photoRef.key;

    await set(photoRef, {
      data: shot.dataUrl,
      from: state.me.id,
      at: serverTimestamp(),
      w: shot.w,
      h: shot.h,
    });

    await set(push(state.refs.messages), {
      text: "",
      type: "photo",
      photo: id,
      from: state.me.id,
      at: serverTimestamp(),
      nonce,
    });

    chargeUsage(shot.bytes);
  } catch (e) {
    console.error("send photo failed:", e);
    stamp.innerHTML = '<span class="failed">照片沒送出去</span>';
    bubble.remove();
    state.lastAuthor = null;
  }
}

/**
 * 開始錄音。第一次會跳出麥克風權限請求；
 * 使用者拒絕的話就安靜收手，不再煩他。
 */
async function startRecording() {
  if (state.rec) return;
  if (quotaBlocked()) {
    toast(`本月額度已用約 ${Math.round(usageRatio() * 100)}%，暫停傳語音`, "bad");
    return;
  }

  const type = pickAudioType();
  if (!type || !navigator.mediaDevices?.getUserMedia) {
    toast("這個瀏覽器不支援錄音", "bad");
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast(e?.name === "NotAllowedError"
      ? "沒有麥克風權限，錄不了音" : "打不開麥克風", "bad");
    return;
  }

  // 麥克風這一關過了，順道把定位也要一要——兩個權限集中在同一個
  // 動作裡問完，不要分散在兩個時間點各跳一次。
  // 瀏覽器會把第二個請求排在第一個之後，不會疊在一起。
  setupGeo();

  const chunks = [];
  const recorder = new MediaRecorder(stream, {
    mimeType: type,
    audioBitsPerSecond: VOICE.bitsPerSecond,
  });

  state.rec = {
    recorder, stream, chunks, type,
    startedAt: Date.now(),
    cancelled: false,
  };

  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => finishRecording();
  recorder.start();

  // 到達上限就自己停下來送出，不會錄出一則沒完沒了的東西
  state.rec.limitTimer = setTimeout(
    () => stopRecording(), VOICE.maxSeconds * 1000);

  showRecordingBar();
}

/** 停止錄音並送出。cancel 為真時錄的東西直接丟掉。 */
function stopRecording(cancel = false) {
  const rec = state.rec;
  if (!rec) return;
  rec.cancelled = cancel;
  clearTimeout(rec.limitTimer);
  clearInterval(rec.tickTimer);
  if (rec.recorder.state !== "inactive") rec.recorder.stop();
  else finishRecording();
}

async function finishRecording() {
  const rec = state.rec;
  if (!rec) return;
  state.rec = null;

  rec.stream.getTracks().forEach((t) => t.stop());   // 關掉麥克風指示燈
  hideRecordingBar();

  const seconds = (Date.now() - rec.startedAt) / 1000;
  if (rec.cancelled) return;
  if (seconds < VOICE.minSeconds) {
    toast("太短了，沒有送出");
    return;
  }

  const blob = new Blob(rec.chunks, { type: rec.type });
  let dataUrl;
  try {
    dataUrl = await blobToDataUrl(blob);
  } catch {
    toast("錄音讀不出來", "bad");
    return;
  }

  if (dataUrl.length > VOICE.maxBytes) {
    toast("這則語音太長了", "bad");
    return;
  }

  sendVoice(dataUrl, seconds, rec.type);
}

async function sendVoice(dataUrl, seconds, type) {
  const nonce = `${state.me.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { bubble, stamp } = appendMessage(
    { text: "", from: state.me.id, at: Date.now(), nonce, voicePending: true },
    true, true,
  );

  try {
    const voiceRef = push(state.refs.voices);
    await set(voiceRef, {
      data: dataUrl,
      from: state.me.id,
      at: serverTimestamp(),
      seconds: Math.round(seconds),
      type,
    });

    await set(push(state.refs.messages), {
      text: "",
      type: "voice",
      voice: voiceRef.key,
      from: state.me.id,
      at: serverTimestamp(),
      nonce,
    });

    chargeUsage(dataUrl.length);
  } catch (e) {
    console.error("send voice failed:", e);
    stamp.innerHTML = '<span class="failed">語音沒送出去</span>';
    bubble.remove();
    state.lastAuthor = null;
  }
}

/** 錄音中的那條列，顯示秒數並提供停止／取消。 */
function showRecordingBar() {
  const bar = $("recording");
  bar.hidden = false;
  $("composer").hidden = true;

  const tick = () => {
    if (!state.rec) return;
    const sec = (Date.now() - state.rec.startedAt) / 1000;
    $("rec-time").textContent = fmtDuration(sec);
    // 快到上限時提醒一下
    $("rec-time").classList.toggle("is-near",
      sec > VOICE.maxSeconds - 10);
  };
  tick();
  state.rec.tickTimer = setInterval(tick, 250);
}

function hideRecordingBar() {
  $("recording").hidden = true;
  $("composer").hidden = false;
  $("rec-time").classList.remove("is-near");
}

// ------------------------------------------------------------
//  上線狀態
// ------------------------------------------------------------

function watchPresence() {
  const { myPresence, peerPresence } = state.refs;

  const beat = () => update(myPresence, {
    online: true,
    active: document.visibilityState === "visible",
    at: serverTimestamp(),
  });

  // 連線中斷（關分頁、斷網、當機）時由伺服器自動標記離線。
  // 這裡與下面都用 update 而不是 set：set 會把整個節點換掉，
  // 連帶把 device 抹掉，對方一離線裝置資訊就消失了。
  onDisconnect(myPresence).update({ online: false, active: false, at: serverTimestamp() });
  update(myPresence, { online: true, active: true, at: serverTimestamp() });

  // 心跳照送，切到背景也不停——頁面還開著就還算在線上，
  // 只是把 active 標成 false，對方會看到「背景中」。
  setInterval(beat, OPTIONS.heartbeat);

  // 離開前記下當時是不是在底部，回來才知道該不該送回去
  let wasAtBottom = true;

  document.addEventListener("visibilitychange", () => {
    beat();
    const stream = $("stream");

    if (document.visibilityState === "hidden") {
      wasAtBottom =
        stream.scrollHeight - stream.scrollTop - stream.clientHeight < 160;
      return;
    }

    // 手機瀏覽器在背景時可能重排版面（網址列收合、鍵盤關閉），
    // 回到前景時捲動位置就跑掉了。只有離開前本來就在底部的話
    // 才把他送回去——當時在翻歷史的話應該留在原地。
    if (wasAtBottom) settleToEnd();
  });

  // 轉螢幕、鍵盤彈出收回都會改變可視高度，同樣要跟上
  window.addEventListener("resize", () => scrollToEnd());

  // 裝置資訊：進場先抓一次，之後每小時重抓（IP 查詢較慢、也有限流，
  // 不必更密）。兩個人都會寫、也都看得到對方的，是雙向對等的。
  const refreshDevice = () => collectDevice()
    .then((dev) => update(myPresence, { device: dev }))
    .catch(() => { /* 拿不到裝置資訊不影響聊天 */ });

  refreshDevice();
  setInterval(refreshDevice, OPTIONS.deviceRefresh);

  // onValue 只在資料變動時觸發，光靠它沒辦法讓「過期」自己浮現，
  // 所以資料存在 state，由本地計時器定期重新評估。
  onValue(peerPresence, (snap) => {
    state.peerPresence = snap.val();
    // 裝置資訊本來就是「最後一次回報的狀態」，不是即時值。
    // 對方資料裡沒有這個欄位時就沿用上一次看過的，
    // 面板才不會突然整個不見。
    if (state.peerPresence?.device) state.peerDevice = state.peerPresence.device;
    renderPresence();
  });

  setInterval(renderPresence, 10000);
}

function renderPresence() {
  if (!state.showPresence) return;

  const p = state.peerPresence;
  const fresh = p?.at && Date.now() - p.at < OPTIONS.offlineAfter;
  const online = Boolean(p?.online && fresh);

  $("peer-dot").classList.toggle("is-online", online);
  $("peer-dot").classList.toggle("is-away", online && p?.active === false);

  $("peer-state").textContent = online
    ? (p?.active === false ? "背景中" : "在線上")
    : p?.at
      ? `上次上線 ${dayOf(p.at)} ${timeOf(p.at)}`
      : "還沒來過";

  renderDevice();
}

const DEVICE_ICON = { "手機": "📱", "平板": "📓", "電腦": "💻" };

/** 把對方的裝置資訊畫進可展開的面板。 */
function renderDevice() {
  if (!state.showPresence) return;

  const dev = state.peerPresence?.device ?? state.peerDevice;
  const caret = $("peer-caret");
  const panel = $("device-panel");

  if (!dev) {
    caret.hidden = true;
    panel.hidden = true;
    $("peer").setAttribute("aria-expanded", "false");
    return;
  }
  caret.hidden = false;

  // 精準位置：對方同意分享才有。沿用最後一次拿到的，
  // 定位暫時失敗時不會突然消失。
  const g = state.peerPresence?.geo ?? state.peerGeo;
  if (g) state.peerGeo = g;
  const geo = g ? `${g.lat}, ${g.lon}${g.acc ? `（±${g.acc}m）` : ""}` : "";
  const geoLink = g ? `https://www.google.com/maps?q=${g.lat},${g.lon}` : "";

  const place = [dev.city, dev.region, dev.country]
    .filter(Boolean)
    // region 常和 city 或 country 重複，去掉相鄰重複
    .filter((v, i, a) => v !== a[i - 1])
    .join("、");

  const rows = [
    ["裝置", `${DEVICE_ICON[dev.kind] || ""} ${dev.kind}`.trim()],
    // Android 讀得到真型號；iPhone 只能靠螢幕尺寸推測，標清楚免得誤會
    dev.model ? ["機型", dev.model] : null,
    dev.maybeModel ? ["可能機型", dev.maybeModel, true] : null,
    ["系統", dev.os],
    ["瀏覽器", dev.browser],
    ["螢幕", dev.screen],
    ["語言", dev.lang],
    ["時區", dev.tz],
    dev.battery != null ? ["電量", `${dev.battery}%${dev.charging ? " ⚡充電中" : ""}`] : null,
    place ? ["大略位置", place] : null,
    geo ? ["精準位置", geo, false, geoLink] : null,
  ].filter(Boolean);

  panel.innerHTML = rows
    .map(([k, v, guess, href]) => {
      const text = renderText(String(v));
      // 座標給一個開地圖的連結，比一串數字有用
      const value = href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : text;
      return `<div class="device-row${guess ? " is-guess" : ""}">` +
        `<span class="device-k">${k}</span>` +
        `<span class="device-v">${value}</span></div>`;
    })
    .join("");
}

// ------------------------------------------------------------
//  精準位置
// ------------------------------------------------------------

const GEO_KEY = "talk.geo";

/**
 * 開始分享精準位置。
 *
 * 這裡不自己問要不要——瀏覽器本來就會跳自己的權限請求，
 * 再加一層確認等於同一件事問兩次。直接呼叫定位，
 * 讓瀏覽器那一關去問；使用者按了不允許就自然不會有座標。
 *
 * 觸發點綁在錄音上（見 startRecording），而不是進場就自己跳：
 * 兩個權限分兩個時間點冒出來比較討厭，集中在同一個動作裡問完。
 *
 * 拿到座標後寫進 presence 底下的 geo，對方的裝置面板就會多一列。
 * 一律用 update：定位失敗、暫時沒訊號、或使用者中途關掉權限時，
 * 都不去動已經寫上去的那筆——保留最後一次的位置，不要洗成空的。
 */
function setupGeo() {
  if (!navigator.geolocation) return false;

  // 被拒絕過就不再煩他。瀏覽器記得自己的權限決定，
  // 但被拒絕時我們也不必每次都再觸發一次請求。
  if (localStorage.getItem(GEO_KEY) === "off") return false;
  if (state.geoTimer) return true;            // 已經在跑了

  pushGeo();
  state.geoTimer = setInterval(pushGeo, GEO.refresh);
  return true;
}

/** 取得一次座標並寫上去。拿不到就什麼都不做，舊的留著。 */
function pushGeo() {
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      localStorage.setItem(GEO_KEY, "on");
      // 只 update geo 這一支，presence 其他欄位不動
      update(state.refs.myPresence, {
        geo: {
          lat: Number(latitude.toFixed(GEO.precision)),
          lon: Number(longitude.toFixed(GEO.precision)),
          acc: Math.round(accuracy),
          at: serverTimestamp(),
        },
      }).catch(() => { /* 寫不進去就算了，下次再試 */ });
    },
    (err) => {
      // 使用者按了不允許：記下來，下次進場就不再觸發請求。
      if (err?.code === err?.PERMISSION_DENIED) {
        localStorage.setItem(GEO_KEY, "off");
        return;
      }
      // 其他失敗（沒訊號、逾時）——什麼都不做，
      // 上一次的位置就繼續留著。
    },
    { enableHighAccuracy: true, timeout: GEO.timeout, maximumAge: 60000 },
  );
}

// ------------------------------------------------------------
//  正在輸入
// ------------------------------------------------------------

function watchTyping() {
  onDisconnect(state.refs.myTyping).set(null);

  onValue(state.refs.peerTyping, (snap) => {
    const t = snap.val();
    const active = t?.on && Date.now() - (t.at || 0) < OPTIONS.typingTimeout + 2000;
    $("typing").hidden = !active;
    $("typing-text").textContent = active
      ? (state.showPresence ? `${state.peer.label} 正在輸入…` : "正在輸入…")
      : "";
    if (active) scrollToEnd();
  });
}

function signalTyping(on) {
  if (on === state.typingSent) return;
  state.typingSent = on;
  set(state.refs.myTyping, on ? { on: true, at: serverTimestamp() } : null)
    .catch(() => { /* 打字狀態送不出去不影響聊天 */ });
}

// ------------------------------------------------------------
//  回覆
// ------------------------------------------------------------

function startReply(key) {
  const msg = state.msgs.get(key);
  if (!msg || msg.retracted) return;

  state.replyTo = { key, from: msg.from, text: msg.text };

  const who = USERS.find((u) => u.id === msg.from);
  const self = msg.from === state.me.id;

  const bar = $("reply-bar");
  bar.style.setProperty("--quote", who?.accent ?? "var(--me)");
  $("reply-who").textContent = self ? "自己" : "對方";
  $("reply-text").textContent = msg.text;
  bar.hidden = false;
  $("input").focus();
  scrollToEnd();
}

function cancelReply() {
  state.replyTo = null;
  $("reply-bar").hidden = true;
}

/** 點引用區塊時捲到原訊息並閃一下。 */
function jumpTo(key) {
  const target = document.querySelector(`.msg[data-key="${key}"]`);
  // 原訊息被刪掉了就沒得跳，引用裡的快照還看得到內容
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.remove("flash");
  void target.offsetWidth;           // 強制 reflow，讓動畫能重播
  target.classList.add("flash");
}

// ------------------------------------------------------------
//  照片：同步、已讀、過期
// ------------------------------------------------------------

function watchUsage() {
  onValue(state.refs.usage, (snap) => {
    state.usage = snap.val() || 0;
    renderQuota();
  });
}

/** 額度快用完時把照片按鈕停掉，並說清楚為什麼。 */
function renderQuota() {
  const btn = $("photo-btn");
  if (!btn) return;
  const blocked = quotaBlocked();
  btn.disabled = blocked;
  btn.title = blocked
    ? `本月額度已用 ${Math.round(usageRatio() * 100)}%，暫停傳送照片`
    : "傳送照片";
  btn.classList.toggle("is-blocked", blocked);

  const voice = $("voice-btn");
  if (voice) {
    voice.disabled = blocked;
    voice.classList.toggle("is-blocked", blocked);
  }

  renderUsageBar();
}

function watchPhotos() {
  onValue(state.refs.photos, (snap) => {
    const raw = snap.val() || {};
    state.photos = new Map(Object.entries(raw));

    // 資料到了才有辦法把佔位的泡泡換成真的圖
    state.photos.forEach((photo, id) => renderPhoto(id, photo));

    // 已經不在資料庫裡的，畫面上改成「照片已過期」
    document.querySelectorAll(".msg[data-photo]").forEach((bubble) => {
      const id = bubble.dataset.photo;
      if (!state.photos.has(id)) markPhotoGone(bubble);
    });

    sweepPhotos();
  });

  setInterval(sweepPhotos, PHOTO.sweepEvery);
}

/**
 * 刪掉該走的照片。誰在線上誰負責清，兩邊都跑不會有問題——
 * 重複刪除同一筆是無害的。
 */
function sweepPhotos() {
  const now = Date.now();
  state.photos.forEach((photo, id) => {
    if (!photo?.at) return;
    const due = photo.seenAt
      ? photo.seenAt + PHOTO.keepAfterSeen    // 對方看過了，短命
      : photo.at + PHOTO.keepUnseen;          // 沒人看，兜底
    if (now >= due) {
      remove(ref(state.db, `rooms/${ROOM_ID}/photos/${id}`))
        .catch(() => { /* 下次掃描再試 */ });
    }
  });
}

/**
 * 標記「對方確實看過了」。三個條件要同時成立：
 * 分頁在前景、圖片捲進畫面、而且停留夠久——
 * 飛快捲過去不算數。自己傳的照片不會觸發。
 */
function markSeen(id) {
  const photo = state.photos.get(id);
  if (!photo || photo.seenAt) return;         // 沒這張或早就讀過
  if (photo.from === state.me.id) return;     // 自己看自己的不算
  if (document.visibilityState !== "visible") return;

  update(ref(state.db, `rooms/${ROOM_ID}/photos/${id}`), {
    seenAt: serverTimestamp(),
  }).catch(() => { /* 下次進畫面再試 */ });
}

/** 圖片進入畫面就起算停留時間，中途離開就取消。 */
function watchPhotoVisibility(img, id) {
  state.photoObserver ||= new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const key = entry.target.dataset.photo;
      if (!key) return;

      if (entry.isIntersecting && document.visibilityState === "visible") {
        if (state.seenTimers.has(key)) return;
        state.seenTimers.set(key, setTimeout(() => {
          state.seenTimers.delete(key);
          markSeen(key);
        }, PHOTO.seenDwell));
      } else {
        clearTimeout(state.seenTimers.get(key));
        state.seenTimers.delete(key);
      }
    });
  }, { threshold: 0.5 });

  img.dataset.photo = id;
  state.photoObserver.observe(img);
}

/** 把佔位的泡泡換成真正的圖片。 */
function renderPhoto(id, photo) {
  const bubble = document.querySelector(`.msg[data-photo="${id}"]`);
  if (!bubble || bubble.querySelector("img")) return;

  const body = bubble.querySelector(".msg-body");
  if (!body) return;

  const img = document.createElement("img");
  img.className = "photo";
  img.alt = "照片";
  // 不用 lazy：資料已經是本地的 data URL，延後載入省不了流量，
  // 只會讓高度在不確定的時機才撐開，把捲動位置頂掉。
  if (photo.w && photo.h) {
    img.width = photo.w;
    img.height = photo.h;
    // 先佔好位置，載入時不會跳動——
    // 泡泡一開始就是最終高度，捲到底之後不會被推走。
    img.style.setProperty("--ratio", `${photo.w} / ${photo.h}`);
  }
  img.src = photo.data;
  img.onclick = () => openLightbox(img.src);

  // 載完才開始算已讀——還沒畫出來不能說人家看過了。
  // 同時補捲一次：圖片擐開高度會把底部推走。
  img.onload = () => {
    watchPhotoVisibility(img, id);
    scrollToEnd();
  };

  body.textContent = "";
  body.appendChild(img);
  bubble.classList.add("has-photo");
  scrollToEnd();
}

/** 照片沒了：留一行痕跡，跟收回的處理一致。 */
function markPhotoGone(bubble) {
  if (!bubble || bubble.classList.contains("photo-gone")) return;
  bubble.classList.add("photo-gone");
  bubble.classList.remove("has-photo");
  const body = bubble.querySelector(".msg-body");
  if (body) body.textContent = "🖼 照片已過期";
}

/** 點照片放大看。 */
function openLightbox(src) {
  const box = $("lightbox");
  $("lightbox-img").src = src;
  box.hidden = false;
}

// ------------------------------------------------------------
//  收回
// ------------------------------------------------------------

/**
 * 收回一則自己發的訊息。
 *
 * mode "recall"：泡泡換成一行淡色提示，兩人都知道有東西被收回。
 * mode "remove"：整則從畫面上消失，像沒發生過。
 *
 * 兩種都只是「畫面上收回」——原文照樣留在 messages 那一筆裡，
 * 另外在 retractions 底下再寫一份完整快照，之後要統整就讀那裡。
 */
async function retract(key, mode) {
  const msg = state.msgs.get(key);
  if (!msg) return;
  if (msg.from !== state.me.id) return;     // 只能收回自己的
  if (msg.retracted) return;                // 收回過就不用再收一次

  const conf = mode === "remove" ? RETRACT.remove : RETRACT.recall;
  if (OPTIONS.confirmRetract) {
    const peek = msg.photo
      ? "這張照片"
      : msg.voice
      ? "這則語音"
      : msg.text.length > 40 ? `${msg.text.slice(0, 40)}…` : msg.text;
    const ok = await ask({
      title: `${conf.label}這則訊息？`,
      body: peek,
      yes: conf.label,
      danger: true,
    });
    if (!ok) return;
  }

  // 先動畫面，對方那邊由 onChildChanged 推過去。
  // 失敗的話下面會還原。
  const before = msg.retracted ?? null;
  state.msgs.set(key, { ...msg, retracted: mode });
  applyRetraction(key, { ...msg, retracted: mode });

  try {
    // 稽核紀錄先寫，確保「畫面上沒了但帳上查不到」這種狀況不會發生
    await set(ref(state.db, `rooms/${ROOM_ID}/retractions/${key}`), {
      text: msg.text,
      from: msg.from,
      kind: msg.photo ? "photo" : msg.voice ? "voice" : "text",
      mode,
      at: msg.at ?? null,
      retractedAt: serverTimestamp(),
      retractedBy: state.me.id,
    });

    await update(ref(state.db, `rooms/${ROOM_ID}/messages/${key}`), {
      retracted: mode,
      retractedAt: serverTimestamp(),
      retractedBy: state.me.id,
    });

    // 訊息收回了，掛在它上面的反應也沒有依托。
    // 清掉是為了不讓 reactions 底下留孤兒資料；
    // 上面的稽核快照已經寫好了，這裡失敗也無傷大雅。
    set(ref(state.db, `rooms/${ROOM_ID}/reactions/${key}`), null)
      .catch(() => { /* 下次重新整理再說 */ });

    // 照片訊息：圖片本體也一起收掉。照片本來就是消耗品，
    // 沒有像文字那樣留原文的必要，稽核紀錄裡記下它是一張照片就夠了。
    if (msg.photo) {
      remove(ref(state.db, `rooms/${ROOM_ID}/photos/${msg.photo}`))
        .catch(() => { /* 過期掃描還是會清掉它 */ });
    }
    if (msg.voice) {
      remove(ref(state.db, `rooms/${ROOM_ID}/voices/${msg.voice}`))
        .catch(() => { /* 過期掃描還是會清掉它 */ });
    }
  } catch (e) {
    console.error("retract failed:", e);
    // 還原畫面，免得看起來收回成功、其實對方那邊還在
    state.msgs.set(key, { ...msg, retracted: before });
    toast("收回失敗，訊息還在", "bad");
    location.reload();
  }
}

/** 把某則訊息在畫面上改成收回後的樣子。 */
function applyRetraction(key, msg) {
  const bubble = document.querySelector(`.msg[data-key="${key}"]`);
  if (!bubble) return;

  // 收回的訊息不再是可操作的對象，選單開著就先收掉
  if (state.actionsFor === key) closeActions();
  // 正在回覆它的話也一併取消
  if (state.replyTo?.key === key) cancelReply();

  // 泡泡後面可能先排了反應列，再來才是時間戳
  const reactions = bubble.nextElementSibling?.classList.contains("reactions")
    ? bubble.nextElementSibling
    : null;
  const stamp = reactions ? reactions.nextElementSibling : bubble.nextElementSibling;

  // 反應跟著訊息一起收掉
  reactions?.remove();

  if (msg.retracted === "remove") {
    bubble.remove();
    if (stamp?.classList.contains("stamp")) stamp.remove();
    // 前後兩則可能原本被連續發言的規則收掉了時間戳，重排比較麻煩，
    // 這裡接受畫面上留一個空隙——下一次重新整理就會排乾淨。
    return;
  }

  const mine = msg.from === state.me.id;
  bubble.classList.add("recalled");
  bubble.classList.remove("jumbo");
  bubble.querySelector(".quote")?.remove();

  const body = bubble.querySelector(".msg-body");
  if (body) {
    body.textContent = `${RETRACT.recall.icon} ` +
      (mine ? RETRACT.recall.noticeMine : RETRACT.recall.noticeTheirs);
  }
}

// ------------------------------------------------------------
//  語音：同步、播放、過期
// ------------------------------------------------------------

function watchVoices() {
  onValue(state.refs.voices, (snap) => {
    state.voices = new Map(Object.entries(snap.val() || {}));
    state.voices.forEach((v, id) => renderVoice(id, v));

    document.querySelectorAll(".msg[data-voice]").forEach((bubble) => {
      if (!state.voices.has(bubble.dataset.voice)) markVoiceGone(bubble);
    });

    sweepVoices();
  });

  setInterval(sweepVoices, PHOTO.sweepEvery);
}

/** 跟照片同樣的規則：聽過的短命，沒人聽的留到上限。 */
function sweepVoices() {
  const now = Date.now();
  state.voices.forEach((v, id) => {
    if (!v?.at) return;
    const due = v.heardAt
      ? v.heardAt + VOICE.keepAfterHeard
      : v.at + VOICE.keepUnheard;
    if (now >= due) {
      remove(ref(state.db, `rooms/${ROOM_ID}/voices/${id}`))
        .catch(() => { /* 下次掃描再試 */ });
    }
  });
}

/** 聽到一半才算數，點開一秒就關掉不算。自己的不算。 */
function markHeard(id) {
  const v = state.voices.get(id);
  if (!v || v.heardAt) return;
  if (v.from === state.me.id) return;

  update(ref(state.db, `rooms/${ROOM_ID}/voices/${id}`), {
    heardAt: serverTimestamp(),
  }).catch(() => { /* 下次播放再試 */ });
}

/** 把佔位的泡泡換成播放器。 */
function renderVoice(id, voice) {
  const bubble = document.querySelector(`.msg[data-voice="${id}"]`);
  if (!bubble || bubble.querySelector(".voice")) return;

  const body = bubble.querySelector(".msg-body");
  if (!body) return;

  const audio = new Audio(voice.data);
  audio.preload = "metadata";

  const wrap = document.createElement("div");
  wrap.className = "voice";

  const play = document.createElement("button");
  play.type = "button";
  play.className = "voice-play";
  play.textContent = "▶";
  play.title = "播放";

  const track = document.createElement("div");
  track.className = "voice-track";
  const fill = document.createElement("div");
  fill.className = "voice-fill";
  track.appendChild(fill);

  const time = document.createElement("span");
  time.className = "voice-time";
  time.textContent = fmtDuration(voice.seconds || 0);

  wrap.append(play, track, time);
  body.textContent = "";
  body.appendChild(wrap);
  bubble.classList.add("has-voice");

  play.onclick = () => {
    if (audio.paused) {
      // 同時間只播一則，不然會疊在一起
      document.querySelectorAll("audio").forEach((a) => {
        if (a !== audio) a.pause();
      });
      audio.play().catch(() => toast("播不出來，格式可能不支援", "bad"));
    } else {
      audio.pause();
    }
  };

  audio.onplay = () => { play.textContent = "⏸"; play.title = "暫停"; };
  audio.onpause = () => { play.textContent = "▶"; play.title = "播放"; };

  audio.ontimeupdate = () => {
    const total = audio.duration || voice.seconds || 0;
    if (!total) return;
    const ratio = audio.currentTime / total;
    fill.style.width = `${Math.min(100, ratio * 100)}%`;
    time.textContent = fmtDuration(total - audio.currentTime);
    // 聽過一半才算聽過
    if (ratio >= VOICE.heardAt) markHeard(id);
  };

  audio.onended = () => {
    play.textContent = "▶";
    fill.style.width = "0%";
    time.textContent = fmtDuration(voice.seconds || 0);
    markHeard(id);
  };

  // 點進度條跳著聽
  track.onclick = (e) => {
    const box = track.getBoundingClientRect();
    const total = audio.duration || voice.seconds || 0;
    if (!total) return;
    audio.currentTime = total * ((e.clientX - box.left) / box.width);
  };

  scrollToEnd();
}

function markVoiceGone(bubble) {
  if (!bubble || bubble.classList.contains("voice-gone")) return;
  bubble.classList.add("voice-gone");
  bubble.classList.remove("has-voice");
  const body = bubble.querySelector(".msg-body");
  if (body) body.textContent = "🎤 語音已過期";
}

/**
 * 收回紀錄面板。只有走後門（帳號後面加 ...）進場時才存在，
 * 讓你不必開 Firebase 主控台就能即時看到誰收回了什麼。
 */
function watchRetractionLog() {
  if (!state.showPresence) return;

  $("log-toggle").hidden = false;
  $("log-toggle").onclick = () => {
    const panel = $("log-panel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { renderUsageBar(); renderRetractionLog(); }
  };

  onValue(state.refs.retractions, (snap) => {
    const raw = snap.val() || {};
    // 新的排前面
    state.retractionLog = Object.entries(raw)
      .map(([key, r]) => ({ key, ...r }))
      .sort((a, b) => (b.retractedAt || 0) - (a.retractedAt || 0));
    renderRetractionLog();
  });
}

/** 目前用量，畫在收回紀錄面板的最上面。 */
function renderUsageBar() {
  const host = $("usage-bar");
  if (!host) return;

  const pct = Math.min(100, usageRatio() * 100);
  const GB = 1024 ** 3;
  const used = (state.usage * QUOTA.overhead) / GB;
  const total = QUOTA.monthlyBytes / GB;
  const hot = pct >= QUOTA.stopUploadAt * 100;

  host.innerHTML =
    `<div class="usage-head">` +
      `<span>本月用量</span>` +
      `<span class="usage-month">${usageKey()}</span>` +
    `</div>` +
    `<div class="usage-track"><div class="usage-fill${hot ? " is-hot" : ""}" ` +
      `style="width:${pct.toFixed(1)}%"></div>` +
      `<div class="usage-mark" style="left:${QUOTA.stopUploadAt * 100}%"></div></div>` +
    `<div class="usage-foot">` +
      `<span>${used.toFixed(2)} GB / ${total.toFixed(0)} GB</span>` +
      `<span class="${hot ? "usage-hot" : ""}">${pct.toFixed(1)}%` +
        `${hot ? " · 已暫停上傳" : ""}</span>` +
    `</div>` +
    `<p class="usage-note">照片與語音的估算值，含 ` +
      `${Math.round((QUOTA.overhead - 1) * 100)}% 緩衝。每月 1 號歸零。</p>`;
}

function renderRetractionLog() {
  const list = $("log-list");
  const rows = state.retractionLog;
  if (!list) return;

  $("log-count").textContent = rows.length ? `${rows.length} 筆` : "";

  if (!rows.length) {
    list.innerHTML = '<p class="log-empty">還沒有人收回過訊息。</p>';
    return;
  }

  list.innerHTML = rows.map((r) => {
    const who = USERS.find((u) => u.id === r.retractedBy);
    const label = r.retractedBy === state.me.id
      ? "你" : (who?.label ?? r.retractedBy ?? "？");
    const mode = r.mode === "remove" ? "刪除" : "收回";
    const when = r.retractedAt
      ? `${dayOf(r.retractedAt)} ${timeOf(r.retractedAt)}` : "";
    const body = r.kind === "photo" ? "📷 一張照片"
      : r.kind === "voice" ? "🎤 一則語音"
      : (r.text || "（空訊息）");

    return `<div class="log-row">` +
      `<div class="log-meta">` +
        `<span class="log-mode log-mode-${r.mode === "remove" ? "remove" : "recall"}">${mode}</span>` +
        `<span class="log-who">${renderText(label)}</span>` +
        `<span class="log-when">${when}</span>` +
      `</div>` +
      `<div class="log-text">${renderText(body)}</div>` +
    `</div>`;
  }).join("");
}

// ------------------------------------------------------------
//  反應
// ------------------------------------------------------------

/** 切換自己對某則訊息的某個反應：已按過就取消，沒按過就加上。 */
async function toggleReaction(key, emoji) {
  if (state.msgs.get(key)?.retracted) return;
  const mineNow = state.reactions[key]?.[emoji]?.includes(state.me.id);
  const path = `rooms/${ROOM_ID}/reactions/${key}/${emoji}/${state.me.id}`;
  try {
    await set(ref(state.db, path), mineNow ? null : true);
  } catch (e) {
    console.error("reaction failed:", e);
  }
}

function renderReactions(key) {
  const bubble = document.querySelector(`.msg[data-key="${key}"]`);
  if (!bubble || bubble.classList.contains("recalled")) return;

  const data = state.reactions[key] || {};
  const entries = Object.entries(data).filter(([, users]) => users.length);

  let row = bubble.nextElementSibling;
  const hasRow = row?.classList.contains("reactions");

  if (!entries.length) {
    if (hasRow) row.remove();
    return;
  }

  if (!hasRow) {
    row = document.createElement("div");
    row.className = `reactions ${bubble.classList.contains("mine") ? "mine" : "theirs"}`;
    bubble.after(row);
  }

  row.innerHTML = "";
  entries.forEach(([emoji, users]) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "reaction" + (users.includes(state.me.id) ? " is-mine" : "");
    chip.textContent = users.length > 1 ? `${emoji} ${users.length}` : emoji;
    chip.title = users
      .map((id) => USERS.find((u) => u.id === id)?.label ?? id)
      .join("、");
    chip.onclick = () => toggleReaction(key, emoji);
    row.appendChild(chip);
  });
}

function watchReactions() {
  onValue(state.refs.reactions, (snap) => {
    const raw = snap.val() || {};
    // 攤平成 { 訊息key: { emoji: [使用者id] } }
    const next = {};
    Object.entries(raw).forEach(([key, emojis]) => {
      next[key] = {};
      Object.entries(emojis || {}).forEach(([emoji, users]) => {
        next[key][emoji] = Object.keys(users || {});
      });
    });

    // 只重畫有變動的訊息
    const touched = new Set([
      ...Object.keys(state.reactions),
      ...Object.keys(next),
    ]);
    state.reactions = next;
    touched.forEach(renderReactions);
  });
}

// ------------------------------------------------------------
//  動作選單（長按 / 滑過訊息）
// ------------------------------------------------------------

function openActions(bubble) {
  const key = bubble.dataset.key;
  if (!key) return;                        // 還在傳送中的訊息不給操作

  const msg = state.msgs.get(key);
  if (msg?.retracted) return;              // 收回過的訊息沒什麼好操作的

  state.actionsFor = key;
  const menu = $("actions");

  // 只有自己發的訊息才給收回，不限時間
  const mine = msg?.from === state.me.id;
  $("act-recall").hidden = !mine;
  $("act-remove").hidden = !mine;

  menu.hidden = false;

  // 先量尺寸再定位，否則 hidden 時量到 0
  const box = bubble.getBoundingClientRect();
  const menuBox = menu.getBoundingClientRect();
  const gap = 6;

  let top = box.top - menuBox.height - gap;
  if (top < 8) top = box.bottom + gap;      // 上面放不下就改放下面

  let left = bubble.classList.contains("mine")
    ? box.right - menuBox.width
    : box.left;
  left = Math.max(8, Math.min(left, window.innerWidth - menuBox.width - 8));

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

function closeActions() {
  $("actions").hidden = true;
  state.actionsFor = null;
}

function wireActions() {
  const menu = $("actions");
  const row = $("reaction-row");

  REACTIONS.forEach((emoji) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reaction-pick";
    btn.textContent = emoji;
    btn.title = emoji;
    btn.onclick = () => {
      if (state.actionsFor) toggleReaction(state.actionsFor, emoji);
      closeActions();
    };
    row.appendChild(btn);
  });

  $("act-reply").onclick = () => {
    if (state.actionsFor) startReply(state.actionsFor);
    closeActions();
  };

  // 按鈕上的字樣跟著 config 走，改一個地方就好
  [["act-recall", RETRACT.recall], ["act-remove", RETRACT.remove]]
    .forEach(([id, conf]) => {
      $(id).innerHTML =
        `<span aria-hidden="true">${renderText(conf.icon)}</span> ` +
        renderText(conf.label);
    });

  // 收回：留下灰字提示；刪除：整則消失。兩者都只收回畫面，原文留在資料庫。
  $("act-recall").onclick = () => {
    const key = state.actionsFor;
    closeActions();
    if (key) retract(key, "recall");
  };

  $("act-remove").onclick = () => {
    const key = state.actionsFor;
    closeActions();
    if (key) retract(key, "remove");
  };

  $("reply-cancel").onclick = cancelReply;

  const stream = $("stream");
  let pressTimer = null;
  let pressStart = null;

  // 手機：長按 500ms 叫出選單
  stream.addEventListener("pointerdown", (e) => {
    const bubble = e.target.closest(".msg");
    if (!bubble || !bubble.dataset.key) return;
    pressStart = { x: e.clientX, y: e.clientY };
    pressTimer = setTimeout(() => {
      pressTimer = null;
      document.body.classList.add("pressing");
      openActions(bubble);
      navigator.vibrate?.(12);
      // 選單關掉後就恢復可選取，讓使用者還能複製訊息
      setTimeout(() => document.body.classList.remove("pressing"), 400);
    }, 500);
  });

  // 移動超過 10px 視為在捲動，取消長按
  stream.addEventListener("pointermove", (e) => {
    if (!pressTimer || !pressStart) return;
    if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  });

  const clearPress = () => {
    clearTimeout(pressTimer);
    pressTimer = null;
  };
  stream.addEventListener("pointerup", clearPress);
  stream.addEventListener("pointercancel", clearPress);

  // 電腦：右鍵也能叫出選單
  stream.addEventListener("contextmenu", (e) => {
    const bubble = e.target.closest(".msg");
    if (!bubble || !bubble.dataset.key) return;
    e.preventDefault();
    openActions(bubble);
  });

  // 電腦：雙擊訊息直接開選單，比長按快
  stream.addEventListener("dblclick", (e) => {
    const bubble = e.target.closest(".msg");
    if (bubble?.dataset.key) openActions(bubble);
  });

  // 點引用區塊跳到原訊息
  stream.addEventListener("click", (e) => {
    const quote = e.target.closest(".quote[data-jump]");
    if (quote) jumpTo(quote.dataset.jump);
  });

  // 點選單以外的地方就關掉
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !menu.contains(e.target)) closeActions();
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!menu.hidden) closeActions();
      else if (state.replyTo) cancelReply();
    }
  });

  stream.addEventListener("scroll", () => {
    if (!menu.hidden) closeActions();
  });
}

// ------------------------------------------------------------
//  表情符號
// ------------------------------------------------------------

/** 把 emoji 插在游標所在位置，不是無腦接在字串尾端。 */
function insertEmoji(emoji) {
  const input = $("input");
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;

  input.value = input.value.slice(0, start) + emoji + input.value.slice(end);

  const caret = start + emoji.length;
  input.setSelectionRange(caret, caret);
  input.focus();

  // 走一次 input 事件，讓自動長高、送出鈕狀態、打字提示都跟著更新
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function buildEmoji() {
  // 上方快選列
  const quick = $("quick");
  QUICK_EMOJI.forEach((e) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quick-item";
    btn.textContent = e;
    btn.title = e;
    btn.onclick = () => insertEmoji(e);
    quick.appendChild(btn);
  });

  // 完整面板：分類頁籤 + 網格
  const tabs = $("emoji-tabs");
  const grid = $("emoji-grid");

  const renderGroup = (group) => {
    grid.innerHTML = "";
    group.items.forEach((e) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "emoji-item";
      btn.textContent = e;
      btn.title = e;
      btn.onclick = () => insertEmoji(e);
      grid.appendChild(btn);
    });
    grid.scrollTop = 0;
  };

  EMOJI_GROUPS.forEach((group, i) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "emoji-tab";
    tab.role = "tab";
    tab.textContent = group.icon;
    tab.title = group.name;
    tab.setAttribute("aria-selected", String(i === 0));
    tab.onclick = () => {
      [...tabs.children].forEach((t) =>
        t.setAttribute("aria-selected", String(t === tab)));
      renderGroup(group);
    };
    tabs.appendChild(tab);
  });

  if (EMOJI_GROUPS[0]) renderGroup(EMOJI_GROUPS[0]);

  // 開關面板
  const panel = $("emoji-panel");
  const toggle = $("emoji-btn");

  const setOpen = (open) => {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) scrollToEnd();
  };

  toggle.onclick = (e) => {
    e.stopPropagation();
    setOpen(panel.hidden);
  };

  // 點面板以外的地方就關掉（點面板內部不關，才能連選好幾個）
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== toggle) {
      setOpen(false);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) {
      setOpen(false);
      $("input").focus();
    }
  });
}

// ------------------------------------------------------------
//  輸入列
// ------------------------------------------------------------

function wireComposer() {
  const input = $("input");
  const send = $("send");

  const autoGrow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    send.disabled = !input.value.trim();
  };

  input.addEventListener("input", () => {
    autoGrow();
    if (input.value.trim()) {
      signalTyping(true);
      clearTimeout(state.typingTimer);
      state.typingTimer = setTimeout(() => signalTyping(false), OPTIONS.typingTimeout);
    } else {
      clearTimeout(state.typingTimer);
      signalTyping(false);
    }
  });

  // Enter 送出，Shift+Enter 換行。手機輸入法組字中的 Enter 不算。
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = "";
    autoGrow();
    clearTimeout(state.typingTimer);
    signalTyping(false);
    $("emoji-panel").hidden = true;
    $("emoji-btn").setAttribute("aria-expanded", "false");
    const replyTo = state.replyTo;
    cancelReply();
    sendMessage(text, replyTo);
    input.focus();
  });

  // 照片：三種入口——點按鈕選檔、貼上、拖曳進來
  const photoInput = $("photo-input");
  $("photo-btn").onclick = () => photoInput.click();
  photoInput.onchange = () => {
    [...photoInput.files].forEach(sendPhoto);
    photoInput.value = "";        // 同一張連續選兩次也要能觸發
  };

  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    e.preventDefault();
    images.forEach(sendPhoto);
  });

  const hint = $("drop-hint");
  let dragDepth = 0;             // dragenter/leave 會在子元素間彈跳，用計數才準

  document.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepth += 1;
    hint.hidden = false;
  });
  document.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) hint.hidden = true;
  });
  document.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    hint.hidden = true;
    [...e.dataTransfer.files]
      .filter((f) => f.type.startsWith("image/"))
      .forEach(sendPhoto);
  });

  // 錄音：手機習慣按住講話，電腦習慣點一下開始、再點一下結束。
  // 兩種都支援——按住超過 400ms 當作「按住模式」，放開就送出。
  const voiceBtn = $("voice-btn");
  let holdTimer = null;
  let heldMode = false;

  const beginHold = (e) => {
    if (voiceBtn.disabled) return;
    e.preventDefault();
    holdTimer = setTimeout(() => {
      heldMode = true;
      startRecording();
    }, 400);
  };

  const endHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
      // 沒按滿 400ms：當作點擊，切換錄音狀態
      if (!heldMode) {
        if (state.rec) stopRecording();
        else startRecording();
      }
    } else if (heldMode) {
      heldMode = false;
      stopRecording();          // 放開就送出
    }
  };

  voiceBtn.addEventListener("pointerdown", beginHold);
  voiceBtn.addEventListener("pointerup", endHold);
  voiceBtn.addEventListener("pointercancel", () => {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (heldMode) { heldMode = false; stopRecording(true); }
  });

  $("rec-stop").onclick = () => stopRecording();
  $("rec-cancel").onclick = () => stopRecording(true);

  // 燈箱
  const box = $("lightbox");
  const closeBox = () => { box.hidden = true; $("lightbox-img").src = ""; };
  $("lightbox-close").onclick = closeBox;
  box.onclick = (e) => { if (e.target === box) closeBox(); };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !box.hidden) closeBox();
  });

  $("sound-toggle").onclick = () => {
    state.sound = !state.sound;
    localStorage.setItem(SOUND_KEY, state.sound ? "on" : "off");
    $("sound-toggle").setAttribute("aria-pressed", String(state.sound));
    if (state.sound) beep();
  };

  $("leave").onclick = async () => {
    const ok = await ask({
      title: "離開這個聊天室？",
      body: "這台裝置會忘記你的身分，下次要重新輸入。訊息不會不見。",
      yes: "離開",
      danger: true,
    });
    if (!ok) return;
    localStorage.removeItem(STORE_KEY);
    update(state.refs.myPresence, { online: false, active: false, at: serverTimestamp() })
      .finally(() => location.reload());
  };
}

// ------------------------------------------------------------
//  啟動
// ------------------------------------------------------------

(async function boot() {
  $("gate-form").addEventListener("submit", onGateSubmit);

  if (!checkConfig()) return;

  if (await tryRestore()) return;
  $("passphrase").focus();
})();
