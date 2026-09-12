// ============================================================
//  talk —— 主程式
// ============================================================

import {
  firebaseConfig, ROOM_ID, USERS, OPTIONS,
  QUICK_EMOJI, EMOJI_GROUPS, REACTIONS, RETRACT, IPHONE_MODELS,
} from "./config.js";

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase, ref, push, set, update, serverTimestamp,
  query, limitToLast, onChildAdded, onChildChanged,
  onValue, onDisconnect, off,
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
      renderReactions(snap.key);
      return;
    }

    const mine = msg.from === state.me.id;
    appendMessage({ ...msg, key: snap.key }, mine);
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
    scrollToEnd();
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
  bubble.className = `msg ${mine ? "mine" : "theirs"}${run ? " run-mid" : " run-start"}`
    + (recalled ? " recalled" : isJumbo(msg.text) ? " jumbo" : "");
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
    });
    // 收回後的泡泡不掛反應，舊的反應也跟著訊息一起收掉
    if (!recalled) renderReactions(msg.key);
  }

  scrollToEnd();
  return { bubble, stamp };
}

function scrollToEnd() {
  const stream = $("stream");
  // 使用者往上翻歷史時不要硬把他拉回底部
  const nearBottom =
    stream.scrollHeight - stream.scrollTop - stream.clientHeight < 160;
  if (nearBottom) stream.scrollTop = stream.scrollHeight;
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

  document.addEventListener("visibilitychange", beat);

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
  ].filter(Boolean);

  panel.innerHTML = rows
    .map(([k, v, guess]) =>
      `<div class="device-row${guess ? " is-guess" : ""}">` +
      `<span class="device-k">${k}</span>` +
      `<span class="device-v">${renderText(String(v))}</span></div>`)
    .join("");
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
    const peek = msg.text.length > 40 ? `${msg.text.slice(0, 40)}…` : msg.text;
    if (!confirm(`${conf.label}這則訊息？\n\n${peek}`)) return;
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
  } catch (e) {
    console.error("retract failed:", e);
    // 還原畫面，免得看起來收回成功、其實對方那邊還在
    state.msgs.set(key, { ...msg, retracted: before });
    alert("收回失敗，訊息還在。檢查一下網路再試。");
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

  $("sound-toggle").onclick = () => {
    state.sound = !state.sound;
    localStorage.setItem(SOUND_KEY, state.sound ? "on" : "off");
    $("sound-toggle").setAttribute("aria-pressed", String(state.sound));
    if (state.sound) beep();
  };

  $("leave").onclick = () => {
    if (!confirm("離開並忘記這台裝置上的身分？")) return;
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
