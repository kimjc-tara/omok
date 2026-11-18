import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import { newGame, placeStone } from './game.js';
import { findProfile } from './public/profiles.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/avatars.js', ['avatars.js', 'text/javascript; charset=utf-8']],
  ['/profiles.js', ['profiles.js', 'text/javascript; charset=utf-8']],
  ['/game-messages.js', ['game-messages.js', 'text/javascript; charset=utf-8']],
  ['/assets/avatars/juchan.png', ['assets/avatars/juchan.png', 'image/png']],
  ['/assets/avatars/gyeonghu.png', ['assets/avatars/gyeonghu.png', 'image/png']],
  ['/assets/avatars/ganghui.png', ['assets/avatars/ganghui.png', 'image/png']],
  ['/assets/avatars/yonghwan.png', ['assets/avatars/yonghwan.png', 'image/png']],
]);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function cleanText(value, fallback, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max) || fallback
    : fallback;
}

export function createGameServer({ disconnectGraceMs = 30_000, idleRoomMs = 30 * 60_000, maxRooms = 200, maxSessions = 1000 } = {}) {
  const rooms = new Map();
  const sessions = new Map();
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
      const isPage = /^\/(profile|lobby)\/?$/.test(pathname) || /^\/game\/[A-Z2-9]{6}\/?$/.test(pathname);
      const asset = isPage ? assets.get('/') : assets.get(pathname);
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
  const roomState = (room) => ({
    code: room.code, title: room.title, visibility: room.visibility,
    players: room.players.map(publicPlayer), game: room.game,
    rematch: [...room.rematch].map((token) => sessions.get(token)?.id).filter(Boolean),
  });
  const lobbyState = () => [...rooms.values()]
    .filter((room) => room.visibility === 'public' && room.players.length === 1 && room.game.status !== 'playing' && connected(room.players[0].token))
    .map((room) => ({ code: room.code, title: room.title, host: publicPlayer(room.players[0]) }))
    .reverse();
  const broadcastLobby = () => io.to('lobby').emit('lobby:state', lobbyState());
  const broadcastRoom = (room) => {
    room.updatedAt = Date.now();
    io.to(room.code).emit('room:state', roomState(room));
  };
  function finish(room, color, reason) {
    if (room.game.status !== 'playing') return;
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
    finish(room, opponent?.color ?? null, reason);
    room.players = room.players.filter((seat) => seat.token !== session.token);
    room.rematch.clear();
    const socket = io.sockets.sockets.get(session.socketId);
    if (socket) {
      socket.leave(room.code);
      socket.join('lobby');
      socket.emit('room:state', null);
    }
    if (!room.players.length) rooms.delete(room.code);
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
    // A duplicated browser tab becomes a separate guest, rather than stealing a seat.
    if (session?.socketId) session = undefined;
    if (!session) {
      if (sessions.size >= maxSessions) return next(new Error('접속자가 많아요. 잠시 후 다시 접속해 주세요.'));
      const token = randomBytes(32).toString('hex');
      session = {
        token, id: randomUUID(), profile: null,
        roomCode: null, socketId: null, reconnectDeadline: null, timer: null, lastSeen: Date.now(),
      };
      sessions.set(token, session);
    }
    // Reserve before the connection callback so concurrent handshakes cannot share a seat.
    session.socketId = socket.id;
    socket.data.session = session;
    next();
  });

  io.on('connection', (socket) => {
    const session = socket.data.session;
    clearTimeout(session.timer);
    session.reconnectDeadline = null;
    session.lastSeen = Date.now();
    socket.emit('session', { token: session.token, playerId: session.id, profile: session.profile, graceMs: disconnectGraceMs });
    const room = rooms.get(session.roomCode);
    if (room) { socket.join(room.code); broadcastRoom(room); }
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
        } catch (error) { reply({ ok: false, error: error.message }); }
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
    handle('room:create', (payload) => {
      requireProfile(session);
      if (session.roomCode) throw new Error('현재 방에서 나간 뒤 만들어 주세요.');
      if (rooms.size >= maxRooms) throw new Error('대국실이 가득 찼어요. 잠시 후 다시 시도해 주세요.');
      let code;
      do { code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(''); }
      while (rooms.has(code));
      const room = {
        code, title: cleanText(payload.title, `${session.profile.name}님의 대국실`, 28),
        visibility: payload.visibility === 'private' ? 'private' : 'public',
        players: [{ token: session.token, color: 1 }], game: newGame(), rematch: new Set(), updatedAt: Date.now(),
      };
      rooms.set(code, room);
      session.roomCode = code;
      socket.leave('lobby');
      socket.join(code);
      broadcastRoom(room);
      broadcastLobby();
      return { code };
    });
    handle('room:join', (payload) => {
      requireProfile(session);
      if (session.roomCode) throw new Error('현재 방에서 나간 뒤 참가해 주세요.');
      const code = typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : '';
      const room = rooms.get(code);
      if (!room) throw new Error('해당 코드를 가진 방이 없어요.');
      if (room.players.length >= 2) throw new Error('이미 두 사람이 대국 중인 방이에요.');
      if (!connected(room.players[0].token)) throw new Error('방장이 다시 접속할 때까지 기다려 주세요.');
      room.players[0].color = 1;
      room.players.push({ token: session.token, color: 2 });
      room.game = newGame(room.game.status === 'waiting' ? room.game.round : room.game.round + 1);
      room.game.status = 'playing';
      room.rematch.clear();
      session.roomCode = code;
      socket.leave('lobby');
      socket.join(code);
      broadcastRoom(room);
      broadcastLobby();
    });
    handle('room:leave', () => { leaveRoom(session); });
    handle('game:move', ({ x, y, round, moveNumber }) => {
      const room = getRoom(session);
      requireBothOnline(room);
      // Reject delayed/double submissions, including requests from a previous round.
      if (round !== room.game.round || moveNumber !== room.game.moves.length) throw new Error('판이 갱신됐어요. 다시 위치를 선택해 주세요.');
      const seat = room.players.find((seat) => seat.token === session.token);
      placeStone(room.game, seat.color, x, y);
      broadcastRoom(room);
    });
    handle('game:resign', () => {
      const room = getRoom(session);
      if (room.game.status !== 'playing') throw new Error('진행 중인 대국이 없어요.');
      finish(room, room.players.find((seat) => seat.token !== session.token)?.color ?? null, 'resign');
      broadcastRoom(room);
    });
    handle('game:rematch', () => {
      const room = getRoom(session);
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
  console.log(`오목의 전설 · http://localhost:${port}`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  });
}
