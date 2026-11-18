import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';
import { createGameServer } from '../server.js';

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
    const client = { socket, session: null, state: null, lobby: [] };
    clients.push(client);
    socket.on('session', (session) => { client.session = session; });
    socket.on('room:state', (state) => { client.state = state; });
    socket.on('lobby:state', (lobby) => { client.lobby = lobby; });
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
  assert.match(await response.text(), /오목의 전설/);
  for (const file of ['/profile', '/lobby', '/lobby?room=ABC234', '/game/ABC234', '/app.js', '/style.css', '/avatars.js', '/profiles.js', '/game-messages.js', '/socket.io/socket.io.js']) {
    assert.equal((await fetch(url + file)).status, 200);
  }
  for (const name of ['juchan', 'gyeonghu', 'ganghui', 'yonghwan']) {
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
  assert.equal((await fetch(url + '/game/not-a-code')).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
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
  for (const [profileId, name] of [['juchan', '주찬'], ['gyeonghu', '경후'], ['ganghui', '강희'], ['yonghwan', '용환']]) {
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
