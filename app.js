// Poker Chips - Firebase Realtime Database. Host is authoritative.
// Real cards at the table; this app tracks stacks, bets, turn order, dealer,
// and lets the host award pots.

const $ = (id) => document.getElementById(id);
const LOG_MAX = 40;

// ---------- Firebase Config ----------
// Get from: Firebase Console > Project Settings > Your apps > Web app
const firebaseConfig = {
  apiKey: "AIzaSyD0S5jCc8PapIdim6NqNPvp-GztxtENr-c",
  authDomain: "poker-tracker-feab3.firebaseapp.com",
  databaseURL: "https://poker-tracker-feab3-default-rtdb.firebaseio.com",
  projectId: "poker-tracker-feab3",
  storageBucket: "poker-tracker-feab3.firebasestorage.app",
  messagingSenderId: "799851051459",
  appId: "1:799851051459:web:4fb725cd3b7d990f446576",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ---------- State ----------
const S = {
  role: null,          // "host" | "client"
  myId: null,          // unique player id (random, per tab)
  myName: "",
  lobbyCode: "",       // 5-char code
  game: null,          // authoritative state (host only)
  view: null,          // latest view for rendering
  log: [],
  cleanup: [],         // tear-down functions
};

// Persistent player ID per browser tab
function getPlayerId() {
  let id = sessionStorage.getItem("pokerPlayerId");
  if (!id) {
    id = "P" + rid(8);
    sessionStorage.setItem("pokerPlayerId", id);
  }
  return id;
}

// ---------- Utility ----------
function setStatus(msg, err = false) {
  const el = $("welcomeStatus");
  if (el) { el.textContent = msg || ""; el.classList.toggle("error", !!err); }
  const gs = $("status");
  if (gs && !$("game").classList.contains("hidden")) {
    gs.textContent = msg || ""; gs.classList.toggle("error", !!err);
  }
}
function show(screen) {
  $("welcome").classList.toggle("hidden", screen !== "welcome");
  $("game").classList.toggle("hidden", screen !== "game");
}
function saveName(n) { try { localStorage.setItem("pokerName", n); } catch (_) {} }
function loadName() { try { return localStorage.getItem("pokerName") || ""; } catch (_) { return ""; } }
function addLog(line) {
  S.log.push({ t: Date.now(), line });
  if (S.log.length > LOG_MAX) S.log.shift();
  renderLog();
}
function renderLog() {
  const el = $("log"); if (!el) return;
  el.innerHTML = S.log.map(e => `<div class="entry">${escapeHTML(e.line)}</div>`).join("");
  el.scrollTop = el.scrollHeight;
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function rid(n = 5) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = ""; for (let i = 0; i < n; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

// ---------- Firebase Helpers ----------
function lobbyRef() { return db.ref("lobbies/" + S.lobbyCode); }

function broadcastState() {
  const view = viewFromGame(S.game);
  S.view = view;
  lobbyRef().update({
    state: view,
    log: S.log.slice(-LOG_MAX),
  });
  renderAll();
}

function leaveLobby() {
  S.cleanup.forEach(fn => { try { fn(); } catch (_) {} });
  S.cleanup = [];
  location.reload();
}

// ---------- HOST ----------
async function createLobby() {
  const name = ($("playerName").value || "").trim() || "Host";
  saveName(name);
  const startStack = Math.max(1, parseInt($("startStack").value, 10) || 1000);
  const sb = Math.max(0, parseInt($("smallBlind").value, 10) || 5);
  const bb = Math.max(sb, parseInt($("bigBlind").value, 10) || 10);

  setStatus("Creating lobby\u2026");

  S.role = "host";
  S.myId = getPlayerId();
  S.myName = name;
  S.lobbyCode = rid(5);

  S.game = newGame({ startStack, sb, bb });
  addPlayer(S.game, S.myId, name);

  const ref = lobbyRef();

  // Write initial lobby
  await ref.set({
    config: { startStack, sb, bb, hostId: S.myId },
    state: viewFromGame(S.game),
    log: [],
  });

  // Presence
  const presRef = ref.child("presence/" + S.myId);
  await presRef.set(true);
  presRef.onDisconnect().remove();
  S.cleanup.push(() => presRef.remove());

  // Detect client disconnects
  ref.child("presence").on("child_removed", (snap) => {
    const pid = snap.key;
    if (pid !== S.myId && S.game.players[pid]) {
      markDisconnected(S.game, pid, true);
      broadcastState();
    }
  });
  S.cleanup.push(() => ref.child("presence").off());

  // Listen for actions from clients
  const actRef = ref.child("actions");
  actRef.on("child_added", (snap) => {
    const msg = snap.val();
    snap.ref.remove();
    if (msg) handleHostMessage(msg);
  });
  S.cleanup.push(() => actRef.off());

  addLog(`Lobby created. Code: ${S.lobbyCode}`);
  enterGame();
  broadcastState();
}

function handleHostMessage(msg) {
  if (!msg || !msg.type) return;
  const playerId = msg.playerId;
  if (!playerId) return;

  switch (msg.type) {
    case "join": {
      const pname = String(msg.name || "Guest").slice(0, 20);
      if (!S.game.players[playerId]) {
        addPlayer(S.game, playerId, pname);
        addLog(`${pname} joined.`);
      } else {
        S.game.players[playerId].name = pname;
        S.game.players[playerId].disconnected = false;
        addLog(`${pname} reconnected.`);
      }
      broadcastState();
      break;
    }
    case "action": {
      if (playerId !== S.game.turn) return;
      applyAction(S.game, playerId, msg.kind, msg.amount);
      broadcastState();
      break;
    }
  }
}

// ---------- CLIENT ----------
async function joinLobby() {
  const name = ($("playerName").value || "").trim();
  if (!name) return setStatus("Enter your name first.", true);
  const code = ($("joinCode").value || "").trim().toUpperCase();
  if (!code) return setStatus("Enter a lobby code.", true);

  saveName(name);
  setStatus("Joining\u2026");

  // Check lobby exists
  const snap = await db.ref("lobbies/" + code + "/config").once("value");
  if (!snap.exists()) {
    setStatus("Lobby not found.", true);
    return;
  }

  S.role = "client";
  S.myId = getPlayerId();
  S.myName = name;
  S.lobbyCode = code;

  const ref = lobbyRef();

  // Presence
  const presRef = ref.child("presence/" + S.myId);
  await presRef.set(true);
  presRef.onDisconnect().remove();
  S.cleanup.push(() => presRef.remove());

  // Re-establish presence on reconnect
  db.ref(".info/connected").on("value", (snap) => {
    if (snap.val() === true) {
      presRef.set(true);
      presRef.onDisconnect().remove();
    }
  });
  S.cleanup.push(() => db.ref(".info/connected").off());

  // Send join action
  await ref.child("actions").push({
    type: "join",
    playerId: S.myId,
    name,
  });

  // Listen for state updates
  ref.child("state").on("value", (snap) => {
    const state = snap.val();
    if (state) {
      S.view = state;
      renderAll();
    }
  });
  S.cleanup.push(() => ref.child("state").off());

  // Listen for log updates
  ref.child("log").on("value", (snap) => {
    const log = snap.val();
    if (Array.isArray(log)) {
      S.log = log;
      renderLog();
    }
  });
  S.cleanup.push(() => ref.child("log").off());

  enterGame();
}

function sendAction(kind, amount) {
  if (S.role === "host") {
    applyAction(S.game, S.myId, kind, amount);
    broadcastState();
  } else {
    lobbyRef().child("actions").push({
      type: "action",
      playerId: S.myId,
      kind,
      amount: amount != null ? amount : null,
    });
  }
}

// ---------- Game model (Texas Hold'em: preflop / flop / turn / river) ----------
const STREETS = ["preflop", "flop", "turn", "river"];
function newGame({ startStack, sb, bb }) {
  return {
    hostId: null,
    startStack, sb, bb,
    order: [],
    players: {},
    dealerIdx: 0,
    turn: null,
    pot: 0,
    currentBet: 0,
    minRaise: 0,
    lastAggressor: null,
    street: null,            // "preflop" | "flop" | "turn" | "river" | null
    round: "idle",           // "idle" | "betting" | "wait_deal" | "decide"
    log: [],
  };
}
function addPlayer(g, id, name) {
  if (g.players[id]) return;
  g.players[id] = { id, name, stack: g.startStack, bet: 0, folded: false, allIn: false, disconnected: false };
  g.order.push(id);
  if (!g.hostId) g.hostId = id;
}
function markDisconnected(g, id, v) {
  if (g.players[id]) g.players[id].disconnected = !!v;
}

function startHand(g) {
  const seated = g.order.filter(id => g.players[id].stack > 0 && !g.players[id].disconnected);
  if (seated.length < 2) { addLog("Need at least 2 players with chips."); return false; }
  // Reset hand
  for (const id of g.order) {
    const p = g.players[id];
    p.bet = 0;
    p.folded = p.stack <= 0;
    p.allIn = false;
    p._acted = false;
  }
  // Advance dealer
  g.dealerIdx = nextSeatIdx(g, g.dealerIdx);
  // Blinds (heads-up: dealer is SB, other is BB)
  const seatedIdxs = g.order.map((_, i) => i).filter(i => !g.players[g.order[i]].folded);
  let sbIdx, bbIdx;
  if (seatedIdxs.length === 2) {
    sbIdx = g.dealerIdx;
    bbIdx = nextSeatIdx(g, sbIdx);
  } else {
    sbIdx = nextSeatIdx(g, g.dealerIdx);
    bbIdx = nextSeatIdx(g, sbIdx);
  }
  const sbPaid = postBlind(g, g.order[sbIdx], g.sb);
  const bbPaid = postBlind(g, g.order[bbIdx], g.bb);
  g.pot = sbPaid + bbPaid;
  g.currentBet = g.bb;
  g.minRaise = g.bb;
  g.lastAggressor = g.order[bbIdx];
  const firstToAct = seatedIdxs.length === 2 ? g.order[g.dealerIdx] : g.order[nextSeatIdx(g, bbIdx)];
  g.turn = firstToAct;
  g.street = "preflop";
  g.round = "betting";
  addLog(`New hand. Dealer: ${g.players[g.order[g.dealerIdx]].name}. Blinds ${g.sb}/${g.bb}. Deal hole cards.`);
  return true;
}

function dealNextStreet(g) {
  if (g.round !== "wait_deal") return false;
  const nextIdx = STREETS.indexOf(g.street) + 1;
  if (nextIdx >= STREETS.length) return false;
  g.street = STREETS[nextIdx];
  startBettingRound(g);
  addLog(`Dealt the ${g.street}.`);
  return true;
}

function startBettingRound(g) {
  for (const id of g.order) { g.players[id].bet = 0; g.players[id]._acted = false; }
  g.currentBet = 0;
  g.minRaise = g.bb;
  g.lastAggressor = null;
  const firstIdx = nextSeatIdx(g, g.dealerIdx);
  const firstId = g.order[firstIdx];
  const liveCanAct = g.order.filter(i => !g.players[i].folded && !g.players[i].allIn);
  if (liveCanAct.length < 2) {
    if (g.street === "river") { g.round = "decide"; g.turn = null; }
    else { g.round = "wait_deal"; g.turn = null; }
    return;
  }
  g.turn = firstId;
  g.round = "betting";
}
function postBlind(g, id, amt) {
  const p = g.players[id]; if (!p) return 0;
  const pay = Math.min(amt, p.stack);
  p.stack -= pay; p.bet = pay;
  if (p.stack === 0) p.allIn = true;
  return pay;
}
function nextSeatIdx(g, fromIdx) {
  const n = g.order.length;
  for (let step = 1; step <= n; step++) {
    const i = (fromIdx + step) % n;
    const p = g.players[g.order[i]];
    if (!p.folded && !p.allIn && p.stack > 0 && !p.disconnected) return i;
    if (!p.folded && !p.allIn && p.stack >= 0) return i;
  }
  return fromIdx;
}
function applyAction(g, id, kind, amount) {
  if (g.round !== "betting" || g.turn !== id) return;
  const p = g.players[id]; if (!p || p.folded) return;
  const toCall = Math.max(0, g.currentBet - p.bet);

  if (kind === "fold") {
    p.folded = true;
    addLog(`${p.name} folds.`);
  } else if (kind === "check") {
    if (toCall !== 0) { addLog(`${p.name} can't check.`); return; }
    addLog(`${p.name} checks.`);
  } else if (kind === "call") {
    const pay = Math.min(toCall, p.stack);
    p.stack -= pay; p.bet += pay; g.pot += pay;
    if (p.stack === 0) p.allIn = true;
    addLog(`${p.name} calls ${pay}.`);
  } else if (kind === "raise") {
    const raiseTo = Math.max(0, parseInt(amount, 10) || 0);
    const minTo = g.currentBet + g.minRaise;
    const maxTo = p.bet + p.stack;
    if (raiseTo > maxTo) return;
    if (raiseTo < minTo && raiseTo !== maxTo) { addLog(`Min raise to ${minTo}.`); return; }
    const pay = raiseTo - p.bet;
    p.stack -= pay; p.bet = raiseTo; g.pot += pay;
    if (p.stack === 0) p.allIn = true;
    g.minRaise = Math.max(g.minRaise, raiseTo - g.currentBet);
    g.currentBet = raiseTo;
    g.lastAggressor = id;
    addLog(`${p.name} raises to ${raiseTo}.`);
  } else {
    return;
  }

  const active = g.order.filter(i => !g.players[i].folded);
  if (active.length === 1) {
    const winner = g.players[active[0]];
    winner.stack += g.pot;
    addLog(`${winner.name} wins ${g.pot} (everyone else folded).`);
    g.pot = 0; g.currentBet = 0; g.round = "idle"; g.turn = null; g.lastAggressor = null;
    for (const pid of g.order) { g.players[pid].bet = 0; }
    return;
  }

  g.players[id]._acted = true;

  const idx = g.order.indexOf(id);
  const nextIdx = nextSeatIdx(g, idx);
  const nextId = g.order[nextIdx];

  const liveCanAct = g.order.filter(i => !g.players[i].folded && !g.players[i].allIn);
  const allMatched = liveCanAct.every(i => g.players[i].bet === g.currentBet);
  const allActed = liveCanAct.every(i => g.players[i]._acted);

  if (liveCanAct.length <= 1 && active.length >= 2) {
    addLog("No further action possible. Reveal remaining cards then award.");
    closeStreet(g, true);
    return;
  }

  const returnsToAggressor = g.lastAggressor && nextId === g.lastAggressor;
  const closes = (returnsToAggressor && allMatched) || (g.lastAggressor === null && allActed && allMatched);

  if (closes) {
    closeStreet(g, false);
    return;
  }
  g.turn = nextId;
}

function closeStreet(g, skipToShowdown) {
  for (const id of g.order) { g.players[id]._acted = false; }
  if (skipToShowdown || g.street === "river") {
    g.round = "decide";
    g.turn = null;
    addLog(g.street === "river" ? "River betting complete. Showdown \u2014 host awards pot." : "Reveal remaining cards. Host awards pot.");
    return;
  }
  g.round = "wait_deal";
  g.turn = null;
  addLog(`${cap(g.street)} betting complete. Host: deal the ${STREETS[STREETS.indexOf(g.street)+1]}.`);
}
function cap(s){ return s ? s[0].toUpperCase()+s.slice(1) : s; }

function awardPot(g, winnerIds) {
  if (g.round !== "decide" && g.round !== "betting") return;
  const winners = winnerIds.filter(id => g.players[id] && !g.players[id].folded);
  if (!winners.length) return;
  const each = Math.floor(g.pot / winners.length);
  let remainder = g.pot - each * winners.length;
  for (const id of winners) {
    g.players[id].stack += each + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
  }
  const names = winners.map(id => g.players[id].name).join(" & ");
  addLog(`${names} win${winners.length > 1 ? "" : "s"} ${g.pot}.`);
  g.pot = 0;
  g.currentBet = 0;
  g.round = "idle";
  g.turn = null;
  for (const pid of g.order) { g.players[pid].bet = 0; g.players[pid].folded = false; g.players[pid].allIn = false; }
}

function viewFromGame(g) {
  return {
    hostId: g.hostId,
    sb: g.sb, bb: g.bb,
    order: g.order.slice(),
    players: JSON.parse(JSON.stringify(g.players)),
    dealerId: g.order[g.dealerIdx] || null,
    turn: g.turn,
    pot: g.pot,
    currentBet: g.currentBet,
    minRaise: g.minRaise,
    street: g.street,
    round: g.round,
  };
}

// ---------- UI ----------
function enterGame() {
  show("game");
  $("lobbyCode").textContent = S.lobbyCode;
  $("copyBtn").onclick = () => {
    const url = new URL(location.href);
    url.searchParams.set("join", S.lobbyCode);
    navigator.clipboard?.writeText(url.toString());
    setStatus("Invite link copied.");
  };
  $("leaveBtn").onclick = leaveLobby;

  if (S.role === "host") {
    $("hostControls").classList.remove("hidden");
    $("startHandBtn").onclick = () => { if (startHand(S.game)) broadcastState(); };
    $("nextRoundBtn").onclick = () => {
      if (S.game.round === "wait_deal") {
        if (dealNextStreet(S.game)) broadcastState();
      } else if (S.game.round === "betting") {
        closeStreet(S.game, false);
        broadcastState();
      }
    };
    $("resetHandBtn").onclick = () => {
      for (const id of S.game.order) {
        const p = S.game.players[id];
        p.stack += p.bet; p.bet = 0; p.folded = false; p.allIn = false;
      }
      S.game.pot = 0; S.game.currentBet = 0; S.game.round = "idle"; S.game.turn = null;
      addLog("Host cancelled the hand.");
      broadcastState();
    };
    $("sbInput").value = S.game.sb;
    $("bbInput").value = S.game.bb;
    $("saveBlindsBtn").onclick = () => {
      const sb = Math.max(0, parseInt($("sbInput").value, 10) || 0);
      const bb = Math.max(sb, parseInt($("bbInput").value, 10) || sb);
      S.game.sb = sb; S.game.bb = bb;
      addLog(`Blinds set to ${sb}/${bb}.`);
      broadcastState();
    };
    S.view = viewFromGame(S.game);
  }
}

function renderAll() {
  if (!S.view) return;
  const v = S.view;
  $("potAmount").textContent = v.pot;
  $("lobbyCode").textContent = S.lobbyCode;

  if (S.role === "host") {
    const startBtn = $("startHandBtn"), nextBtn = $("nextRoundBtn");
    if (v.round === "idle") {
      startBtn.textContent = "Deal new hand"; startBtn.disabled = false;
      nextBtn.textContent = "\u2014"; nextBtn.disabled = true;
    } else if (v.round === "betting") {
      startBtn.textContent = "Deal new hand"; startBtn.disabled = true;
      nextBtn.textContent = "Force end betting"; nextBtn.disabled = false;
    } else if (v.round === "wait_deal") {
      const next = STREETS[STREETS.indexOf(v.street) + 1];
      startBtn.textContent = "Deal new hand"; startBtn.disabled = true;
      nextBtn.textContent = "Deal " + next; nextBtn.disabled = false;
    } else if (v.round === "decide") {
      startBtn.textContent = "Deal new hand"; startBtn.disabled = true;
      nextBtn.textContent = "\u2014"; nextBtn.disabled = true;
    }
  }

  const pe = $("players");
  pe.innerHTML = "";
  for (const id of v.order) {
    const p = v.players[id];
    const isYou = id === S.myId;
    const isTurn = id === v.turn;
    const isDealer = id === v.dealerId;
    const isHost = id === v.hostId;
    const el = document.createElement("div");
    el.className = "player" + (isTurn ? " is-turn" : "") + (p.folded ? " folded" : "") + (p.disconnected ? " disconnected" : "") + (isYou ? " you" : "");
    el.innerHTML = `
      <div class="name">
        ${escapeHTML(p.name)}${isYou ? " <span class='tag'>you</span>" : ""}
        ${isHost ? "<span class='tag host'>host</span>" : ""}
        ${isDealer ? "<span class='tag dealer'>D</span>" : ""}
        ${isTurn ? "<span class='tag turn'>turn</span>" : ""}
        ${p.folded ? "<span class='tag folded'>folded</span>" : ""}
        ${p.allIn ? "<span class='tag allin'>all-in</span>" : ""}
      </div>
      <div class="stack">${p.stack}</div>
      <div class="bet"><span>${p.bet ? "bet" : ""}</span><span class="chip-amount">${p.bet || ""}</span></div>
    `;
    pe.appendChild(el);
  }

  const me = v.players[S.myId];
  const myTurn = me && v.turn === S.myId && v.round === "betting" && !me.folded && !me.allIn;
  $("youControls").classList.toggle("hidden", !myTurn);
  const ab = $("actionButtons");
  ab.innerHTML = "";
  if (myTurn) {
    const toCall = Math.max(0, v.currentBet - me.bet);
    const canCheck = toCall === 0;
    mkBtn(ab, "Fold", "fold", () => sendAction("fold"));
    if (canCheck) mkBtn(ab, "Check", "check", () => sendAction("check"));
    else mkBtn(ab, `Call ${Math.min(toCall, me.stack)}`, "call", () => sendAction("call"));
    const maxTo = me.bet + me.stack;
    const minTo = Math.min(maxTo, v.currentBet + v.minRaise);
    const slider = $("betSlider");
    slider.classList.remove("hidden");
    const range = $("betAmount"); const num = $("betAmountText");
    range.min = minTo; range.max = maxTo; range.value = minTo;
    num.min = minTo; num.max = maxTo; num.value = minTo;
    range.oninput = () => { num.value = range.value; };
    num.oninput = () => { range.value = num.value; };
    mkBtn(ab, canCheck ? "Bet" : "Raise", "raise", () => {
      const amt = parseInt(num.value, 10);
      sendAction("raise", amt);
    });
  } else {
    $("betSlider").classList.add("hidden");
  }

  if (S.role === "host") {
    $("hostControls").classList.remove("hidden");
    const panel = $("winnerPanel");
    panel.classList.toggle("hidden", !(v.round === "decide"));
    const wb = $("winnerButtons"); wb.innerHTML = "";
    const eligible = v.order.filter(id => !v.players[id].folded);
    const selected = new Set();
    for (const id of eligible) {
      const b = document.createElement("button");
      b.textContent = v.players[id].name;
      b.onclick = () => {
        if (selected.has(id)) { selected.delete(id); b.classList.remove("selected"); }
        else { selected.add(id); b.classList.add("selected"); }
      };
      wb.appendChild(b);
    }
    const awardBtn = document.createElement("button");
    awardBtn.textContent = `Award pot (${v.pot})`;
    awardBtn.onclick = () => {
      const picks = [...selected];
      if (!picks.length) { setStatus("Pick at least one winner.", true); return; }
      awardPot(S.game, picks);
      broadcastState();
    };
    wb.appendChild(awardBtn);
    $("splitBtn").onclick = () => {
      awardPot(S.game, eligible);
      broadcastState();
    };
  }

  if (v.round === "idle") setStatus("Waiting for host to deal a new hand.");
  else if (v.round === "wait_deal") {
    const next = STREETS[STREETS.indexOf(v.street) + 1];
    setStatus(`${cap(v.street)} betting done. Host: deal the ${next}.`);
  }
  else if (v.round === "decide") setStatus("Showdown \u2014 host awards the pot.");
  else if (myTurn) setStatus(`${cap(v.street)} \u2014 your move.`);
  else if (v.turn && v.players[v.turn]) setStatus(`${cap(v.street)} \u2014 ${v.players[v.turn].name}'s turn.`);
  else setStatus("");
}

function mkBtn(parent, text, cls, onclick) {
  const b = document.createElement("button");
  b.className = cls; b.textContent = text; b.onclick = onclick;
  parent.appendChild(b);
}

// ---------- Boot ----------
window.addEventListener("DOMContentLoaded", () => {
  $("playerName").value = loadName();
  $("createBtn").onclick = createLobby;
  $("joinBtn").onclick = joinLobby;

  const params = new URLSearchParams(location.search);
  const j = params.get("join");
  if (j) {
    $("joinCode").value = j.toUpperCase();
    document.querySelectorAll("details.block")[1]?.setAttribute("open", "");
  }
});
