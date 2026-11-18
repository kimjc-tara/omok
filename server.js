import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import { newGame, placeStone } from './game.js';
import { findProfile } from './public/profiles.js';
import { ANTE, STARTING_CHIPS, newSeotdaGame, dealSeotda, seotdaAction, foldSeotda, seotdaView } from './seotda.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/avatars.js', ['avatars.js', 'text/javascript; charset=utf-8']],
  ['/profiles.js', ['profiles.js', 'text/javascript; charset=utf-8']],
  ['/game-messages.js', ['game-messages.js', 'text/javascript; charset=utf-8']],
  ['/seotda.js', ['seotda-app.js', 'text/javascript; charset=utf-8']],
  ['/seotda.css', ['seotda.css', 'text/css; charset=utf-8']],
  ['/seotda-ranks.js', ['seotda-ranks.js', 'text/javascript; charset=utf-8']],
  ['/session-navigation.js', ['session-navigation.js', 'text/javascript; charset=utf-8']],
  ['/assets/avatars/juchan.png', ['assets/avatars/juchan.png', 'image/png']],
  ['/assets/avatars/gyeonghu.png', ['assets/avatars/gyeonghu.png', 'image/png']],
  ['/assets/avatars/ganghui.png', ['assets/avatars/ganghui.png', 'image/png']],
  ['/assets/avatars/yonghwan.png', ['assets/avatars/yonghwan.png', 'image/png']],
  ['/assets/avatars/donghyeon.png', ['assets/avatars/donghyeon.png', 'image/png']],
  ['/assets/avatars/jiwon.png', ['assets/avatars/jiwon.png', 'image/png']],
  ['/assets/avatars/minseo.png', ['assets/avatars/minseo.png', 'image/png']],
]);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFILL_PHRASES = [
  '쌿쁄뚫핿',
  '뛣쀍홣쐛',
  '꿻쓣뾹훑',
  '뺣쫎꿇쀏',
  '똟쐚흙쫳',
  '쀍꿻뛟쓿',
  '홣뺢쫞뚫',
  '나는 개호구다',
  '나는 오늘 똥 먹는다',
  '김주찬 진짜 멋있어',
  '김주찬 진짜 귀여워',
];
const INSUFFICIENT_CHIPS = '님은 잔고 충전부터 하고오셔야 할듯ㅎㅎ';

function cleanText(value, fallback, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max) || fallback
    : fallback;
}

export function createGameServer({ disconnectGraceMs = 30_000, idleRoomMs = 30 * 60_000, maxRooms = 200, maxSessions = 1000, seotdaNextRoundMs = 2000, seotdaShowdownMs = 1500 } = {}) {
  const rooms = new Map();
  const sessions = new Map();
  let closing = false;
  const httpServer = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? '' : JSON.stringify({ ok: true }));
      }
      const isPage = /^\/(home|omok|profile|lobby)\/?$/.test(pathname) || /^\/game\/[A-Z2-9]{6}\/?$/.test(pathname);
      const isSeotda = /^\/seotda(?:\/game\/[A-Z2-9]{6})?\/?$/.test(pathname);
      const asset = isSeotda ? ['seotda.html', 'text/html; charset=utf-8'] : isPage ? assets.get('/') : assets.get(pathname);
      if (!asset) { res.writeHead(404); return res.end('Not found'); }
      const data = await readFile(new URL(`./public/${asset[0]}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(500);
      res.end('Server error');
    }
  });
  const io = new Server(httpServer, {
    maxHttpBufferSize: 8192,
    // Browser connections must originate from this host, including WebSocket upgrades.
    allowRequest: (req, callback) => {
      try { callback(null, !req.headers.origin || new URL(req.headers.origin).host === req.headers.host); }
      catch { callback(null, false); }
    },
  });

  const connected = (token) => Boolean(sessions.get(token)?.socketId);
  const publicPlayer = (seat) => {
    const session = sessions.get(seat.token);
    return {
      id: session.id, ...session.profile, color: seat.color,
      connected: connected(seat.token), reconnectDeadline: session.reconnectDeadline,
    };
  };
  const roomState = (room, viewer) => ({
    code: room.code, title: room.title, visibility: room.visibility, type: room.type,
    hostId: sessions.get(room.players[0]?.token)?.id,
    maxPlayers: room.type === 'seotda' ? 4 : 2,
    autoNext: room.autoNext, nextRoundAt: room.nextRoundAt ?? null,
    startRequired: room.startRequired,
    canStart: room.type === 'seotda' ? canStartSeotda(room, viewer) : undefined,
    wallet: room.type === 'seotda' ? sessions.get(viewer)?.seotdaWallet : undefined,
    players: room.players.map((seat) => ({ ...publicPlayer(seat), chips: seat.chips })),
    game: room.type === 'seotda' ? seotdaView(room.game, room.players.find((p) => p.token === viewer)?.color) : room.game,
    rematch: [...room.rematch].map((token) => sessions.get(token)?.id).filter(Boolean),
  });
  const lobbyState = () => [...rooms.values()]
    .filter((room) => room.visibility === 'public' && room.players.length < (room.type === 'seotda' ? 4 : 2) && (room.type === 'seotda' || room.game.status !== 'playing') && connected(room.players[0].token))
    .map((room) => ({ code: room.code, type: room.type, status: room.game.status, count: room.players.length, maxPlayers: room.type === 'seotda' ? 4 : 2, title: room.title, host: publicPlayer(room.players[0]) }))
    .reverse();
  const broadcastLobby = () => io.to('lobby').emit('lobby:state', lobbyState());
  const broadcastRoom = (room) => {
    room.updatedAt = Date.now();
    if (room.type === 'seotda') {
      syncSeotdaWallets(room);
      scheduleBankruptcy(room);
      scheduleNextRound(room);
    }
    // Hidden hands are serialized separately for every seat, never broadcast raw.
    for (const seat of room.players) {
      const socket = io.sockets.sockets.get(sessions.get(seat.token)?.socketId);
      socket?.emit('room:state', roomState(room, seat.token));
    }
  };
  function syncSeotdaWallets(room) {
    if (room.game.status === 'finished' && room.game.resultAt == null) {
      room.game.resultAt = Date.now() + (room.game.reason === 'showdown' ? seotdaShowdownMs : 0);
    }
    for (const player of room.game.players) {
      const entry = room.roundWallets?.get(player.color);
      const session = sessions.get(entry?.token);
      if (!session) continue;
      // Apply only the delta so a departed player's later refund cannot overwrite a new hand.
      session.seotdaWallet.balance += player.chips - entry.accountedChips;
      entry.accountedChips = player.chips;
      if (room.game.status === 'finished' && !entry.settled) {
        session.seotdaWallet.totalProfit += (room.game.payouts[player.color] || 0) - player.committed;
        entry.settled = true;
      }
      io.sockets.sockets.get(session.socketId)?.emit('wallet:state', session.seotdaWallet);
    }
    for (const seat of room.players) seat.chips = sessions.get(seat.token).seotdaWallet.balance;
  }
  function cancelNextRound(room) {
    clearTimeout(room.nextRoundTimer);
    room.nextRoundTimer = null;
    room.nextRoundAt = null;
  }
  function cancelBankruptcy(room) {
    clearTimeout(room.bankruptcyTimer);
    room.bankruptcyTimer = null;
  }
  function scheduleBankruptcy(room) {
    cancelBankruptcy(room);
    if (closing || room.game.status !== 'finished') return;
    const broke = room.players.filter((seat) => sessions.get(seat.token).seotdaWallet.balance < ANTE);
    if (!broke.length) return;
    room.startRequired = true;
    cancelNextRound(room);
    const round = room.game.round;
    room.bankruptcyTimer = setTimeout(() => {
      room.bankruptcyTimer = null;
      if (rooms.get(room.code) !== room || room.game.round !== round || closing) return;
      for (const seat of broke) {
        const session = sessions.get(seat.token);
        if (session?.roomCode !== room.code || session.seotdaWallet.balance >= ANTE) continue;
        session.pendingKick = {
          id: randomUUID(),
          message: session.seotdaWallet.balance === 0 ? '꺼져 쉐끼야 ㅋㅋ' : INSUFFICIENT_CHIPS,
        };
        leaveRoom(session, 'bankrupt');
        io.sockets.sockets.get(session.socketId)?.emit('seotda:kicked', session.pendingKick);
      }
    }, Math.max(1, room.game.resultAt + seotdaNextRoundMs - Date.now()));
    room.bankruptcyTimer.unref();
  }
  function requireSeotdaChips(session) {
    if (session.seotdaWallet.balance >= ANTE) return;
    const error = new Error(INSUFFICIENT_CHIPS);
    error.code = 'INSUFFICIENT_CHIPS';
    throw error;
  }
  function startSeotdaRound(room) {
    if (room.game.status === 'playing') throw new Error('이미 진행 중입니다.');
    if (room.game.resultAt > Date.now()) throw new Error('패를 확인하는 중입니다.');
    if (room.players.length < 2 || room.players.some((seat) => !connected(seat.token))) throw new Error('접속한 2~4명이 필요합니다.');
    syncSeotdaWallets(room);
    if (room.players.some((seat) => sessions.get(seat.token).seotdaWallet.balance < ANTE)) throw new Error('잔고가 부족한 참가자를 정리 중입니다.');
    cancelNextRound(room);
    cancelBankruptcy(room);
    room.startRequired = false;
    for (const seat of room.players) {
      const wallet = sessions.get(seat.token).seotdaWallet;
      seat.chips = wallet.balance;
    }
    room.roundWallets = new Map(room.players.map((seat) => [seat.color, { token: seat.token, accountedChips: seat.chips, settled: false }]));
    room.game = dealSeotda(room.players, { round: room.game.round + 1, dealer: room.game.round % room.players.length });
  }
  function scheduleNextRound(room) {
    const betweenRounds = room.game.status === 'finished' || room.game.status === 'waiting' && room.game.round > 0;
    const eligible = !closing && !room.startRequired && room.autoNext && betweenRounds
      && room.players.length >= 2 && room.players.every((seat) => connected(seat.token));
    if (!eligible) { cancelNextRound(room); return; }
    if (room.nextRoundTimer) return;
    room.nextRoundAt = Math.max(Date.now(), room.game.resultAt ?? 0) + seotdaNextRoundMs;
    room.nextRoundTimer = setTimeout(() => {
      room.nextRoundTimer = null;
      room.nextRoundAt = null;
      if (rooms.get(room.code) !== room || closing) return;
      startSeotdaRound(room);
      broadcastRoom(room);
      broadcastLobby();
    }, Math.max(1, room.nextRoundAt - Date.now()));
    room.nextRoundTimer.unref();
  }
  function canStartSeotda(room, token) {
    if (room.players[0]?.token === token) return true;
    const seat = room.players.find((player) => player.token === token);
    const hand = room.game.players.find((player) => player.color === seat?.color);
    return room.game.status === 'finished' && Boolean(hand) && (room.game.payouts[hand.color] || 0) > hand.committed;
  }
  function finish(room, color, reason) {
    if (room.game.status !== 'playing') return;
    if (room.type === 'seotda') return;
    room.game.status = 'finished';
    room.game.winner = color;
    room.game.reason = reason;
    room.rematch.clear();
  }
  function leaveRoom(session, reason = 'leave') {
    const room = rooms.get(session.roomCode);
    session.roomCode = null;
    if (!room) return;
    const opponent = room.players.find((seat) => seat.token !== session.token);
    if (room.type === 'seotda') {
      room.startRequired = true;
      cancelNextRound(room);
      foldSeotda(room.game, room.players.find((p) => p.token === session.token)?.color, reason);
      syncSeotdaWallets(room);
    } else finish(room, opponent?.color ?? null, reason);
    room.players = room.players.filter((seat) => seat.token !== session.token);
    room.rematch.clear();
    const socket = io.sockets.sockets.get(session.socketId);
    if (socket) {
      socket.leave(room.code);
      socket.join('lobby');
      socket.emit('room:state', null);
    }
    if (!room.players.length) { cancelNextRound(room); cancelBankruptcy(room); rooms.delete(room.code); }
    else broadcastRoom(room);
    broadcastLobby();
  }
  function getRoom(session) {
    const room = rooms.get(session.roomCode);
    if (!room) throw new Error('먼저 대국실에 입장해 주세요.');
    return room;
  }
  function requireBothOnline(room) {
    if (room.players.length !== 2 || !room.players.every((seat) => connected(seat.token))) {
      throw new Error('상대방의 접속을 기다려 주세요.');
    }
  }
  function requireProfile(session) {
    if (!session.profile) throw new Error('프로필을 선택해 주세요.');
  }

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    let session = typeof token === 'string' ? sessions.get(token) : undefined;
    const handoff = socket.handshake.auth?.handoff;
    if (session && typeof handoff === 'string' && handoff === session.handoff) {
      const previous = io.sockets.sockets.get(session.socketId);
      session.socketId = null;
      previous?.disconnect(true);
    }
    // A duplicated browser tab becomes a separate guest, rather than stealing a seat.
    if (session?.socketId) session = undefined;
    if (!session) {
      if (sessions.size >= maxSessions) return next(new Error('접속자가 많아요. 잠시 후 다시 접속해 주세요.'));
      const token = randomBytes(32).toString('hex');
      session = {
        token, id: randomUUID(), profile: null,
        seotdaWallet: { balance: STARTING_CHIPS, totalProfit: 0 }, pendingKick: null, refillChallenge: null,
        roomCode: null, socketId: null, reconnectDeadline: null, timer: null, lastSeen: Date.now(),
      };
      sessions.set(token, session);
    }
    // Reserve before the connection callback so concurrent handshakes cannot share a seat.
    session.handoff = null;
    session.socketId = socket.id;
    socket.data.session = session;
    next();
  });

  io.on('connection', (socket) => {
    const session = socket.data.session;
    clearTimeout(session.timer);
    session.reconnectDeadline = null;
    session.lastSeen = Date.now();
    socket.emit('session', { token: session.token, playerId: session.id, profile: session.profile, graceMs: disconnectGraceMs, wallet: session.seotdaWallet, pendingKick: session.pendingKick });
    const room = rooms.get(session.roomCode);
    if (room) {
      socket.join(room.code);
      broadcastRoom(room);
      socket.emit('chat:history', { roomCode: room.code, messages: room.chat });
    }
    else { session.roomCode = null; socket.join('lobby'); socket.emit('room:state', null); }
    socket.emit('lobby:state', lobbyState());
    broadcastLobby();

    let windowStart = Date.now();
    let count = 0;
    function handle(event, action) {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          if (Date.now() - windowStart > 10_000) { count = 0; windowStart = Date.now(); }
          if (++count > 100) throw new Error('요청이 너무 빨라요. 잠시만 기다려 주세요.');
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('잘못된 요청이에요.');
          session.lastSeen = Date.now();
          const data = action(payload);
          reply({ ok: true, ...data });
        } catch (error) { reply({ ok: false, error: error.message, code: error.code }); }
      });
    }
    handle('profile:set', (payload) => {
      if (session.roomCode) throw new Error('방에서 나간 뒤 프로필을 변경해 주세요.');
      const preset = findProfile(payload.profileId);
      if (!preset) throw new Error('잘못된 프로필입니다.');
      session.profile = {
        profileId: preset.profileId,
        name: preset.name,
        avatar: preset.avatar,
      };
      broadcastLobby();
      return { profile: session.profile };
    });
    handle('lobby:list', () => ({ rooms: lobbyState() }));
    handle('session:handoff', () => {
      session.handoff = randomBytes(24).toString('hex');
      return { token: session.token, handoff: session.handoff };
    });
    handle('seotda:kick:ack', ({ id }) => {
      if (session.pendingKick?.id === id) session.pendingKick = null;
    });
    handle('wallet:challenge', () => {
      requireProfile(session);
      const choices = REFILL_PHRASES.filter((text) => text !== session.refillChallenge?.text);
      session.refillChallenge = { id: randomUUID(), text: choices[randomInt(choices.length)] };
      return { challenge: session.refillChallenge, amount: STARTING_CHIPS };
    });
    handle('wallet:refill', ({ id, text }) => {
      requireProfile(session);
      const challenge = session.refillChallenge;
      if (!challenge || id !== challenge.id || typeof text !== 'string' || text.normalize('NFC') !== challenge.text) throw new Error('문장을 똑같이 입력해 주세요.');
      session.refillChallenge = null;
      session.seotdaWallet.balance += STARTING_CHIPS;
      socket.emit('wallet:state', session.seotdaWallet);
      const room = rooms.get(session.roomCode);
      if (room?.type === 'seotda') broadcastRoom(room);
      return { wallet: session.seotdaWallet, amount: STARTING_CHIPS };
    });
    handle('room:create', (payload) => {
      requireProfile(session);
      if (session.roomCode) throw new Error('현재 방에서 나간 뒤 만들어 주세요.');
      if (rooms.size >= maxRooms) throw new Error('대국실이 가득 찼어요. 잠시 후 다시 시도해 주세요.');
      let code;
      do { code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(''); }
      while (rooms.has(code));
      const type = payload.type === 'seotda' ? 'seotda' : 'omok';
      if (type === 'seotda') requireSeotdaChips(session);
      const room = {
        type,
        autoNext: type === 'seotda', startRequired: type === 'seotda', nextRoundAt: null, nextRoundTimer: null, bankruptcyTimer: null,
        code, title: cleanText(payload.title, `${session.profile.name}님의 ${type === 'seotda' ? '섯다방' : '대국실'}`, 28),
        visibility: payload.visibility === 'private' ? 'private' : 'public',
        players: [{ token: session.token, color: 1, chips: session.seotdaWallet.balance }], game: type === 'seotda' ? newSeotdaGame() : newGame(), rematch: new Set(), chat: [], updatedAt: Date.now(),
      };
      rooms.set(code, room);
      session.roomCode = code;
      socket.leave('lobby');
      socket.join(code);
      broadcastRoom(room);
      socket.emit('chat:history', { roomCode: code, messages: room.chat });
      broadcastLobby();
      return { code };
    });
    handle('room:join', (payload) => {
      requireProfile(session);
      if (session.roomCode) throw new Error('현재 방에서 나간 뒤 참가해 주세요.');
      const code = typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : '';
      const room = rooms.get(code);
      if (!room) throw new Error('해당 코드를 가진 방이 없어요.');
      if (room.type === 'seotda') requireSeotdaChips(session);
      if (room.players.length >= (room.type === 'seotda' ? 4 : 2)) throw new Error('방이 가득 찼습니다.');
      if (payload.type && room.type !== payload.type) throw new Error('다른 게임의 방 코드입니다.');
      if (!connected(room.players[0].token)) throw new Error('방장이 다시 접속할 때까지 기다려 주세요.');
      if (room.type === 'seotda') {
        // Keep departed hands reserved until the next deal so newcomers cannot inherit private cards.
        let color = 1;
        while (room.players.some((player) => player.color === color) || room.game.players.some((player) => player.color === color)) color++;
        room.players.push({ token: session.token, color, chips: session.seotdaWallet.balance });
        room.startRequired = true;
        cancelNextRound(room);
      } else {
        room.players[0].color = 1;
        room.players.push({ token: session.token, color: 2, chips: 1000 });
        room.game = newGame(room.game.status === 'waiting' ? room.game.round : room.game.round + 1);
        room.game.status = 'playing';
      }
      room.rematch.clear();
      session.roomCode = code;
      socket.leave('lobby');
      socket.join(code);
      broadcastRoom(room);
      socket.emit('chat:history', { roomCode: code, messages: room.chat });
      broadcastLobby();
    });
    handle('room:leave', () => { leaveRoom(session); });
    handle('chat:send', (payload) => {
      const room = getRoom(session);
      if (typeof payload.text !== 'string' || payload.text.length > 200) throw new Error('채팅은 200자까지 가능합니다.');
      const text = cleanText(payload.text, '', 200);
      if (!text) throw new Error('메시지를 입력해 주세요.');
      if (Date.now() - (session.lastChatAt || 0) < 700) throw new Error('잠시 후 전송해 주세요.');
      session.lastChatAt = Date.now();
      const message = { id: randomUUID(), playerId: session.id, name: session.profile.name, text, at: Date.now() };
      room.chat.push(message);
      if (room.chat.length > 50) room.chat.shift();
      room.updatedAt = Date.now();
      io.to(room.code).emit('chat:message', { roomCode: room.code, message });
    });
    handle('game:move', ({ x, y, round, moveNumber }) => {
      const room = getRoom(session);
      if (room.type !== 'omok') throw new Error('오목 대국이 아닙니다.');
      requireBothOnline(room);
      // Reject delayed/double submissions, including requests from a previous round.
      if (round !== room.game.round || moveNumber !== room.game.moves.length) throw new Error('판이 갱신됐어요. 다시 위치를 선택해 주세요.');
      const seat = room.players.find((seat) => seat.token === session.token);
      placeStone(room.game, seat.color, x, y);
      broadcastRoom(room);
    });
    handle('game:resign', () => {
      const room = getRoom(session);
      if (room.type !== 'omok') throw new Error('섯다에서는 다이를 선택해 주세요.');
      if (room.game.status !== 'playing') throw new Error('진행 중인 대국이 없어요.');
      finish(room, room.players.find((seat) => seat.token !== session.token)?.color ?? null, 'resign');
      broadcastRoom(room);
    });
    handle('game:rematch', () => {
      const room = getRoom(session);
      if (room.type !== 'omok') throw new Error('방장이 다음 판을 시작할 수 있습니다.');
      if (room.game.status !== 'finished') throw new Error('대국이 끝나면 다시 둘 수 있어요.');
      requireBothOnline(room);
      room.rematch.add(session.token);
      if (room.rematch.size === 2) {
        room.players.forEach((seat) => { seat.color = seat.color === 1 ? 2 : 1; });
        room.game = newGame(room.game.round + 1);
        room.game.status = 'playing';
        room.rematch.clear();
      }
      broadcastRoom(room);
    });
    handle('seotda:start', () => {
      const room = getRoom(session);
      if (room.type !== 'seotda') throw new Error('섯다 방이 아닙니다.');
      requireSeotdaChips(session);
      if (!canStartSeotda(room, session.token)) throw new Error('방장 또는 직전 판 승자만 시작할 수 있습니다.');
      startSeotdaRound(room);
      broadcastRoom(room); broadcastLobby();
    });
    handle('seotda:autoplay', ({ enabled }) => {
      const room = getRoom(session);
      if (room.type !== 'seotda' || room.players[0].token !== session.token) throw new Error('섯다 방장만 변경할 수 있습니다.');
      if (typeof enabled !== 'boolean') throw new Error('잘못된 설정입니다.');
      room.autoNext = enabled;
      broadcastRoom(room);
    });
    handle('seotda:action', ({ action, amount, round, version }) => {
      const room = getRoom(session);
      if (room.type !== 'seotda') throw new Error('섯다 방이 아닙니다.');
      if (room.players.some((seat) => room.game.players.some((hand) => hand.color === seat.color && !hand.folded) && !connected(seat.token))) throw new Error('상대방의 재접속을 기다려 주세요.');
      const seat = room.players.find((p) => p.token === session.token);
      seotdaAction(room.game, seat.color, action, amount, { round, version });
      broadcastRoom(room); broadcastLobby();
    });
    socket.on('disconnect', () => {
      if (session.socketId !== socket.id) return;
      session.socketId = null;
      session.lastSeen = Date.now();
      session.reconnectDeadline = Date.now() + disconnectGraceMs;
      const room = rooms.get(session.roomCode);
      if (room) { room.rematch.clear(); broadcastRoom(room); }
      broadcastLobby();
      session.timer = setTimeout(() => {
        if (!session.socketId) { leaveRoom(session, 'disconnect'); session.reconnectDeadline = null; }
      }, disconnectGraceMs);
      session.timer.unref();
    });
  });

  const cleanup = setInterval(() => {
    for (const room of rooms.values()) {
      if (Date.now() - room.updatedAt < idleRoomMs) continue;
      for (const seat of [...room.players]) {
        const session = sessions.get(seat.token);
        const socket = io.sockets.sockets.get(session.socketId);
        socket?.emit('notice', '오랫동안 활동이 없어 대국실이 닫혔어요.');
        leaveRoom(session, 'idle');
      }
    }
    for (const [token, session] of sessions) {
      if (!session.socketId && !session.roomCode && Date.now() - session.lastSeen > 60 * 60_000) {
        clearTimeout(session.timer);
        sessions.delete(token);
      }
    }
  }, 60_000);
  cleanup.unref();
  return {
    httpServer, io,
    async listen(port = 3000, host = '0.0.0.0') {
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, resolve);
      });
      return httpServer.address();
    },
    async close() {
      closing = true;
      for (const room of rooms.values()) { cancelNextRound(room); cancelBankruptcy(room); }
      clearInterval(cleanup);
      for (const session of sessions.values()) clearTimeout(session.timer);
      await new Promise((resolve) => io.close(resolve));
      // Disconnect handlers can create timers during io.close().
      for (const session of sessions.values()) clearTimeout(session.timer);
    },
  };
}

if (process.argv[1] && pathToFileURL(fileURLToPath(pathToFileURL(process.argv[1]))).href === import.meta.url) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const app = createGameServer();
  await app.listen(port, process.env.HOST || '0.0.0.0');
  console.log(`타라미니게임천국 · http://localhost:${port}`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  });
}
