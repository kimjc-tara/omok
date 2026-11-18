import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';
import { createGameServer } from '../server.js';
import { sessionAuth, navigateWithSession } from '../public/session-navigation.js';

async function waitFor(condition, message = 'expected state') {
  const deadline = Date.now() + 2500;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await delay(5);
  }
}

async function fixture(t, options = {}) {
  const app = createGameServer({ disconnectGraceMs: 1000, ...options });
  const address = await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}`;
  const clients = [];
  t.after(async () => { for (const client of clients) client.socket.disconnect(); await app.close(); });
  async function connect(token, extra = {}, profileId = 'juchan') {
    const socket = io(url, { autoConnect: false, reconnection: false, forceNew: true, transports: ['websocket'], auth: { token }, ...extra });
    const client = { socket, session: null, state: null, lobby: [], messages: [], history: [] };
    clients.push(client);
    socket.on('session', (session) => { client.session = session; client.wallet = session.wallet; });
    socket.on('wallet:state', (wallet) => { client.wallet = wallet; });
    socket.on('room:state', (state) => { client.state = state; });
    socket.on('lobby:state', (lobby) => { client.lobby = lobby; });
    socket.on('chat:message', ({ message }) => { client.messages.push(message); });
    socket.on('chat:history', ({ messages }) => { client.history = messages; });
    socket.connect();
    await waitFor(() => client.session, 'client connected');
    client.send = (event, data = {}) => socket.timeout(1500).emitWithAck(event, data);
    if (!client.session.profile && profileId) {
      const result = await client.send('profile:set', { profileId });
      assert.equal(result.ok, true);
      client.session.profile = result.profile;
    }
    return client;
  }
  async function pair(visibility = 'public') {
    const a = await connect();
    const b = await connect(undefined, {}, 'gyeonghu');
    const created = await a.send('room:create', { visibility, title: '테스트 대국실' });
    assert.equal(created.ok, true);
    assert.equal((await b.send('room:join', { code: created.code })).ok, true);
    await waitFor(() => a.state?.game.status === 'playing' && b.state?.game.status === 'playing');
    return { a, b, code: created.code };
  }
  const move = (client, x, y, overrides = {}) => client.send('game:move', {
    x, y, round: client.state.game.round, moveNumber: client.state.game.moves.length, ...overrides,
  });
  return { app, url, connect, pair, move };
}

test('HTTP serves the app and health endpoint, without exposing source files', async (t) => {
  const { url } = await fixture(t);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /타라미니게임천국/);
  for (const file of ['/home', '/omok', '/profile', '/lobby', '/lobby?room=ABC234', '/game/ABC234', '/seotda', '/seotda?room=ABC234', '/seotda/game/ABC234', '/seotda.js', '/seotda.css', '/seotda-ranks.js', '/session-navigation.js', '/app.js', '/style.css', '/avatars.js', '/profiles.js', '/game-messages.js', '/socket.io/socket.io.js']) {
    assert.equal((await fetch(url + file)).status, 200);
  }
  for (const name of ['juchan', 'gyeonghu', 'ganghui', 'yonghwan', 'donghyeon', 'jiwon', 'minseo']) {
    const image = await fetch(`${url}/assets/avatars/${name}.png`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    const bytes = new Uint8Array(await image.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    // PNG IHDR color type 6 includes an alpha channel.
    assert.equal(bytes[25], 6);
  }
  assert.deepEqual(await (await fetch(url + '/healthz')).json(), { ok: true });
  assert.equal((await fetch(url + '/server.js')).status, 404);
  assert.equal((await fetch(url + '/seotda/game/invalid')).status, 404);
  assert.equal((await fetch(url + '/game/not-a-code')).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
});

test('chat is private to the room, validates input and restores history on reconnect', async (t) => {
  const { pair, connect } = await fixture(t);
  const first = await pair();
  const second = await pair();
  const text = '<b>same room only</b>';
  assert.equal((await first.a.send('chat:send', { text, name: '사칭', roomCode: second.code })).ok, true);
  await waitFor(() => first.b.messages.length === 1);
  assert.equal(first.b.messages[0].name, '주찬');
  assert.equal(first.b.messages[0].text, text);
  assert.equal(second.a.messages.length, 0);
  assert.equal(second.b.messages.length, 0);
  assert.equal(first.b.state.game.moves.length, 0);
  assert.equal((await first.a.send('chat:send', { text: '연속 전송' })).ok, false);
  assert.equal((await first.b.send('chat:send', { text: ' '.repeat(10) })).ok, false);
  assert.equal((await first.b.send('chat:send', { text: 'a'.repeat(201) })).ok, false);
  const outsider = await connect();
  assert.equal((await outsider.send('chat:send', { text })).ok, false);
  const token = first.b.session.token;
  first.b.socket.disconnect();
  await waitFor(() => first.a.state.players.some((player) => !player.connected));
  const resumed = await connect(token);
  await waitFor(() => resumed.history.length === 1);
  assert.equal(resumed.history[0].id, first.a.messages[0].id);
});

test('public lobby, profile and case-insensitive code entry sync across real sockets', async (t) => {
  const { connect } = await fixture(t);
  const a = await connect();
  const b = await connect(undefined, { transports: ['polling'] });
  await a.send('profile:set', { profileId: 'ganghui', name: '임의 이름', avatar: 'cat' });
  const { code } = await a.send('room:create', { title: '편하게 두세요' });
  assert.match(code, /^[A-Z2-9]{6}$/);
  await waitFor(() => b.lobby.some((room) => room.code === code));
  assert.equal(b.lobby[0].host.name, '강희');
  assert.equal(b.lobby[0].host.avatar, 'ganghui');
  assert.equal((await b.send('room:join', { code: ` ${code.toLowerCase()} ` })).ok, true);
  await waitFor(() => a.state?.players.length === 2);
  assert.deepEqual(a.state, b.state);
  assert.equal(a.state.game.turn, 1);
  assert.equal(a.state.game.status, 'playing');
});

test('rooms require a selected preset; custom profile names and invalid IDs are rejected', async (t) => {
  const { connect } = await fixture(t);
  const guest = await connect(undefined, {}, null);
  assert.equal(guest.session.profile, null);
  assert.equal((await guest.send('room:create')).ok, false);
  assert.equal((await guest.send('room:join', { code: 'ABC234' })).ok, false);
  assert.equal((await guest.send('profile:set', { name: '마음대로' })).ok, false);
  assert.equal((await guest.send('profile:set', { profileId: 'unknown', name: '주찬' })).ok, false);
  for (const [profileId, name] of [['juchan', '주찬'], ['gyeonghu', '경후'], ['ganghui', '강희'], ['yonghwan', '용환'], ['donghyeon', '동현'], ['jiwon', '지원'], ['minseo', '민서']]) {
    const result = await guest.send('profile:set', { profileId, name: '다른 이름', avatar: 'cat' });
    assert.equal(result.ok, true);
    assert.equal(result.profile.name, name);
    assert.equal(result.profile.avatar, profileId);
  }
  assert.equal((await guest.send('room:create')).ok, true);
  assert.equal((await guest.send('profile:set', { profileId: 'juchan' })).ok, false);
});

test('private rooms stay out of the lobby and reject a third player', async (t) => {
  const { pair, connect } = await fixture(t);
  const { code } = await pair('private');
  const c = await connect();
  assert.deepEqual(c.lobby, []);
  assert.equal((await c.send('room:join', { code: 'XXXXXX' })).ok, false);
  assert.equal((await c.send('room:join', { code })).ok, false);
  assert.equal((await c.send('game:move', { x: 1, y: 1 })).ok, false);
});

test('turns, occupied intersections, malformed coordinates and stale submissions are enforced', async (t) => {
  const { pair, move } = await fixture(t);
  const { a, b } = await pair();
  assert.equal((await move(b, 7, 7)).ok, false);
  assert.equal((await move(a, -1, 7)).ok, false);
  assert.equal((await move(a, '7', 7)).ok, false);
  assert.equal((await a.send('game:move', null)).ok, false);
  assert.equal((await move(a, 7, 7)).ok, true);
  await waitFor(() => b.state.game.moves.length === 1);
  assert.equal((await move(a, 8, 7)).ok, false);
  assert.equal((await move(b, 7, 7)).ok, false);
  assert.equal((await move(b, 8, 7, { moveNumber: 0 })).ok, false);
  assert.equal((await move(b, 8, 7)).ok, true);
  await waitFor(() => a.state.game.moves.length === 2);
  assert.deepEqual(a.state, b.state);
});

test('a complete match announces a win; mutual rematch clears the board and swaps colors', async (t) => {
  const { pair, move } = await fixture(t);
  const { a, b } = await pair();
  for (let x = 0; x < 4; x++) {
    assert.equal((await move(a, x, 7)).ok, true);
    await waitFor(() => b.state.game.moves.length === x * 2 + 1);
    assert.equal((await move(b, x, 8)).ok, true);
    await waitFor(() => a.state.game.moves.length === x * 2 + 2);
  }
  assert.equal((await move(a, 4, 7)).ok, true);
  await waitFor(() => b.state.game.status === 'finished');
  assert.equal(b.state.game.winner, 1);
  assert.equal(b.state.game.winningLine.length, 5);
  assert.equal((await move(b, 4, 8)).ok, false);
  assert.equal((await a.send('game:rematch')).ok, true);
  assert.equal(a.state.game.status, 'finished');
  assert.equal((await b.send('game:rematch')).ok, true);
  await waitFor(() => a.state.game.round === 2);
  assert.equal(a.state.game.moves.length, 0);
  assert.equal(a.state.players.find((player) => player.id === a.session.playerId).color, 2);
  assert.equal((await move(b, 7, 7, { round: 1 })).ok, false);
  assert.equal((await move(b, 7, 7)).ok, true);
});

test('disconnect pauses moves; the same session reconnects with the same board and identity', async (t) => {
  const { pair, move, connect } = await fixture(t);
  const { a, b } = await pair();
  await move(a, 7, 7);
  await waitFor(() => b.state.game.moves.length === 1);
  const token = a.session.token;
  const id = a.session.playerId;
  a.socket.disconnect();
  await waitFor(() => b.state.players.some((player) => !player.connected));
  assert.equal((await move(b, 8, 7)).ok, false);
  const resumed = await connect(token);
  await waitFor(() => b.state.players.every((player) => player.connected));
  assert.equal(resumed.session.playerId, id);
  assert.equal(resumed.state.game.board[7][7], 1);
  assert.equal(resumed.state.game.turn, 2);
  assert.equal((await move(b, 8, 7)).ok, true);
  await waitFor(() => resumed.state.game.moves.length === 2);
});

test('grace timeout awards a forfeit and frees the room for a new player', async (t) => {
  const { pair, connect } = await fixture(t, { disconnectGraceMs: 80 });
  const { a, b, code } = await pair();
  a.socket.disconnect();
  await waitFor(() => b.state.game.status === 'finished');
  assert.equal(b.state.game.reason, 'disconnect');
  assert.equal(b.state.game.winner, 2);
  const c = await connect();
  await waitFor(() => c.lobby.some((room) => room.code === code));
  assert.equal((await c.send('room:join', { code })).ok, true);
  await waitFor(() => b.state.game.status === 'playing');
  assert.equal(b.state.game.moves.length, 0);
  assert.equal(b.state.game.round, 2);
  assert.equal(b.state.players[0].color, 1);
});

test('resign and leave award the opponent; leaving the last seat removes the room', async (t) => {
  const { pair, connect } = await fixture(t);
  const { a, b, code } = await pair();
  await a.send('game:resign');
  await waitFor(() => b.state.game.status === 'finished');
  assert.equal(b.state.game.winner, 2);
  assert.equal(b.state.game.reason, 'resign');
  await a.send('game:rematch');
  await b.send('game:rematch');
  await waitFor(() => a.state.game.round === 2);
  await a.send('room:leave');
  await waitFor(() => b.state.game.status === 'finished');
  assert.equal(b.state.game.reason, 'leave');
  assert.equal(b.state.game.winner, 1);
  await b.send('room:leave');
  const c = await connect();
  assert.equal((await c.send('room:join', { code })).ok, false);
});

test('separate rooms cannot see or change each other’s game', async (t) => {
  const { pair, move } = await fixture(t);
  const first = await pair();
  const second = await pair();
  await move(first.a, 7, 7);
  await waitFor(() => first.b.state.game.moves.length === 1);
  assert.equal(second.a.state.game.moves.length, 0);
  assert.equal((await second.a.send('room:join', { code: first.code })).ok, false);
  assert.equal(second.a.state.code, second.code);
});

test('a copied active session creates a new guest and does not hijack the existing seat', async (t) => {
  const { pair, connect } = await fixture(t);
  const { a } = await pair();
  const duplicate = await connect(a.session.token);
  assert.notEqual(duplicate.session.playerId, a.session.playerId);
  assert.notEqual(duplicate.session.token, a.session.token);
  assert.equal(duplicate.state, null);
  assert.equal(a.socket.connected, true);
});

test('four-seat Seotda rooms isolate hands, reject overcapacity and finish a full betting round', async (t) => {
  const { connect } = await fixture(t);
  const clients = [];
  for (const profile of ['donghyeon', 'jiwon', 'minseo', 'ganghui', 'juchan']) clients.push(await connect(undefined, {}, profile));
  const [a, b, c, d, outsider] = clients;
  const { code } = await a.send('room:create', { type: 'seotda' });
  assert.equal((await a.send('seotda:start')).ok, false);
  for (const client of [b, c, d]) assert.equal((await client.send('room:join', { code, type: 'seotda' })).ok, true);
  assert.equal((await outsider.send('room:join', { code, type: 'seotda' })).ok, false);
  assert.equal((await b.send('seotda:start')).ok, false);
  assert.equal((await a.send('seotda:start')).ok, true);
  await waitFor(() => [a, b, c, d].every((p) => p.state?.game.status === 'playing'));
  assert.equal(a.state.maxPlayers, 4); assert.equal(a.state.players.length, 4);
  for (const client of [a, b, c, d]) {
    const own = client.state.players.find((p) => p.id === client.session.playerId).color;
    for (const hand of client.state.game.players) {
      assert.equal(hand.cards.every((card) => card !== null), hand.color === own);
      assert.equal(Boolean(hand.rank), hand.color === own);
    }
  }
  assert.equal((await a.send('game:move', { x: 1, y: 1 })).ok, false);
  assert.equal((await a.send('game:rematch')).ok, false);
  const action = (client, choice, amount) => client.send('seotda:action', { action: choice, amount, round: client.state.game.round, version: client.state.game.version });
  assert.equal((await action(b, 'call')).ok, false);
  assert.equal((await action(a, 'raise', 50)).ok, true);
  await waitFor(() => b.state.game.version === 1);
  assert.equal((await action(b, 'call')).ok, true);
  await waitFor(() => c.state.game.version === 2);
  assert.equal((await action(c, 'fold')).ok, true);
  await waitFor(() => d.state.game.version === 3);
  assert.equal((await action(d, 'call')).ok, true);
  await waitFor(() => a.state.game.status === 'finished');
  assert.equal(a.state.game.pot, 190);
  assert.equal(a.state.game.players.reduce((sum, p) => sum + p.chips, 0), 4000);
  assert.equal(a.state.nextRoundAt - a.state.game.resultAt, 2000);
  assert.deepEqual(a.state.game.players.find((p) => p.color === 3).cards, [null, null]);
  assert.ok(a.state.game.players.find((p) => p.color === 2).rank);
  const balances = a.state.players.map((p) => p.chips);
  await waitFor(() => Date.now() >= a.state.game.resultAt, 'showdown viewing period ends');
  assert.equal((await a.send('seotda:start')).ok, true);
  await waitFor(() => a.state.game.round === 2);
  assert.deepEqual(a.state.game.players.map((p) => p.chips), balances.map((n) => n - 10));
  assert.equal(a.state.game.turn, 2);
});

test('Seotda reconnect keeps the same private hand; a timed-out seat folds and transfers hosting', async (t) => {
  const { connect } = await fixture(t, { disconnectGraceMs: 200 });
  const a = await connect(), b = await connect(undefined, {}, 'minseo'), c = await connect(undefined, {}, 'jiwon');
  const { code } = await a.send('room:create', { type: 'seotda', visibility: 'private' });
  for (const client of [b, c]) await client.send('room:join', { code });
  await a.send('seotda:start');
  await waitFor(() => b.state.game.status === 'playing');
  const hand = b.state.game.players[1].cards;
  b.socket.disconnect();
  await waitFor(() => a.state.players.some((p) => !p.connected));
  assert.equal((await a.send('seotda:action', { action: 'call', round: 1, version: 0 })).ok, false);
  const restored = await connect(b.session.token);
  await waitFor(() => restored.state?.code === code);
  assert.deepEqual(restored.state.game.players[1].cards, hand);
  a.socket.disconnect();
  await waitFor(() => restored.state.players.length === 2);
  assert.equal(restored.state.hostId, restored.session.playerId);
  assert.equal(restored.state.game.status, 'playing');
  assert.equal(restored.state.game.players[0].folded, true);
  assert.equal(restored.state.game.turn, 2);
  await c.send('room:leave');
  await waitFor(() => restored.state.game.status === 'finished');
  assert.equal(restored.state.game.payouts[2], 30);
});

test('game types reject mixed entry and a replacement Seotda seat starts with fresh chips', async (t) => {
  const { pair, connect } = await fixture(t);
  const omok = await pair();
  assert.equal((await omok.a.send('seotda:start')).ok, false);
  const a = await connect(), b = await connect(), replacement = await connect();
  assert.equal((await replacement.send('room:join', { code: omok.code, type: 'seotda' })).ok, false);
  const { code } = await a.send('room:create', { type: 'seotda' });
  assert.equal((await replacement.send('room:join', { code, type: 'omok' })).ok, false);
  await b.send('room:join', { code }); await a.send('seotda:start');
  await waitFor(() => a.state.game.status === 'playing');
  await b.send('room:leave');
  await waitFor(() => a.state.game.status === 'finished');
  const chips = a.state.players[0].chips;
  assert.equal((await replacement.send('room:join', { code })).ok, true);
  await waitFor(() => a.state.players.length === 2);
  assert.equal(a.state.game.status, 'finished'); assert.equal(a.state.players[0].chips, chips);
  assert.equal(a.state.startRequired, true);
  assert.equal(a.state.nextRoundAt, null);
  assert.equal(a.state.players[1].chips, 1000);
});

test('Seotda wallets keep settled gains across rooms, refreshes and repeated broadcasts', async (t) => {
  const { connect } = await fixture(t);
  const a = await connect(), b = await connect();
  const { code } = await a.send('room:create', { type: 'seotda' });
  await b.send('room:join', { code });
  await a.send('seotda:autoplay', { enabled: false });
  await a.send('seotda:start');
  await waitFor(() => a.state.game.status === 'playing');
  assert.equal(a.wallet.balance, 990);
  await a.send('seotda:action', { action: 'fold', round: 1, version: 0 });
  await waitFor(() => b.state.game.status === 'finished');
  assert.deepEqual(a.wallet, { balance: 990, totalProfit: -10 });
  assert.deepEqual(b.wallet, { balance: 1010, totalProfit: 10 });
  await b.send('room:leave');
  await waitFor(() => a.state.players.length === 1);
  assert.deepEqual(a.wallet, { balance: 990, totalProfit: -10 });
  await b.send('profile:set', { profileId: 'minseo' });
  await b.send('room:create', { type: 'seotda' });
  await waitFor(() => b.state?.players[0].chips === 1010);
  b.socket.disconnect();
  await waitFor(() => !b.socket.connected);
  await delay(20);
  const refreshed = await connect(b.session.token);
  assert.deepEqual(refreshed.session.wallet, { balance: 1010, totalProfit: 10 });
  const guest = await connect();
  assert.deepEqual(guest.wallet, { balance: 1000, totalProfit: 0 });
});

test('a departed Seotda seat can enter another round without an old settlement replacing its wallet', async (t) => {
  const { connect } = await fixture(t);
  const a = await connect(), b = await connect(), c = await connect(), d = await connect();
  const { code } = await a.send('room:create', { type: 'seotda' });
  for (const player of [b, c]) await player.send('room:join', { code });
  await a.send('seotda:autoplay', { enabled: false });
  await a.send('seotda:start');
  await a.send('seotda:action', { action: 'raise', amount: 50, round: 1, version: 0 });
  await b.send('room:leave');
  const other = await b.send('room:create', { type: 'seotda' });
  await d.send('room:join', { code: other.code });
  await b.send('seotda:autoplay', { enabled: false });
  await b.send('seotda:start');
  await waitFor(() => b.state.game.status === 'playing');
  assert.equal(b.wallet.balance, 980);
  await waitFor(() => c.state.game.turn === 3);
  await c.send('seotda:action', { action: 'call', round: 1, version: c.state.game.version });
  await waitFor(() => b.wallet.totalProfit === -10);
  assert.equal(b.wallet.balance, 980);
  assert.equal(b.state.code, other.code);
});

test('automatic Seotda rounds carry balances forward and host pause cancels the pending start', async (t) => {
  const { connect } = await fixture(t, { seotdaNextRoundMs: 160 });
  const a = await connect(), b = await connect();
  const { code } = await a.send('room:create', { type: 'seotda' });
  await b.send('room:join', { code });
  assert.equal((await b.send('seotda:autoplay', { enabled: false })).ok, false);
  await a.send('seotda:start');
  await a.send('seotda:action', { action: 'fold', round: 1, version: 0 });
  await waitFor(() => b.state.game.status === 'finished');
  assert.ok(b.state.nextRoundAt > Date.now());
  await waitFor(() => a.state.game.round === 2);
  assert.equal(a.wallet.balance, 980);
  assert.equal(a.wallet.totalProfit, -10);
  assert.equal(a.state.game.turn, 2);
  await b.send('seotda:action', { action: 'fold', round: 2, version: 0 });
  await a.send('seotda:autoplay', { enabled: false });
  await waitFor(() => a.state.autoNext === false);
  assert.equal(a.state.nextRoundAt, null);
  await delay(200);
  assert.equal(a.state.game.round, 2);
  assert.equal(a.state.game.status, 'finished');
  assert.deepEqual(a.wallet, { balance: 1000, totalProfit: 0 });
  await a.send('seotda:autoplay', { enabled: true });
  b.socket.disconnect();
  await waitFor(() => a.state.players.some((player) => !player.connected));
  assert.equal(a.state.nextRoundAt, null);
  await delay(200);
  assert.equal(a.state.game.round, 2);
});

test('leaving a two-player Seotda hand awards the survivor and waits for a manual restart', async (t) => {
  const { connect } = await fixture(t, { seotdaNextRoundMs: 60 });
  const a = await connect(), b = await connect(), newcomer = await connect();
  const { code } = await a.send('room:create', { type: 'seotda' });
  await b.send('room:join', { code }); await a.send('seotda:start');
  await b.send('room:leave');
  await waitFor(() => a.state.game.status === 'finished');
  assert.equal(a.state.game.payouts[1], 20);
  assert.equal(a.state.startRequired, true);
  assert.equal(a.state.nextRoundAt, null);
  await newcomer.send('room:join', { code });
  await delay(100);
  assert.equal(a.state.game.round, 1);
  assert.equal(a.state.game.status, 'finished');
  assert.equal((await a.send('seotda:start')).ok, true);
  await waitFor(() => newcomer.state.game.round === 2);
  assert.equal(a.state.startRequired, false);
});

test('three-player departure keeps the hand going and the remaining non-host winner can restart', async (t) => {
  const { connect } = await fixture(t, { seotdaNextRoundMs: 60 });
  const a = await connect(), b = await connect(), c = await connect();
  const { code } = await a.send('room:create', { type: 'seotda' });
  for (const player of [b, c]) await player.send('room:join', { code });
  await a.send('seotda:start');
  await a.send('seotda:action', { action: 'call', round: 1, version: 0 });
  await b.send('room:leave');
  await waitFor(() => c.state.players.length === 2);
  assert.equal(c.state.game.status, 'playing');
  assert.equal(c.state.game.turn, 3);
  assert.equal(c.state.startRequired, true);
  await c.send('seotda:action', { action: 'raise', amount: 10, round: 1, version: c.state.game.version });
  await waitFor(() => a.state.game.turn === 1);
  await a.send('seotda:action', { action: 'fold', round: 1, version: a.state.game.version });
  await waitFor(() => c.state.game.status === 'finished');
  assert.equal(c.state.canStart, true);
  assert.notEqual(c.state.hostId, c.session.playerId);
  assert.equal(c.state.nextRoundAt, null);
  await delay(100);
  assert.equal(c.state.game.round, 1);
  assert.equal((await c.send('seotda:start')).ok, true);
  await waitFor(() => a.state.game.round === 2);
  assert.equal(a.state.game.players.length, 2);
});

test('mid-hand entrants wait without inheriting a departed hand and join the next manual deal', async (t) => {
  const { connect } = await fixture(t, { seotdaNextRoundMs: 60 });
  const players = [];
  for (let index = 0; index < 5; index++) players.push(await connect());
  const [a, b, c, d, entrant] = players;
  const { code } = await a.send('room:create', { type: 'seotda' });
  for (const player of [b, c, d]) await player.send('room:join', { code });
  await a.send('seotda:start'); await b.send('room:leave');
  await waitFor(() => entrant.lobby.some((item) => item.code === code && item.status === 'playing'));
  assert.equal((await entrant.send('room:join', { code })).ok, true);
  await waitFor(() => entrant.state?.code === code);
  const color = entrant.state.players.find((player) => player.id === entrant.session.playerId).color;
  assert.equal(entrant.state.game.players.some((hand) => hand.color === color), false);
  assert.ok(entrant.state.game.players.every((hand) => hand.cards.every((card) => card === null)));
  assert.equal((await entrant.send('seotda:action', { action: 'all-in', round: 1, version: entrant.state.game.version })).ok, false);
  assert.equal(entrant.state.startRequired, true);
  entrant.socket.disconnect();
  await waitFor(() => a.state.players.some((player) => !player.connected));
  assert.equal((await a.send('seotda:action', { action: 'fold', round: 1, version: a.state.game.version })).ok, true, 'an offline waiting entrant cannot block active betting');
  const returned = await connect(entrant.session.token);
  await waitFor(() => c.state.game.turn === 3);
  await c.send('seotda:action', { action: 'fold', round: 1, version: c.state.game.version });
  await waitFor(() => returned.state?.game.status === 'finished');
  assert.equal(returned.state.canStart, false);
  assert.equal(returned.state.nextRoundAt, null);
  await delay(100);
  assert.equal(returned.state.game.round, 1);
  assert.equal((await a.send('seotda:start')).ok, true);
  await waitFor(() => returned.state.game.round === 2);
  assert.equal(returned.state.game.players.length, 4);
  assert.ok(returned.state.game.players.find((hand) => hand.color === color).cards.every(Boolean));
});

test('refill challenges add 1000 chips at any balance and each answer can be credited only once', async (t) => {
  const { connect } = await fixture(t);
  const client = await connect();
  const original = (await client.send('wallet:challenge')).challenge;
  const changed = (await client.send('wallet:challenge')).challenge;
  assert.notEqual(changed.text, original.text, 'changing the prompt always picks different text');
  assert.notEqual(changed.id, original.id);
  assert.equal((await client.send('wallet:refill', original)).ok, false, 'an old answer cannot credit the new challenge');
  assert.equal(client.wallet.balance, 1000);
  for (let count = 1; count <= 2; count++) {
    const { challenge } = await client.send('wallet:challenge');
    assert.equal((await client.send('wallet:refill', { id: challenge.id, text: '틀린 문장' })).ok, false);
    const answers = await Promise.all([
      client.send('wallet:refill', challenge), client.send('wallet:refill', challenge),
    ]);
    assert.equal(answers.filter((answer) => answer.ok).length, 1);
    assert.deepEqual(client.wallet, { balance: 1000 + count * 1000, totalProfit: 0 });
  }
});

test('page handoff preserves the profile and wallet even while the previous socket is still active', async (t) => {
  const { connect } = await fixture(t);
  const original = await connect(undefined, {}, 'minseo');
  const { challenge } = await original.send('wallet:challenge');
  await original.send('wallet:refill', challenge);
  const { handoff, token } = await original.send('session:handoff');
  assert.equal(original.socket.connected, true);
  const moved = await connect(token, { auth: { token, handoff } });
  assert.equal(moved.session.playerId, original.session.playerId);
  assert.equal(moved.session.profile.profileId, 'minseo');
  assert.equal(moved.session.wallet.balance, 2000);
  await waitFor(() => !original.socket.connected);
  const copied = await connect(token, { auth: { token, handoff } });
  assert.notEqual(copied.session.playerId, moved.session.playerId, 'used handoff credentials cannot steal an active session');
  const stored = new Map([['omok-session', token]]);
  let destination;
  const pageWindow = {
    sessionStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
    location: { assign: (path) => { destination = path; } },
  };
  await navigateWithSession(pageWindow, moved.socket, '/seotda');
  assert.equal(destination, '/seotda');
  const auth = sessionAuth(pageWindow);
  assert.ok(auth.handoff);
  assert.equal(stored.has('omok-handoff'), false, 'navigation credentials are read once by the new page');
  const gamePage = await connect(auth.token, { auth });
  assert.equal(gamePage.session.playerId, original.session.playerId);
  assert.equal(gamePage.session.profile.profileId, 'minseo');
  assert.equal(gamePage.session.wallet.balance, 2000);
});

test('cross-origin browser connections are rejected', async (t) => {
  const { url } = await fixture(t);
  const client = io(url, { transports: ['websocket'], reconnection: false, extraHeaders: { Origin: 'https://unrelated.example' } });
  t.after(() => client.disconnect());
  await new Promise((resolve, reject) => {
    client.once('connect_error', resolve);
    client.once('connect', () => reject(new Error('Cross-origin connection accepted')));
  });
  assert.equal(client.connected, false);
});
