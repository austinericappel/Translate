// Poker Chips - PeerJS-based lobby. Host is authoritative.
// Real cards at the table; this app tracks stacks, bets, turn order, dealer,
// and lets the host award pots.

const $ = (id) => document.getElementById(id);
const LOG_MAX = 40;

// ---------- State ----------
const S = {
  role: null,          // "host" | "client"
  peer: null,          // PeerJS instance
  myId: null,          // my peer id
  myName: "",
  lobbyCode: "",       // for host: myId; for client: host's id
  hostConn: null,      // client -> host DataConnection
  clientConns: {},     // host: { peerId: DataConnection }
  game: null,          // authoritative state (host only); clients get snapshots
  view: null,          // latest view for clients
  log: [],
};

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

// ---------- PeerJS bootstrap ----------
function initPeer(id) {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id) : new Peer();
    let done = false;
    peer.on("open", (pid) => { if (!done) { done = true; resolve(peer); } });
    peer.on("error", (err) => {
      if (!done) { done = true; reject(err); }
      else console.warn("PeerJS error:", err.type, err.message);
    });
  });
}

// ---------- HOST ----------
async function createLobby() {
  const name = ($("playerName").value || "").trim() || "Host";
  saveName(name);
  const startStack = Math.max(1, parseInt($("startStack").value, 10) || 1000);
  const sb = Math.max(0, parseInt($("smallBlind").value, 10) || 5);
  const bb = Math.max(sb, parseInt($("bigBlind").value, 10) || 10);

  setStatus("Connecting…");
  try {
    const code = "POKER-" + rid(5);
    S.peer = await initPeer(code);
  } catch (e) {
    setStatus("Couldn't connect. Try again. " + (e.message || ""), true);
    return;
  }
  S.role = "host";
  S.myId = S.peer.id;
  S.lobbyCode = S.peer.id;
  S.myName = name;

  S.game = newGame({ startStack, sb, bb });
  addPlayer(S.game, S.myId, name);

  S.peer.on("connection", (conn) => {
    conn.on("open", () => {
      S.clientConns[conn.peer] = conn;
      conn.on("data", (msg) => handleHostMessage(conn, msg));
      conn.on("close", () => {
        delete S.clientConns[conn.peer];
        markDisconnected(S.game, conn.peer, true);
        broadcastState();
      });
      conn.on("error", () => {
        delete S.clientConns[conn.peer];
        markDisconnected(S.game, conn.peer, true);
        broadcastState();
      });
    });
  });

  addLog(`Lobby created. Code: ${displayCode(S.lobbyCode)}`);
  enterGame();
  renderAll();
}

function displayCode(peerId) {
  // Strip "POKER-" prefix for short display
  return peerId.startsWith("POKER-") ? peerId.slice(6) : peerId;
}
function codeToPeerId(code) {
  const c = (code || "").trim().toUpperCase();
  if (!c) return "";
  return c.startsWith("POKER-") ? c : "POKER-" + c;
}

function handleHostMessage(conn, msg) {
  if (!msg || !msg.type) return;
  const playerId = conn.peer;
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
      // { kind: "check"|"call"|"fold"|"raise", amount? }
      if (playerId !== S.game.turn) return;
      applyAction(S.game, playerId, msg.kind, msg.amount);
      broadcastState();
      break;
    }
  }
}

function broadcastState() {
  const view = viewFromGame(S.game);
  S.view = view;
  for (const id in S.clientConns) {
    try { S.clientConns[id].send({ type: "state", view }); } catch (_) {}
  }
  renderAll();
}

// ---------- CLIENT ----------
async function joinLobby() {
  const name = ($("playerName").value || "").trim();
  if (!name) return setStatus("Enter your name first.", true);
  const raw = $("joinCode").value || "";
  const hostId = codeToPeerId(raw);
  if (!hostId) return setStatus("Enter a lobby code.", true);

  saveName(name);
  setStatus("Connecting…");
  try {
    S.peer = await initPeer();
  } catch (e) {
    setStatus("Couldn't connect. " + (e.message || ""), true);
    return;
  }
  S.role = "client";
  S.myId = S.peer.id;
  S.myName = name;
  S.lobbyCode = hostId;

  const conn = S.peer.connect(hostId, { reliable: true });
  S.hostConn = conn;

  const opened = new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("Couldn't reach host")), 10000);
    conn.on("open", () => { clearTimeout(to); res(); });
    conn.on("error", (e) => { clearTimeout(to); rej(e); });
  });
  try {
    await opened;
  } catch (e) {
    setStatus("Join failed: " + (e.message || "timeout"), true);
    try { S.peer.destroy(); } catch (_) {}
    return;
  }

  conn.send({ type: "join", name });
  conn.on("data", (msg) => {
    if (msg && msg.type === "state") {
      S.view = msg.view;
      renderAll();
    }
  });
  conn.on("close", () => { setStatus("Disconnected from host.", true); });

  enterGame();
}

function sendAction(kind, amount) {
  if (S.role === "host") {
    applyAction(S.game, S.myId, kind, amount);
    broadcastState();
  } else if (S.hostConn && S.hostConn.open) {
    S.hostConn.send({ type: "action", kind, amount });
  }
}

// ---------- Game model ----------
function newGame({ startStack, sb, bb }) {
  return {
    hostId: null,
    startStack, sb, bb,
    order: [],               // seat order of player ids
    players: {},             // id -> { id, name, stack, bet, folded, allIn, disconnected }
    dealerIdx: 0,            // index into order (of dealer)
    turn: null,              // id whose action it is
    pot: 0,
    currentBet: 0,           // highest bet in current round
    minRaise: 0,             // min legal raise delta
    lastAggressor: null,     // id of last raiser (to stop betting round)
    round: "idle",           // "idle" | "betting" | "decide"
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
  postBlind(g, g.order[sbIdx], g.sb);
  postBlind(g, g.order[bbIdx], g.bb);
  g.pot = g.sb + g.bb;
  g.currentBet = g.bb;
  g.minRaise = g.bb;
  g.lastAggressor = g.order[bbIdx]; // initial live "last aggressor" = BB
  const firstToAct = seatedIdxs.length === 2 ? g.order[g.dealerIdx] : g.order[nextSeatIdx(g, bbIdx)];
  g.turn = firstToAct;
  g.round = "betting";
  addLog(`New hand. Dealer: ${g.players[g.order[g.dealerIdx]].name}. SB ${g.sb} / BB ${g.bb}.`);
  return true;
}
function postBlind(g, id, amt) {
  const p = g.players[id]; if (!p) return;
  const pay = Math.min(amt, p.stack);
  p.stack -= pay; p.bet = pay;
  if (p.stack === 0) p.allIn = true;
}
function nextSeatIdx(g, fromIdx) {
  const n = g.order.length;
  for (let step = 1; step <= n; step++) {
    const i = (fromIdx + step) % n;
    const p = g.players[g.order[i]];
    if (!p.folded && !p.allIn && p.stack > 0 && !p.disconnected) return i;
    if (!p.folded && !p.allIn && p.stack >= 0) return i; // fallback
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

  // End conditions
  const active = g.order.filter(i => !g.players[i].folded);
  if (active.length === 1) {
    const winner = g.players[active[0]];
    winner.stack += g.pot;
    addLog(`${winner.name} wins ${g.pot} (everyone else folded).`);
    g.pot = 0; g.currentBet = 0; g.round = "idle"; g.turn = null; g.lastAggressor = null;
    for (const pid of g.order) { g.players[pid].bet = 0; }
    return;
  }

  // Advance turn
  const idx = g.order.indexOf(id);
  const nextIdx = nextSeatIdx(g, idx);
  const nextId = g.order[nextIdx];

  // Betting round closes when action returns to last aggressor and all active players
  // have matched currentBet, OR everyone remaining is all-in.
  const liveCanAct = g.order.filter(i => !g.players[i].folded && !g.players[i].allIn);
  const allMatched = liveCanAct.every(i => g.players[i].bet === g.currentBet);
  const returnsToAggressor = nextId === g.lastAggressor;

  if (liveCanAct.length <= 1 && active.length >= 2) {
    // No more decisions possible → go to decide
    g.round = "decide";
    g.turn = null;
    addLog("All-in / no further action. Host, resolve the pot.");
    return;
  }
  if (returnsToAggressor && allMatched) {
    // Round complete. This app plays a single betting round per "hand" — host awards pot at showdown.
    g.round = "decide";
    g.turn = null;
    addLog("Betting round complete. Host, award the pot.");
    return;
  }
  g.turn = nextId;
}

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
    round: g.round,
  };
}

// ---------- UI ----------
function enterGame() {
  show("game");
  $("lobbyCode").textContent = displayCode(S.lobbyCode);
  $("copyBtn").onclick = () => {
    const url = new URL(location.href);
    url.searchParams.set("join", displayCode(S.lobbyCode));
    navigator.clipboard?.writeText(url.toString());
    setStatus("Invite link copied.");
  };
  $("leaveBtn").onclick = () => location.reload();

  if (S.role === "host") {
    $("hostControls").classList.remove("hidden");
    $("startHandBtn").onclick = () => { if (startHand(S.game)) broadcastState(); };
    $("nextRoundBtn").onclick = () => {
      if (S.game.round === "betting") {
        // Host forces round close (e.g., everyone checked around)
        S.game.round = "decide"; S.game.turn = null; addLog("Host ended the betting round.");
        broadcastState();
      }
    };
    $("resetHandBtn").onclick = () => {
      // Cancel hand: return bets to stacks, clear pot
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
  $("lobbyCode").textContent = displayCode(S.lobbyCode);

  // Players
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

  // Your controls
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

  // Host winner panel
  if (S.role === "host") {
    const showWinner = v.round === "decide" || v.round === "betting";
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
      const picks = eligible;
      awardPot(S.game, picks);
      broadcastState();
    };
  }

  // Status line
  if (v.round === "idle") setStatus("Waiting for host to start the hand.");
  else if (v.round === "decide") setStatus("Showdown — host awards the pot.");
  else if (myTurn) setStatus("Your move.");
  else if (v.turn) setStatus(`${v.players[v.turn].name}'s turn.`);
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

  // Auto-fill join code from URL
  const params = new URLSearchParams(location.search);
  const j = params.get("join");
  if (j) {
    $("joinCode").value = j.toUpperCase();
    document.querySelectorAll("details.block")[1]?.setAttribute("open", "");
  }
});
