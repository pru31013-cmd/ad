require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const PORT = process.env.PORT || 3000;
const IS_DEV = process.env.NODE_ENV !== 'production';

// DATABASE
const db = new Database('blackjack.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT UNIQUE,
    username TEXT,
    first_name TEXT,
    balance INTEGER DEFAULT 1000
  );
  CREATE TABLE IF NOT EXISTS tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    creator_telegram_id TEXT,
    password TEXT,
    start_chips INTEGER DEFAULT 100,
    status TEXT DEFAULT 'waiting',
    accumulated_pot INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id INTEGER,
    telegram_id TEXT,
    chips INTEGER,
    active INTEGER DEFAULT 1,
    UNIQUE(table_id, telegram_id)
  );
  CREATE TABLE IF NOT EXISTS hands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id INTEGER,
    pot INTEGER DEFAULT 0,
    bet_per_player INTEGER DEFAULT 0,
    status TEXT DEFAULT 'betting'
  );
  CREATE TABLE IF NOT EXISTS player_hands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hand_id INTEGER,
    player_id INTEGER,
    cards TEXT DEFAULT '[]',
    hand_value INTEGER DEFAULT 0,
    stood INTEGER DEFAULT 0,
    busted INTEGER DEFAULT 0
  );
`);

// WebSocket bağlantıları
const ws_clients = new Map();

function sendToUser(telegramId, payload) {
  const ws = ws_clients.get(String(telegramId));
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastToTable(tableId, payload, excludeIds = []) {
  const players = db.prepare('SELECT * FROM players WHERE table_id = ? AND active = 1').all(tableId);
  for (const p of players) {
    if (!excludeIds.includes(p.telegram_id)) sendToUser(p.telegram_id, payload);
  }
}

// Telegram initData doğrulama
function verifyInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (expectedHash !== hash) return null;

    const authDate = parseInt(params.get('auth_date') || '0');
    if (Date.now() / 1000 - authDate > 3600) return null;

    return JSON.parse(params.get('user') || 'null');
  } catch { return null; }
}

// DB helpers
const q = {
  getUser: tid => db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(tid)),
  getTable: id => db.prepare('SELECT * FROM tables WHERE id = ?').get(id),
  getTableByName: name => db.prepare('SELECT * FROM tables WHERE name = ?').get(name),
  getActivePlayers: tid => db.prepare('SELECT * FROM players WHERE table_id = ? AND active = 1').all(tid),
  getPlayerAt: (tableId, tid) => db.prepare('SELECT * FROM players WHERE table_id = ? AND telegram_id = ?').get(tableId, String(tid)),
  getCurrentHand: tableId => db.prepare("SELECT * FROM hands WHERE table_id = ? AND status != 'done' ORDER BY id DESC LIMIT 1").get(tableId),
  getPlayerHand: (handId, playerId) => db.prepare('SELECT * FROM player_hands WHERE hand_id = ? AND player_id = ?').get(handId, playerId),
  displayName: tid => {
    const u = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(tid));
    return u ? (u.username ? `@${u.username}` : u.first_name) : String(tid);
  },
  ensureUser: tgUser => {
    db.prepare('INSERT OR IGNORE INTO users (telegram_id, username, first_name) VALUES (?,?,?)')
      .run(String(tgUser.id), tgUser.username || '', tgUser.first_name || '');
    return q.getUser(tgUser.id);
  },
};

// Kart deste
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ suit: s, rank: r });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function calcValue(cards) {
  let val = 0, aces = 0;
  for (const c of cards) {
    if (['J', 'Q', 'K'].includes(c.rank)) val += 10;
    else if (c.rank === 'A') { val += 11; aces++; }
    else val += parseInt(c.rank);
  }
  while (val > 21 && aces > 0) { val -= 10; aces--; }
  return val;
}

// Oyun durumu
const gameState = {};

// State push
function pushTableState(tableId) {
  const table = q.getTable(tableId);
  if (!table) return;
  const players = q.getActivePlayers(tableId);
  const hand = q.getCurrentHand(tableId);
  const state = gameState[tableId] || {};

  for (const p of players) {
    const myPH = hand ? q.getPlayerHand(hand.id, p.id) : null;
    const myCards = myPH ? JSON.parse(myPH.cards) : [];

    const others = players
      .filter(op => op.telegram_id !== p.telegram_id)
      .map(op => {
        const oph = hand ? q.getPlayerHand(hand.id, op.id) : null;
        return {
          telegram_id: op.telegram_id,
          name: q.displayName(op.telegram_id),
          chips: op.chips,
          cardCount: oph ? JSON.parse(oph.cards).length : 0,
          stood: oph ? !!oph.stood : false,
        };
      });

    sendToUser(p.telegram_id, {
      type: 'STATE_UPDATE',
      data: {
        tableId,
        tableName: table.name,
        tableStatus: table.status,
        isCreator: table.creator_telegram_id === p.telegram_id,
        myChips: p.chips,
        myCards,
        myValue: myPH ? myPH.hand_value : 0,
        myBusted: myPH ? !!myPH.busted : false,
        myStood: myPH ? !!myPH.stood : false,
        pot: hand ? hand.pot : 0,
        accumulatedPot: table.accumulated_pot,
        handStatus: hand ? hand.status : null,
        others,
        isMyTurn: state.turnOrder ? state.turnOrder[state.currentTurnIndex] === p.telegram_id : false,
        currentTurnName: state.turnOrder ? q.displayName(state.turnOrder[state.currentTurnIndex]) : null,
        needsBet: hand?.status === 'betting' && state.bets ? !state.bets[p.telegram_id] : false,
      }
    });
  }
}

// OYUN FONKSİYONLARI
function startBettingPhase(tableId) {
  const table = q.getTable(tableId);
  const players = q.getActivePlayers(tableId);

  db.prepare("INSERT INTO hands (table_id, pot, bet_per_player, status) VALUES (?,?,?,'betting')")
    .run(tableId, table.accumulated_pot || 0, 0);
  db.prepare('UPDATE tables SET accumulated_pot = 0 WHERE id = ?').run(tableId);

  const hand = q.getCurrentHand(tableId);
  if (!gameState[tableId]) gameState[tableId] = {};
  gameState[tableId].bets = {};
  gameState[tableId].handId = hand.id;

  broadcastToTable(tableId, { type: 'NOTIFY', message: '💰 Bahis zamanı! (min 10 chip, 60sn)' });
  pushTableState(tableId);

  gameState[tableId].betTimer = setTimeout(() => {
    const state = gameState[tableId];
    if (!state?.bets) return;
    for (const p of q.getActivePlayers(tableId)) {
      if (!state.bets[p.telegram_id]) {
        state.bets[p.telegram_id] = Math.min(10, p.chips);
      }
    }
    checkAllBetsIn(tableId);
  }, 60000);
}

function placeBet(tableId, tid, amount) {
  const player = q.getPlayerAt(tableId, tid);
  if (!player) return { error: 'Masada değilsin' };
  const hand = q.getCurrentHand(tableId);
  if (!hand || hand.status !== 'betting') return { error: 'Bahis fazı değil' };
  if (amount < 10) return { error: 'Minimum bahis 10 chip' };
  if (amount > player.chips) return { error: 'Yetersiz chip' };
  const state = gameState[tableId];
  if (state?.bets?.[tid]) return { error: 'Zaten bahis yaptın' };

  state.bets[tid] = amount;
  broadcastToTable(tableId, { type: 'NOTIFY', message: `💰 ${q.displayName(tid)} bahsini yaptı.` }, [tid]);
  sendToUser(tid, { type: 'NOTIFY', message: `✅ Bahsin: ${amount} chip` });
  pushTableState(tableId);
  checkAllBetsIn(tableId);
  return { ok: true };
}

function checkAllBetsIn(tableId) {
  const state = gameState[tableId];
  const players = q.getActivePlayers(tableId);
  if (!players.every(p => state.bets[p.telegram_id])) return;

  if (state.betTimer) { clearTimeout(state.betTimer); state.betTimer = null; }

  const minBet = Math.min(...players.map(p => state.bets[p.telegram_id]));
  const hand = q.getCurrentHand(tableId);
  let totalPot = hand.pot;

  for (const p of players) {
    db.prepare('UPDATE players SET chips = chips - ? WHERE id = ?').run(minBet, p.id);
    totalPot += minBet;
  }

  db.prepare("UPDATE hands SET pot = ?, bet_per_player = ?, status = 'dealing' WHERE id = ?")
    .run(totalPot, minBet, hand.id);

  broadcastToTable(tableId, { type: 'NOTIFY', message: `✅ Bahisler tamam! Toplam pot: ${totalPot} chip` });
  setTimeout(() => dealCards(tableId), 800);
}

function dealCards(tableId) {
  const state = gameState[tableId];
  const players = q.getActivePlayers(tableId);
  const hand = q.getCurrentHand(tableId);
  const deck = newDeck();
  state.deck = deck;
  state.turnOrder = players.map(p => p.telegram_id);
  state.currentTurnIndex = 0;

  for (const p of players) {
    const cards = [deck.pop(), deck.pop()];
    const value = calcValue(cards);
    const bust = value > 21;
    db.prepare('INSERT INTO player_hands (hand_id, player_id, cards, hand_value, stood, busted) VALUES (?,?,?,?,0,?)')
      .run(hand.id, p.id, JSON.stringify(cards), value, bust ? 1 : 0);
  }

  db.prepare("UPDATE hands SET status = 'playing' WHERE id = ?").run(hand.id);
  broadcastToTable(tableId, { type: 'NOTIFY', message: '🃏 Kartlar dağıtıldı!' });
  pushTableState(tableId);
  scheduleNextTurn(tableId);
}

function scheduleNextTurn(tableId) {
  const state = gameState[tableId];
  if (!state) return;
  if (state.turnTimer) { clearTimeout(state.turnTimer); state.turnTimer = null; }

  const hand = q.getCurrentHand(tableId);
  if (!hand) return;

  while (state.currentTurnIndex < state.turnOrder.length) {
    const tid = state.turnOrder[state.currentTurnIndex];
    const player = q.getPlayerAt(tableId, tid);
    if (!player) { state.currentTurnIndex++; continue; }
    const ph = q.getPlayerHand(hand.id, player.id);
    if (!ph || ph.stood) { state.currentTurnIndex++; continue; }
    break;
  }

  if (state.currentTurnIndex >= state.turnOrder.length) {
    return resolveHand(tableId);
  }

  const currentTid = state.turnOrder[state.currentTurnIndex];
  broadcastToTable(tableId, {
    type: 'NOTIFY',
    message: `⏳ ${q.displayName(currentTid)} sırası! (15 saniye)`
  });
  pushTableState(tableId);

  state.turnTimer = setTimeout(() => {
    const s = gameState[tableId];
    if (!s || s.turnOrder[s.currentTurnIndex] !== currentTid) return;
    sendToUser(currentTid, { type: 'NOTIFY', message: '⏰ Süre doldu! Otomatik STAND.' });
    performStand(tableId, currentTid);
  }, 15000);
}

function performHit(tableId, tid) {
  const state = gameState[tableId];
  if (!state || state.turnOrder[state.currentTurnIndex] !== tid) return { error: 'Sıra sende değil' };

  const hand = q.getCurrentHand(tableId);
  const player = q.getPlayerAt(tableId, tid);
  const ph = q.getPlayerHand(hand.id, player.id);
  if (ph.busted) return { error: 'Patladın, kart çekamazsın' };

  if (state.turnTimer) { clearTimeout(state.turnTimer); state.turnTimer = null; }

  const card = state.deck.pop();
  const cards = [...JSON.parse(ph.cards), card];
  const value = calcValue(cards);
  const bust = value > 21;

  db.prepare('UPDATE player_hands SET cards = ?, hand_value = ?, busted = ? WHERE id = ?')
    .run(JSON.stringify(cards), value, bust ? 1 : 0, ph.id);

  pushTableState(tableId);

  if (bust) {
    db.prepare('UPDATE player_hands SET stood = 1 WHERE id = ?').run(ph.id);
    state.currentTurnIndex++;
    setTimeout(() => scheduleNextTurn(tableId), 400);
  } else {
    state.turnTimer = setTimeout(() => {
      const s = gameState[tableId];
      if (!s || s.turnOrder[s.currentTurnIndex] !== tid) return;
      performStand(tableId, tid);
    }, 15000);
  }

  return { ok: true, card, value, busted: bust };
}

function performStand(tableId, tid) {
  const state = gameState[tableId];
  if (!state || state.turnOrder[state.currentTurnIndex] !== tid) return { error: 'Sıra sende değil' };

  if (state.turnTimer) { clearTimeout(state.turnTimer); state.turnTimer = null; }

  const hand = q.getCurrentHand(tableId);
  const player = q.getPlayerAt(tableId, tid);
  const ph = q.getPlayerHand(hand.id, player.id);
  db.prepare('UPDATE player_hands SET stood = 1 WHERE id = ?').run(ph.id);

  broadcastToTable(tableId, { type: 'NOTIFY', message: `✋ ${q.displayName(tid)} STAND yaptı.` });
  state.currentTurnIndex++;
  setTimeout(() => scheduleNextTurn(tableId), 400);
  return { ok: true };
}

function resolveHand(tableId) {
  const hand = q.getCurrentHand(tableId);
  if (!hand) return;
  db.prepare("UPDATE hands SET status = 'done' WHERE id = ?").run(hand.id);

  const players = q.getActivePlayers(tableId);
  const playerHands = players.map(p => {
    const ph = q.getPlayerHand(hand.id, p.id);
    return { player: p, cards: JSON.parse(ph?.cards || '[]'), value: ph?.hand_value || 0, busted: !!ph?.busted };
  });

  const alive = playerHands.filter(x => !x.busted);
  let winners = [];
  let resultMsg = '';

  if (alive.length === 0) {
    const table = q.getTable(tableId);
    const newAccum = (table.accumulated_pot || 0) + hand.pot;
    db.prepare('UPDATE tables SET accumulated_pot = ? WHERE id = ?').run(newAccum, tableId);
    resultMsg = `💥 Herkes patladı! Pot birikti → toplam ${newAccum} chip`;
  } else {
    const maxVal = Math.max(...alive.map(x => x.value));
    winners = alive.filter(x => x.value === maxVal);
    const share = Math.floor(hand.pot / winners.length);
    for (const { player } of winners) {
      db.prepare('UPDATE players SET chips = chips + ? WHERE id = ?').run(share, player.id);
    }
    resultMsg = winners.length === 1
      ? `🏆 ${q.displayName(winners[0].player.telegram_id)} kazandı! +${share} chip`
      : `🤝 Beraberlik! ${winners.map(w => q.displayName(w.player.telegram_id)).join(' & ')} (+${share} chip)`;
  }

  broadcastToTable(tableId, {
    type: 'HAND_RESULT',
    message: resultMsg,
    playerHands: playerHands.map(ph => ({
      name: q.displayName(ph.player.telegram_id),
      cards: ph.cards,
      value: ph.value,
      busted: ph.busted,
      winner: winners.some(w => w.player.telegram_id === ph.player.telegram_id),
    }))
  });

  for (const { player } of playerHands) {
    const updated = q.getPlayerAt(tableId, player.telegram_id);
    if (updated && updated.chips <= 0) {
      db.prepare('UPDATE players SET active = 0 WHERE id = ?').run(updated.id);
      sendToUser(updated.telegram_id, { type: 'KICKED', message: '💸 Chip\'in bitti, masadan atıldın!' });
    }
  }

  setTimeout(() => askContinue(tableId), 2500);
}

function askContinue(tableId) {
  const remaining = q.getActivePlayers(tableId);
  if (remaining.length < 2) return endGame(tableId);

  if (!gameState[tableId]) gameState[tableId] = {};
  gameState[tableId].continueVotes = {};

  broadcastToTable(tableId, { type: 'ASK_CONTINUE' });

  gameState[tableId].continueTimer = setTimeout(() => {
    const state = gameState[tableId];
    if (!state?.continueVotes) return;
    for (const p of q.getActivePlayers(tableId)) {
      if (!state.continueVotes[p.telegram_id]) state.continueVotes[p.telegram_id] = 'continue';
    }
    resolveContinue(tableId);
  }, 30000);
}

function voteContinue(tableId, tid, vote) {
  const state = gameState[tableId];
  if (!state?.continueVotes) return { error: 'Oy fazı yok' };
  state.continueVotes[tid] = vote;
  resolveContinue(tableId);
  return { ok: true };
}

function resolveContinue(tableId) {
  const state = gameState[tableId];
  const players = q.getActivePlayers(tableId);
  if (!players.every(p => state.continueVotes[p.telegram_id])) return;

  if (state.continueTimer) { clearTimeout(state.continueTimer); state.continueTimer = null; }

  for (const p of players) {
    if (state.continueVotes[p.telegram_id] === 'leave') {
      db.prepare('UPDATE players SET active = 0 WHERE id = ?').run(p.id);
      sendToUser(p.telegram_id, { type: 'LEFT_TABLE' });
      broadcastToTable(tableId, { type: 'NOTIFY', message: `👋 ${q.displayName(p.telegram_id)} ayrıldı.` }, [p.telegram_id]);
    }
  }
  delete state.continueVotes;

  const remaining = q.getActivePlayers(tableId);
  if (remaining.length < 2) endGame(tableId);
  else startBettingPhase(tableId);
}

function endGame(tableId) {
  const players = db.prepare('SELECT * FROM players WHERE table_id = ?').all(tableId);
  for (const p of players) {
    if (p.chips > 0) db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(p.chips, p.telegram_id);
  }
  broadcastToTable(tableId, { type: 'GAME_ENDED', message: '🏁 Oyun bitti!' });
  db.prepare('DELETE FROM players WHERE table_id = ?').run(tableId);
  db.prepare('DELETE FROM tables WHERE id = ?').run(tableId);
  delete gameState[tableId];
}

// MIDDLEWARE
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // public klasörünü serve et

// Auth middleware
function authMiddleware(req, res, next) {
  if (IS_DEV && req.headers['x-dev-user-id']) {
    const tgUser = {
      id: parseInt(req.headers['x-dev-user-id']),
      first_name: req.headers['x-dev-name'] || 'DevUser',
      username: req.headers['x-dev-username'] || 'devuser',
    };
    q.ensureUser(tgUser);
    req.tgUser = tgUser;
    return next();
  }

  const initData = req.headers['x-telegram-init-data'];
  if (!initData) return res.status(401).json({ error: 'initData eksik' });

  const user = verifyInitData(initData);
  if (!user) return res.status(403).json({ error: 'Geçersiz initData' });

  q.ensureUser(user);
  req.tgUser = user;
  next();
}

app.use('/api', authMiddleware);

// API ENDPOINTS
app.get('/api/me', (req, res) => {
  res.json({ user: q.getUser(req.tgUser.id) });
});

app.get('/api/tables', (req, res) => {
  const tables = db.prepare(`
    SELECT t.*, COUNT(p.id) as player_count
    FROM tables t
    LEFT JOIN players p ON t.id = p.table_id AND p.active = 1
    WHERE t.status != 'ended'
    GROUP BY t.id
  `).all().map(t => ({ ...t, password: !!t.password }));
  res.json({ tables });
});

app.post('/api/tables', (req, res) => {
  const { name, start_chips, password } = req.body;
  const tid = String(req.tgUser.id);
  const user = q.getUser(tid);

  if (!name?.trim() || name.trim().length < 2) return res.status(400).json({ error: 'Geçersiz masa adı' });
  if (!start_chips || start_chips < 10) return res.status(400).json({ error: 'Min 10 chip' });
  if (user.balance < start_chips) return res.status(400).json({ error: 'Yetersiz bakiye' });
  if (q.getTableByName(name.trim())) return res.status(400).json({ error: 'Bu isimde masa zaten var' });

  try {
    db.prepare('INSERT INTO tables (name, creator_telegram_id, password, start_chips) VALUES (?,?,?,?)')
      .run(name.trim(), tid, password || null, start_chips);
    const table = q.getTableByName(name.trim());
    db.prepare('UPDATE users SET balance = balance - ? WHERE telegram_id = ?').run(start_chips, tid);
    db.prepare('INSERT INTO players (table_id, telegram_id, chips) VALUES (?,?,?)').run(table.id, tid, start_chips);
    res.json({ table });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tables/:id/join', (req, res) => {
  const tableId = parseInt(req.params.id);
  const tid = String(req.tgUser.id);
  const { password } = req.body;
  const table = q.getTable(tableId);

  if (!table) return res.status(404).json({ error: 'Masa bulunamadı' });
  if (table.status === 'playing') return res.status(400).json({ error: 'Oyun başladı, giremezsin' });
  if (q.getActivePlayers(tableId).length >= 8) return res.status(400).json({ error: 'Masa dolu' });
  if (table.password && table.password !== password) return res.status(403).json({ error: 'Yanlış şifre' });
  if (q.getPlayerAt(tableId, tid)?.active) return res.status(400).json({ error: 'Zaten masadasın' });

  const user = q.getUser(tid);
  if (user.balance < table.start_chips) return res.status(400).json({ error: 'Yetersiz bakiye' });

  db.prepare('UPDATE users SET balance = balance - ? WHERE telegram_id = ?').run(table.start_chips, tid);
  db.prepare('INSERT OR REPLACE INTO players (table_id, telegram_id, chips, active) VALUES (?,?,?,1)')
    .run(tableId, tid, table.start_chips);

  broadcastToTable(tableId, { type: 'NOTIFY', message: `👤 ${q.displayName(tid)} masaya katıldı!` }, [tid]);
  pushTableState(tableId);
  res.json({ ok: true, chips: table.start_chips });
});

app.post('/api/tables/:id/leave', (req, res) => {
  const tableId = parseInt(req.params.id);
  const tid = String(req.tgUser.id);
  const player = q.getPlayerAt(tableId, tid);
  if (!player?.active) return res.status(400).json({ error: 'Masada değilsin' });

  db.prepare('UPDATE players SET active = 0 WHERE id = ?').run(player.id);

  const table = q.getTable(tableId);
  if (table?.creator_telegram_id === tid) {
    const remaining = q.getActivePlayers(tableId);
    if (remaining.length > 0) {
      db.prepare('UPDATE tables SET creator_telegram_id = ? WHERE id = ?').run(remaining[0].telegram_id, tableId);
      broadcastToTable(tableId, { type: 'NOTIFY', message: `👑 Yeni kurucu: ${q.displayName(remaining[0].telegram_id)}` });
    }
  }

  broadcastToTable(tableId, { type: 'NOTIFY', message: `👋 ${q.displayName(tid)} ayrıldı.` });
  pushTableState(tableId);
  res.json({ ok: true });
});

app.post('/api/tables/:id/start', (req, res) => {
  const tableId = parseInt(req.params.id);
  const tid = String(req.tgUser.id);
  const table = q.getTable(tableId);

  if (!table) return res.status(404).json({ error: 'Masa yok' });
  if (table.creator_telegram_id !== tid) return res.status(403).json({ error: 'Sadece kurucu başlatabilir' });
  if (table.status === 'playing') return res.status(400).json({ error: 'Oyun zaten başladı' });
  if (q.getActivePlayers(tableId).length < 2) return res.status(400).json({ error: 'Min 2 oyuncu gerekli' });

  db.prepare("UPDATE tables SET status = 'playing' WHERE id = ?").run(tableId);
  broadcastToTable(tableId, { type: 'NOTIFY', message: '🎮 Oyun başladı!' });
  startBettingPhase(tableId);
  res.json({ ok: true });
});

app.post('/api/tables/:id/bet', (req, res) => {
  const tableId = parseInt(req.params.id);
  const tid = String(req.tgUser.id);
  res.json(placeBet(tableId, tid, parseInt(req.body.amount)));
});

app.post('/api/tables/:id/hit', (req, res) => {
  const tableId = parseInt(req.params.id);
  const tid = String(req.tgUser.id);
  res.json(performHit(tableId, tid));
});

app.post('/api/tables/:id/stand', (req, res) => {
  const tableId = parseInt(req.params.id);
  const tid = String(req.tgUser.id);
  res.json(performStand(tableId, tid));
});

app.post('/api/tables/:id/continue', (req, res) => {
  const tableId = parseInt(req.params.id);
  const tid = String(req.tgUser.id);
  res.json(voteContinue(tableId, tid, req.body.vote));
});

// SINGLE PAGE APP YÖNLENDİRME (BUNU EKLE!)
app.get('*', (req, res) => {
  if (req.url.startsWith('/api/')) return;
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WEBSOCKET
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const initData = url.searchParams.get('initData');
  const devId = url.searchParams.get('devUserId');

  let tgUser = null;
  if (IS_DEV && devId) {
    tgUser = { id: parseInt(devId), first_name: 'DevUser', username: 'devuser' };
    q.ensureUser(tgUser);
  } else {
    tgUser = verifyInitData(initData);
    if (!tgUser) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Kimlik doğrulaması başarısız' }));
      return ws.close();
    }
    q.ensureUser(tgUser);
  }

  const tid = String(tgUser.id);
  ws_clients.set(tid, ws);
  ws.send(JSON.stringify({ type: 'CONNECTED', userId: tid }));

  const active = db.prepare('SELECT * FROM players WHERE telegram_id = ? AND active = 1').get(tid);
  if (active) setTimeout(() => pushTableState(active.table_id), 100);

  ws.on('close', () => {
    ws_clients.delete(tid);

    const player = db.prepare('SELECT * FROM players WHERE telegram_id = ? AND active = 1').get(tid);
    if (!player) return;

    const tableId = player.table_id;
    const state = gameState[tableId];
    if (state?.turnOrder?.[state.currentTurnIndex] === tid) {
      if (state.turnTimer) { clearTimeout(state.turnTimer); state.turnTimer = null; }
      const hand = q.getCurrentHand(tableId);
      if (hand) {
        const ph = q.getPlayerHand(hand.id, player.id);
        if (ph) db.prepare('UPDATE player_hands SET stood = 1, busted = 1 WHERE id = ?').run(ph.id);
      }
      state.currentTurnIndex++;
      broadcastToTable(tableId, { type: 'NOTIFY', message: `🔌 ${q.displayName(tid)} bağlantısı kesildi, eli kaybetti.` });
      scheduleNextTurn(tableId);
    }
  });
});

// SERVER BAŞLAT
server.listen(PORT, () => {
  console.log(`🃏 Blackjack server → http://localhost:${PORT}`);
  console.log(`📡 WebSocket → ws://localhost:${PORT}`);
  if (IS_DEV) console.log(`🛠 Dev modu: initData bypass aktif`);
});