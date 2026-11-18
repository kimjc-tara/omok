import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { io } from 'socket.io-client';
import { createGameServer } from '../server.js';
import { startApp } from '../public/app.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
async function waitFor(condition, message = 'page update') {
  const deadline = Date.now() + 3500;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await delay(10);
  }
}

async function fixture(t) {
  const server = createGameServer({ disconnectGraceMs: 2000 });
  const { port } = await server.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  const clients = [];
  t.after(async () => {
    for (const client of clients) { client.app.destroy(); client.window.close(); }
    await server.close();
  });
  async function open(path = '/', { session = {}, local = {} } = {}) {
    const dom = new JSDOM(html, { url: origin + path });
    const { window } = dom;
    // jsdom has dialog elements but no native top-layer implementation.
    window.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
      this.querySelector('[autofocus]')?.focus();
    };
    window.HTMLDialogElement.prototype.close = function (value = '') {
      if (!this.open) return;
      this.returnValue = value;
      this.open = false;
      this.dispatchEvent(new window.Event('close'));
    };
    for (const [key, value] of Object.entries(session)) window.sessionStorage.setItem(key, value);
    for (const [key, value] of Object.entries(local)) window.localStorage.setItem(key, value);
    let socket;
    window.io = (options) => {
      socket = io(origin, { ...options, forceNew: true, reconnection: false, transports: ['websocket'] });
      return socket;
    };
    const client = { window, document: window.document, app: startApp(window), socket };
    client.get = (id) => client.document.getElementById(id);
    client.visible = () => [...client.document.querySelectorAll('[data-page]')].filter((page) => !page.hidden).map((page) => page.dataset.page);
    client.click = (selector) => {
      const button = client.document.querySelector(selector);
      assert.ok(button, `Element exists: ${selector}`);
      assert.equal(button.disabled, false, `Element is enabled: ${selector}`);
      button.click();
    };
    client.choose = async (profileId) => {
      client.click(`[data-profile-id="${profileId}"]`);
      await waitFor(() => !client.get('profile-continue').disabled, 'profile selection ready');
      client.click('#profile-continue');
      await waitFor(() => client.window.location.pathname === '/lobby', 'profile opens lobby');
      assert.deepEqual(client.visible(), ['lobby']);
    };
    clients.push(client);
    await waitFor(() => window.sessionStorage.getItem('omok-session'), 'server session');
    return client;
  }
  async function pair({ dismiss = true } = {}) {
    const a = await open();
    const b = await open();
    await a.choose('juchan');
    await b.choose('gyeonghu');
    a.click('#create-button');
    await waitFor(() => a.window.location.pathname.startsWith('/game/'));
    const code = a.get('invite-code').textContent;
    await waitFor(() => b.document.querySelector('.room-item'));
    b.click('.room-item');
    await waitFor(() => a.get('game-event-dialog').open && b.get('game-event-dialog').open);
    await waitFor(() => !a.get('game-event-primary').disabled && !b.get('game-event-primary').disabled);
    if (dismiss) { a.click('#game-event-primary'); b.click('#game-event-primary'); }
    return { a, b, code };
  }
  return { open, pair };
}

test('profile page offers four fixed names; selecting a name opens the separate lobby', async (t) => {
  const { open } = await fixture(t);
  const client = await open();
  assert.deepEqual(client.visible(), ['profile']);
  assert.equal(client.window.location.pathname, '/profile');
  assert.equal(client.get('profile-continue').disabled, true);
  assert.deepEqual([...client.document.querySelectorAll('.profile-option strong')].map((el) => el.textContent), ['주찬', '경후', '강희', '용환']);
  assert.equal(client.document.querySelector('input[autocomplete="nickname"]'), null);
  assert.equal(client.get('avatar-options'), null);
  assert.deepEqual([...client.document.querySelectorAll('.profile-face img')].map((el) => el.getAttribute('src')), [
    '/assets/avatars/juchan.png', '/assets/avatars/gyeonghu.png', '/assets/avatars/ganghui.png', '/assets/avatars/yonghwan.png',
  ]);
  await client.choose('gyeonghu');
  assert.equal(client.get('active-profile-name').textContent, '경후님');
  assert.equal(client.get('active-profile-avatar').querySelector('img').getAttribute('src'), '/assets/avatars/gyeonghu.png');
  assert.equal(client.document.activeElement.id, 'lobby-heading');
  client.click('#change-profile');
  assert.deepEqual(client.visible(), ['profile']);
  await client.choose('ganghui');
  assert.equal(client.get('active-profile-name').textContent, '강희님');
  assert.equal(client.get('active-profile-avatar').querySelector('img').getAttribute('src'), '/assets/avatars/ganghui.png');
  client.click('#change-profile');
  await client.choose('yonghwan');
  assert.equal(client.get('active-profile-name').textContent, '용환님');
  assert.equal(client.get('active-profile-avatar').querySelector('img').getAttribute('src'), '/assets/avatars/yonghwan.png');
});

test('two page instances create/join a room and play, without showing lobby forms in the game', async (t) => {
  const { open } = await fixture(t);
  const a = await open();
  const b = await open();
  await a.choose('juchan');
  await b.choose('gyeonghu');
  a.click('#create-button');
  await waitFor(() => a.window.location.pathname.startsWith('/game/'));
  const code = a.get('invite-code').textContent;
  assert.equal(a.window.location.pathname, `/game/${code}`);
  assert.deepEqual(a.visible(), ['game']);
  assert.equal(a.get('lobby-page').hidden, true);
  assert.equal(a.get('game-event-dialog').open, false);
  await waitFor(() => b.document.querySelector('.room-item'));
  b.click('.room-item');
  await waitFor(() => b.window.location.pathname === `/game/${code}`);
  await waitFor(() => a.get('status-title').textContent === '내 차례');
  assert.deepEqual(b.visible(), ['game']);
  assert.match(a.get('players').textContent, /주찬/);
  assert.match(a.get('players').textContent, /경후/);
  assert.deepEqual([...a.get('players').querySelectorAll('img')].map((el) => el.getAttribute('src')), [
    '/assets/avatars/juchan.png', '/assets/avatars/gyeonghu.png',
  ]);
  assert.equal(a.get('game-event-dialog').open, true);
  assert.equal(b.get('game-event-dialog').open, true);
  assert.equal(a.get('game-event-title').textContent, '게임시작');
  assert.equal(a.get('game-event-body').textContent, '상대를 개패볼까요?');
  assert.equal(a.get('game-event-detail'), null);
  assert.equal(a.get('game-event-primary').textContent, '시작');
  assert.equal(a.get('game-event-secondary').hidden, true);
  assert.equal(a.get('game-event-close').hidden, true);
  const cancel = new a.window.Event('cancel', { cancelable: true });
  a.get('game-event-dialog').dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true, 'start has no alternate dismiss action');
  assert.equal(a.get('game-event-dialog').open, true);
  assert.equal(a.get('game-event-players').querySelector('small').textContent, '흑 · 나');
  assert.equal(b.get('game-event-players').querySelectorAll('small')[1].textContent, '백 · 나');
  a.click('[aria-label="H8, 빈 자리"]');
  assert.equal(a.document.querySelector('.stone.preview'), null, 'start modal blocks board selection');
  await waitFor(() => !a.get('game-event-primary').disabled && !b.get('game-event-primary').disabled);
  a.click('#game-event-primary');
  b.click('#game-event-primary');
  a.click('[aria-label="H8, 빈 자리"]');
  a.click('#place-button');
  await waitFor(() => b.document.querySelector('[aria-label="H8, 흑돌, 마지막 수"]'));
  await waitFor(() => !b.get('resign-button').disabled);
  b.click('[aria-label="I8, 빈 자리"]');
  b.click('#place-button');
  await waitFor(() => a.document.querySelector('[aria-label="I8, 백돌, 마지막 수"]'));
  assert.equal(a.get('round-label').textContent, '1번째 판 · 2수');
});

test('results show different win/loss messages and both rematch actions start exactly one new round', async (t) => {
  const { pair } = await fixture(t);
  const { a, b } = await pair();
  async function play(client, coordinate, moves) {
    client.click(`[aria-label="${coordinate}, 빈 자리"]`);
    await waitFor(() => !client.get('place-button').disabled);
    client.click('#place-button');
    await waitFor(() => a.get('round-label').textContent === `1번째 판 · ${moves}수` && b.get('round-label').textContent === `1번째 판 · ${moves}수`);
    await waitFor(() => !client.get('resign-button').disabled);
  }
  for (let x = 0; x < 4; x++) {
    await play(a, `${String.fromCharCode(65 + x)}8`, x * 2 + 1);
    await play(b, `${String.fromCharCode(65 + x)}9`, x * 2 + 2);
  }
  await play(a, 'E8', 9);
  assert.equal(a.get('game-event-dialog').dataset.tone, 'win');
  assert.equal(b.get('game-event-dialog').dataset.tone, 'lose');
  assert.equal(a.get('game-event-title').textContent, '당신이 이겼습니다!');
  assert.equal(a.get('game-event-body').textContent, '엌ㅋ 개쉽노 ㅋㅋㅋ');
  assert.equal(b.get('game-event-title').textContent, '당신이 쳐 발렸습니다!');
  assert.equal(b.get('game-event-body').textContent, '엌ㅋㅋ');
  assert.equal(a.get('game-event-primary').textContent, '한판더 · 한번 더 쳐바르기');
  assert.equal(b.get('game-event-primary').textContent, '한판더 · 한번 더 쳐발리기');
  assert.equal(a.get('rematch-button').textContent, '한판더 · 한번 더 쳐바르기');
  assert.equal(b.get('rematch-button').textContent, '한판더 · 한번 더 쳐발리기');
  assert.equal(a.get('game-event-primary').hidden, false);
  assert.equal(b.get('game-event-primary').hidden, false);
  a.click('#game-event-secondary');
  a.click('#rematch-button');
  await waitFor(() => a.get('rematch-button').textContent === '상대 동의 대기');
  assert.equal(a.get('game-event-dialog').open, false, 'room updates do not repeat a dismissed result');
  assert.equal(a.get('round-label').textContent, '1번째 판 · 9수', 'one rematch request does not start a new round');
  b.click('#game-event-primary');
  await waitFor(() => a.get('round-label').textContent === '2번째 판 · 0수');
  assert.equal(a.get('game-event-dialog').dataset.tone, 'start');
  assert.equal(b.get('game-event-dialog').dataset.tone, 'start');
  assert.equal(a.get('game-event-players').querySelectorAll('small')[1].textContent, '백 · 나');
  assert.equal(b.get('game-event-players').querySelector('small').textContent, '흑 · 나');
});

test('refreshing a zero-move match and reconnecting do not repeat the starting modal', async (t) => {
  const { open, pair } = await fixture(t);
  const { a, b, code } = await pair({ dismiss: false });
  const session = Object.fromEntries(Object.entries(a.window.sessionStorage));
  a.app.destroy();
  await waitFor(() => b.get('status-title').textContent.startsWith('재접속 대기 · '));
  assert.equal(b.get('game-event-dialog').open, false);
  const resumed = await open(`/game/${code}`, { session });
  await waitFor(() => b.get('status-title').textContent === '상대 차례');
  assert.equal(resumed.get('game-event-dialog').open, false);
  assert.equal(b.get('game-event-dialog').open, false);
  assert.equal(resumed.get('round-label').textContent, '1번째 판 · 0수');
});

test('an opponent’s resignation replaces an open confirmation with one result modal', async (t) => {
  const { pair } = await fixture(t);
  const { a, b } = await pair();
  a.click('#resign-button');
  assert.equal(a.get('confirm-title').textContent, '빤스 벗고 도망가기');
  assert.equal(a.get('confirm-description'), null);
  assert.equal(a.get('confirm-action').textContent, '예');
  assert.equal(a.get('confirm-cancel').textContent, '아니오');
  a.get('confirm-dialog').close('cancel');
  assert.equal(a.get('game-event-dialog').open, false, 'canceling resignation keeps the game open');
  a.click('#resign-button');
  b.click('#resign-button');
  assert.equal(b.get('confirm-dialog').open, true);
  a.get('confirm-dialog').close('confirm');
  await waitFor(() => b.get('game-event-dialog').open);
  assert.equal(b.get('confirm-dialog').open, false);
  assert.equal(a.get('game-event-dialog').dataset.tone, 'lose');
  assert.equal(b.get('game-event-dialog').dataset.tone, 'win');
  assert.equal(b.get('game-event-title').textContent, '상대가 기권 했습니다!');
  assert.equal(b.get('game-event-detail'), null);
});

test('a replacement opponent starts a new round and replaces the departure result with a start modal', async (t) => {
  const { pair, open } = await fixture(t);
  const { a, b, code } = await pair();
  a.click('#leave-button');
  a.get('confirm-dialog').close('confirm');
  await waitFor(() => b.get('game-event-dialog').open);
  assert.equal(b.get('game-event-title').textContent, '상대가 빤스런했습니다!');
  assert.equal(b.get('game-event-body').textContent, '오목은 못하는데 도망치는건 빠르네여 ㅋㅋ');
  const c = await open(`/lobby?room=${code}`);
  await c.choose('yonghwan');
  c.click('#join-button');
  await waitFor(() => b.get('round-label').textContent === '2번째 판 · 0수');
  assert.equal(b.get('game-event-dialog').dataset.tone, 'start');
  assert.equal(c.get('game-event-dialog').dataset.tone, 'start');
  assert.equal(b.get('game-event-body').textContent, '상대를 개패볼까요?');
  assert.match(b.get('game-event-players').textContent, /용환/);
  assert.equal(b.get('game-event-players').querySelectorAll('img')[1].getAttribute('src'), '/assets/avatars/yonghwan.png');
});

test('invitation survives the required profile selection and a profile-page refresh', async (t) => {
  const { open } = await fixture(t);
  const host = await open();
  await host.choose('juchan');
  host.get('private-room').checked = true;
  host.click('#create-button');
  await waitFor(() => host.window.location.pathname.startsWith('/game/'));
  const code = host.get('invite-code').textContent;
  const invited = await open(`/lobby?room=${code}`);
  assert.deepEqual(invited.visible(), ['profile']);
  assert.equal(invited.get('room-code').value, code);
  assert.equal(invited.get('profile-invite').textContent, `초대 ${code}`);
  const session = Object.fromEntries(Object.entries(invited.window.sessionStorage));
  invited.app.destroy();
  const refreshed = await open('/profile', { session });
  await refreshed.choose('ganghui');
  assert.equal(refreshed.get('room-code').value, code);
  assert.equal(refreshed.window.location.search, `?room=${code}`);
  refreshed.click('#join-button');
  await waitFor(() => refreshed.window.location.pathname === `/game/${code}`);
  assert.equal(refreshed.window.sessionStorage.getItem('omok-invite'), null);
  assert.match(host.get('players').textContent, /강희/);
});

test('refresh restores the game and fixed profile; Back cannot silently abandon the room', async (t) => {
  const { open } = await fixture(t);
  const first = await open();
  await first.choose('ganghui');
  first.click('#create-button');
  await waitFor(() => first.window.location.pathname.startsWith('/game/'));
  const code = first.get('invite-code').textContent;
  const session = Object.fromEntries(Object.entries(first.window.sessionStorage));
  first.app.destroy();
  await delay(30);
  const refreshed = await open(`/game/${code}`, { session });
  await waitFor(() => refreshed.window.location.pathname === `/game/${code}`);
  assert.deepEqual(refreshed.visible(), ['game']);
  assert.match(refreshed.get('players').textContent, /강희/);
  refreshed.window.history.pushState(null, '', '/lobby');
  refreshed.window.dispatchEvent(new refreshed.window.PopStateEvent('popstate'));
  assert.equal(refreshed.window.location.pathname, `/game/${code}`);
  assert.deepEqual(refreshed.visible(), ['game']);
  refreshed.click('#leave-button');
  await waitFor(() => refreshed.window.location.pathname === '/lobby');
  assert.deepEqual(refreshed.visible(), ['lobby']);
  assert.equal(refreshed.get('active-profile-name').textContent, '강희님');
});
