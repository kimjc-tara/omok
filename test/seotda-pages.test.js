import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { io } from 'socket.io-client';
import { createGameServer } from '../server.js';
import { startSeotda } from '../public/seotda-app.js';
import { SEOTDA_RANKS } from '../public/seotda-ranks.js';

const html = await readFile(new URL('../public/seotda.html', import.meta.url), 'utf8');
async function waitFor(condition, message = 'page update') {
  const deadline = Date.now() + 3500;
  while (!condition()) { if (Date.now() > deadline) throw new Error(`Timed out: ${message}`); await delay(10); }
}
async function fixture(t, options = {}) {
  const server = createGameServer({ disconnectGraceMs: 1000, ...options });
  const { port } = await server.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  const clients = [];
  t.after(async () => { for (const c of clients) { c.app.destroy(); c.window.close(); } await server.close(); });
  async function open(path = '/seotda', session = {}) {
    const { window } = new JSDOM(html, { url: origin + path });
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function (value = '') { this.open = false; this.returnValue = value; this.dispatchEvent(new window.Event('close')); };
    for (const [key, value] of Object.entries(session)) window.sessionStorage.setItem(key, value);
    let socket;
    window.io = (options) => { socket = io(origin, { ...options, forceNew: true, reconnection: false, transports: ['websocket'] }); return socket; };
    const client = { window, document: window.document, app: startSeotda(window), socket };
    socket.on('room:state', (state) => { client.state = state; });
    client.get = (id) => client.document.getElementById(id);
    client.click = (id) => { const button = client.get(id); assert.ok(button); assert.notEqual(button.disabled, true, `${id} enabled`); button.click(); };
    client.choose = async (profileId) => {
      client.document.querySelector(`[data-profile-id="${profileId}"]`).click();
      await waitFor(() => !client.get('profile-continue').disabled);
      client.click('profile-continue'); await waitFor(() => !client.get('lobby-page').hidden);
    };
    clients.push(client); await waitFor(() => window.sessionStorage.getItem('omok-session'));
    return client;
  }
  async function group(count = 4) {
    const clients = [];
    for (const id of ['donghyeon', 'jiwon', 'minseo', 'ganghui'].slice(0, count)) { const client = await open(); await client.choose(id); clients.push(client); }
    const host = clients[0]; host.click('create-button'); await waitFor(() => !host.get('game-page').hidden);
    const code = host.get('invite-code').textContent;
    for (const client of clients.slice(1)) {
      client.get('room-code').value = code; client.click('join-button'); await waitFor(() => !client.get('game-page').hidden);
    }
    await waitFor(() => host.get('seat-count').textContent === `${count} / 4명`);
    host.click('start-button');
    await waitFor(() => clients.every((c) => !c.get('bet-actions').hidden));
    return { clients, host, code };
  }
  return { open, group };
}

test('four Seotda screens deal two cards, label the own rank underneath, bet and reveal the result', async (t) => {
  const { group } = await fixture(t);
  const { clients, host } = await group();
  const [a, b, c, d] = clients;
  const originalCards = a.get('own-seat').querySelectorAll('.playing-card');
  for (const client of clients) {
    assert.equal(client.get('own-seat').querySelectorAll('.face-up').length, 2);
    assert.ok(client.get('own-seat').querySelector('.seat-rank').textContent);
    const current = client.get('rank-board').querySelector('[aria-current="true"]');
    assert.ok(current, 'the own rank is highlighted on the permanent guide');
    const index = SEOTDA_RANKS.findIndex((rank) => rank.score === Number(current.dataset.rankScore));
    assert.equal(client.get('guide-current-rank').textContent, client.get('own-seat').querySelector('.seat-rank').textContent);
    assert.equal(client.get('guide-stronger').textContent, index > 0 ? SEOTDA_RANKS[index - 1].name : '없음 · 가장 강함');
    assert.equal(client.get('guide-weaker').textContent, index < SEOTDA_RANKS.length - 1 ? SEOTDA_RANKS[index + 1].name : '없음 · 가장 약함');
    assert.equal(client.get('wallet-balance').textContent, '990 칩');
    assert.equal(client.get('wallet-hand-value').textContent, '10 칩');
    assert.equal(client.get('own-seat').querySelector('.seat-rank').previousElementSibling.className, 'seat-cards');
    assert.equal(client.get('opponent-seats').querySelectorAll('.face-up').length, 0);
    assert.equal(client.document.querySelectorAll('.playing-card.dealing').length, 8);
    assert.equal(client.document.querySelectorAll('.playing-card[aria-label="비공개 패"]').length, 6);
    assert.equal(client.get('pot-value').textContent, '40');
    assert.equal(client.get('rank-board').closest('.own-hand-area'), client.get('own-seat').parentElement);
    assert.equal(client.document.querySelector('.game-sidebar .hand-guide'), null);
    assert.equal(client.document.querySelector('.game-sidebar').firstElementChild.classList.contains('chat-card'), true);
  }
  assert.equal(b.get('start-button').hidden, true);
  assert.equal(a.get('turn-label').textContent, '내 차례');
  assert.equal(b.get('call-button').disabled, true);
  a.click('raise-50'); await waitFor(() => !b.get('call-button').disabled);
  assert.equal(a.get('own-seat').querySelector('.seat-action').textContent, '레이즈 +50');
  assert.equal(a.get('own-seat').querySelector('.seat-action').dataset.action, 'raise');
  assert.equal(b.get('opponent-seats').querySelector('.seat-action').textContent, '레이즈 +50');
  assert.equal(a.get('wallet-balance').textContent, '940 칩');
  assert.equal(a.get('wallet-hand-value').textContent, '60 칩');
  assert.equal(b.get('call-button').textContent, '콜 50');
  assert.equal(a.get('own-seat').querySelector('.playing-card'), originalCards[0], 'updates preserve dealt card nodes');
  b.click('call-button'); await waitFor(() => !c.get('fold-button').disabled);
  assert.equal(b.get('own-seat').querySelector('.seat-action').textContent, '콜 50');
  c.click('fold-button'); await waitFor(() => !d.get('call-button').disabled);
  assert.equal(c.get('own-seat').querySelector('.seat-action').textContent, '다이');
  d.click('call-button');
  await waitFor(() => a.get('opponent-seats').querySelectorAll('.face-up').length === 4);
  for (const client of clients) {
    assert.equal(client.get('result').hidden, true, 'hands are visible before the outcome');
    assert.equal(client.get('turn-label').textContent, '패 공개 중');
    assert.equal(client.get('wallet-profit').textContent, '0 칩', 'settled gains do not spoil the reveal');
    assert.equal(client.get('wallet-hand-label').textContent, '이번 판 베팅');
  }
  assert.equal(a.get('wallet-balance').textContent, '940 칩');
  assert.equal(a.get('start-button').disabled, true);
  await waitFor(() => clients.every((c) => !c.get('result').hidden));
  for (const client of clients) {
    assert.equal(client.get('result').parentElement.className, 'table-center');
    const change = Number(client.get('result-body').textContent.replace(/[^\d-]/g, ''));
    assert.equal(client.get('result-title').textContent, change > 0 ? 'WIN!' : change < 0 ? 'LOSE' : 'DRAW');
    assert.equal(client.get('result').dataset.outcome, change > 0 ? 'win' : change < 0 ? 'lose' : 'draw');
  }
  assert.equal(a.get('pot-value').textContent, '190');
  assert.equal(a.get('opponent-seats').querySelectorAll('.face-up').length, 4, 'folded opponent stays hidden');
  assert.equal(a.get('bet-actions').hidden, true);
  assert.equal(a.get('wallet-hand-label').textContent, '이번 판 손익');
  assert.match(a.get('turn-label').textContent, /초 후 다음 판/);
  host.click('start-button'); await waitFor(() => a.get('round-label').textContent === '2번째 판');
  assert.equal(a.get('result').hidden, true);
  assert.equal(b.get('turn-label').textContent, '내 차례');
  assert.equal(a.get('opponent-seats').querySelectorAll('.face-up').length, 0);
});

test('Seotda refresh keeps own hand without redealing; chat is plain text and leaving confirms', async (t) => {
  const { group, open } = await fixture(t);
  const { clients: [a, b], code } = await group(2);
  const rank = b.get('own-seat').querySelector('.seat-rank').textContent;
  const session = Object.fromEntries(Object.entries(b.window.sessionStorage));
  b.app.destroy(); await delay(20);
  const refreshed = await open(`/seotda/game/${code}`, session);
  await waitFor(() => !refreshed.get('game-page').hidden);
  assert.equal(refreshed.get('own-seat').querySelector('.seat-rank').textContent, rank);
  assert.equal(refreshed.document.querySelectorAll('.playing-card.dealing').length, 0);
  a.get('chat-input').value = '<img src=x onerror=alert(1)> ㄱㄱ';
  a.get('chat-input').dispatchEvent(new a.window.Event('input')); a.click('chat-send');
  await waitFor(() => refreshed.get('chat-log').children.length === 1);
  assert.equal(refreshed.get('chat-log').querySelector('img'), null);
  assert.equal(refreshed.get('chat-log').querySelector('strong').textContent, '동현');
  refreshed.click('leave-button'); assert.equal(refreshed.get('confirm-dialog').open, true);
  refreshed.click('confirm-no'); assert.equal(refreshed.get('game-page').hidden, false);
  refreshed.click('leave-button'); refreshed.click('confirm-yes');
  await waitFor(() => !refreshed.get('lobby-page').hidden);
  await waitFor(() => !a.get('result').hidden);
  assert.equal(refreshed.get('chat-log').children.length, 0);
  assert.equal(refreshed.get('lobby-balance').textContent, '잔고 990 칩');
  assert.equal(a.get('wallet-balance').textContent, '1,010 칩');
  assert.equal(a.get('wallet-profit').textContent, '+10 칩');
  assert.equal(a.get('result-title').textContent, 'WIN!');
  assert.equal(a.get('result-body').textContent, '+10 칩');
});

test('Seotda invite survives profile selection and lists only Seotda rooms', async (t) => {
  const { open } = await fixture(t);
  const host = await open(); await host.choose('donghyeon'); host.click('create-button');
  await waitFor(() => !host.get('game-page').hidden);
  const code = host.get('invite-code').textContent;
  const invited = await open(`/seotda?room=${code}`);
  assert.equal(invited.get('profile-page').hidden, false);
  await invited.choose('minseo');
  assert.equal(invited.get('room-code').value, code);
  assert.equal(invited.window.location.search, `?room=${code}`);
  await waitFor(() => invited.get('room-list').querySelector('button'));
  invited.get('room-list').querySelector('button').click();
  await waitFor(() => !invited.get('game-page').hidden);
  assert.equal(host.get('start-button').disabled, false);
  assert.equal(invited.get('opponent-seats').querySelectorAll('.empty-seat').length, 2);
});

test('showdown survives refresh, then shows a result before the automatic next deal', async (t) => {
  const { group, open } = await fixture(t, { seotdaShowdownMs: 500, seotdaNextRoundMs: 220 });
  const { clients: [a, b], code } = await group(2);
  a.click('call-button');
  await waitFor(() => !b.get('call-button').disabled);
  b.click('call-button');
  await waitFor(() => a.state?.game.status === 'finished');
  const resultAt = a.state.game.resultAt;
  assert.ok(resultAt > Date.now());
  assert.equal(a.state.nextRoundAt - resultAt, 220);
  assert.equal(a.get('opponent-seats').querySelectorAll('.face-up').length, 2);
  assert.equal(a.get('result').hidden, true);
  const earlyStart = await a.socket.timeout(1500).emitWithAck('seotda:start', {});
  assert.equal(earlyStart.ok, false, 'manual start cannot skip the hand reveal');
  const session = Object.fromEntries(Object.entries(b.window.sessionStorage));
  b.app.destroy();
  await delay(20);
  const refreshed = await open(`/seotda/game/${code}`, session);
  await waitFor(() => !refreshed.get('game-page').hidden);
  assert.equal(refreshed.state.game.resultAt, resultAt, 'refresh keeps the original result deadline');
  assert.equal(refreshed.get('result').hidden, true);
  assert.equal(refreshed.get('wallet-balance').textContent, '990 칩');
  assert.equal(refreshed.get('wallet-profit').textContent, '0 칩');
  assert.equal(refreshed.get('opponent-seats').querySelectorAll('.face-up').length, 2);
  await waitFor(() => !a.get('result').hidden && !refreshed.get('result').hidden);
  assert.ok(Date.now() >= resultAt);
  assert.equal(a.state.game.round, 1);
  assert.equal(a.get('wallet-hand-label').textContent, '이번 판 손익');
  await waitFor(() => a.state.game.round === 2 && refreshed.state.game.round === 2);
  assert.ok(Date.now() >= resultAt + 220);
  assert.equal(a.get('result').hidden, true);
  assert.equal(refreshed.get('opponent-seats').querySelectorAll('.face-up').length, 0);
});

test('raises remain enabled beyond three and all-in actions appear above both profiles', async (t) => {
  const { group } = await fixture(t, { seotdaShowdownMs: 100 });
  const { clients: [a, b] } = await group(2);
  for (let step = 0; step < 4; step++) {
    const actor = step % 2 === 0 ? a : b;
    await waitFor(() => !actor.get('raise-50').disabled);
    actor.click('raise-50');
    await waitFor(() => a.state.game.version === step + 1 && b.state.game.version === step + 1);
    assert.equal(actor.get('own-seat').querySelector('.seat-action').textContent, '레이즈 +50');
  }
  assert.equal(a.get('raise-50').disabled, false);
  assert.equal(a.get('all-in-button').textContent, '올인 840');
  a.click('all-in-button');
  await waitFor(() => !b.get('call-button').disabled);
  assert.equal(a.get('own-seat').querySelector('.seat-action').textContent, '올인 840');
  assert.equal(b.get('opponent-seats').querySelector('.seat-action').dataset.action, 'all-in');
  assert.equal(b.get('call-button').textContent, '올인 콜 790');
  assert.equal(b.get('raise-50').disabled, true, 'a zero-stack opponent cannot be raised');
  b.click('call-button');
  await waitFor(() => b.state.game.status === 'finished');
  assert.equal(b.get('own-seat').querySelector('.seat-action').textContent, '올인 790');
  assert.equal(a.state.game.pot, 2000);
  await waitFor(() => !a.get('result').hidden && !b.get('result').hidden);
});

test('a mid-game entrant waits for the next hand and the non-host winner can start it', async (t) => {
  const { group, open } = await fixture(t, { seotdaNextRoundMs: 80 });
  const { clients: [a, b] } = await group(2);
  const entrant = await open(); await entrant.choose('minseo');
  await waitFor(() => entrant.get('room-list').querySelector('button'));
  assert.match(entrant.get('room-list').textContent, /관전 후 참가/);
  entrant.get('room-list').querySelector('button').click();
  await waitFor(() => !entrant.get('game-page').hidden);
  assert.equal(entrant.get('own-seat').querySelectorAll('.playing-card').length, 0);
  assert.equal(entrant.get('turn-label').textContent, '다음 판 참가 대기');
  assert.equal(entrant.get('bet-actions').hidden, true);
  assert.equal(entrant.get('start-button').hidden, true);
  assert.equal(a.get('auto-next-status').textContent, '시작 버튼 대기');
  a.click('fold-button');
  await waitFor(() => !b.get('result').hidden);
  assert.equal(b.get('result-title').textContent, 'WIN!');
  assert.equal(entrant.get('result').hidden, true, 'a waiting entrant has no personal win or loss');
  assert.equal(b.get('start-button').hidden, false);
  await delay(120);
  assert.equal(b.state.game.round, 1, 'roster changes keep automatic restart paused');
  b.click('start-button');
  await waitFor(() => entrant.state.game.round === 2);
  assert.equal(entrant.get('own-seat').querySelectorAll('.playing-card').length, 2);
  assert.equal(entrant.state.startRequired, false);
});

test('refill allows copying the prompt but blocks paste/drop and repeatedly grants 1000 chips for typed answers', async (t) => {
  const { open } = await fixture(t);
  const client = await open(); await client.choose('minseo');
  assert.equal(client.get('refill-button').previousElementSibling.id, 'create-form');
  for (let count = 1; count <= 2; count++) {
    client.click('refill-button');
    await waitFor(() => client.get('refill-dialog').open);
    const prompt = client.get('refill-phrase');
    const originalText = prompt.textContent;
    client.get('refill-input').value = originalText.slice(0, 1);
    client.get('refill-input').dispatchEvent(new client.window.Event('input'));
    client.click('refill-change');
    await waitFor(() => prompt.textContent !== originalText);
    assert.equal(client.get('refill-dialog').open, true);
    assert.equal(client.get('refill-input').value, '');
    assert.equal(client.get('refill-submit').disabled, true);
    const copy = new client.window.Event('copy', { cancelable: true });
    prompt.dispatchEvent(copy);
    assert.equal(copy.defaultPrevented, false);
    for (const type of ['paste', 'drop']) {
      const event = new client.window.Event(type, { cancelable: true });
      client.get('refill-input').dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
      assert.equal(client.get('refill-paste-warning').hidden, false);
      assert.equal(client.get('refill-paste-warning').textContent, 'ㅋㅋ 복붙이 되겠노?^^');
    }
    const beforeInput = new client.window.InputEvent('beforeinput', { inputType: 'insertFromPaste', data: prompt.textContent, cancelable: true });
    client.get('refill-input').dispatchEvent(beforeInput);
    assert.equal(beforeInput.defaultPrevented, true);
    assert.equal(client.get('refill-input').value, '');
    client.get('refill-input').value = prompt.textContent;
    client.get('refill-input').dispatchEvent(new client.window.Event('compositionstart'));
    client.get('refill-input').dispatchEvent(new client.window.Event('input'));
    assert.equal(client.get('refill-submit').disabled, true);
    client.get('refill-input').dispatchEvent(new client.window.Event('compositionend'));
    client.click('refill-submit');
    await waitFor(() => !client.get('refill-dialog').open);
    assert.equal(client.get('lobby-balance').textContent, `잔고 ${(1000 + count * 1000).toLocaleString('ko-KR')} 칩`);
    assert.equal(client.get('wallet-profit').textContent, '0 칩');
  }
});

test('a bankrupt all-in loser is kicked after the result, blocked from entry, and can refill to return', async (t) => {
  const { group, open } = await fixture(t, { seotdaShowdownMs: 0, seotdaNextRoundMs: 180 });
  const { clients: [a, b], code } = await group(2);
  for (let attempt = 0; a.state.game.players[0].rankScore === b.state.game.players[1].rankScore; attempt++) {
    assert.ok(attempt < 10, 'obtain a non-tied hand for bankruptcy');
    for (let action = 0; action < 2; action++) {
      const actor = a.state.game.turn === 1 ? a : b;
      actor.click('call-button');
      await waitFor(() => a.state.game.version === action + 1 && b.state.game.version === action + 1);
    }
    a.click('start-button');
    await waitFor(() => a.state.game.status === 'playing' && b.state.game.status === 'playing');
  }
  const loser = a.state.game.players[0].rankScore < b.state.game.players[1].rankScore ? a : b;
  const winner = loser === a ? b : a;
  const first = a.state.game.turn === 1 ? a : b;
  const second = first === a ? b : a;
  first.click('all-in-button');
  await waitFor(() => !second.get('call-button').disabled);
  second.click('call-button');
  await waitFor(() => !loser.get('result').hidden);
  assert.equal(loser.get('result-title').textContent, 'LOSE');
  assert.equal(loser.get('wallet-balance').textContent, '0 칩');
  await waitFor(() => loser.get('account-dialog').open);
  assert.equal(loser.get('account-title').textContent, '꺼져 쉐끼야 ㅋㅋ');
  assert.equal(loser.get('lobby-page').hidden, false);
  assert.equal(winner.state.nextRoundAt, null);
  const session = Object.fromEntries(Object.entries(loser.window.sessionStorage));
  loser.app.destroy(); await delay(20);
  const refreshed = await open('/seotda', session);
  await waitFor(() => refreshed.get('account-dialog').open);
  assert.equal(refreshed.get('account-title').textContent, '꺼져 쉐끼야 ㅋㅋ');
  refreshed.click('account-close');
  await waitFor(() => !refreshed.get('create-button').disabled);
  refreshed.click('create-button');
  await waitFor(() => refreshed.get('account-dialog').open);
  assert.equal(refreshed.get('account-title').textContent, '님은 잔고 충전부터 하고오셔야 할듯ㅎㅎ');
  refreshed.click('account-close');
  refreshed.get('room-code').value = code;
  refreshed.click('join-button');
  await waitFor(() => refreshed.get('account-dialog').open);
  assert.equal(refreshed.get('account-title').textContent, '님은 잔고 충전부터 하고오셔야 할듯ㅎㅎ');
  refreshed.click('account-close');
  refreshed.click('refill-button');
  await waitFor(() => refreshed.get('refill-dialog').open);
  refreshed.get('refill-input').value = refreshed.get('refill-phrase').textContent;
  refreshed.get('refill-input').dispatchEvent(new refreshed.window.Event('input'));
  refreshed.click('refill-submit');
  await waitFor(() => !refreshed.get('refill-dialog').open);
  assert.equal(refreshed.get('lobby-balance').textContent, '잔고 1,000 칩');
  refreshed.click('join-button');
  await waitFor(() => !refreshed.get('game-page').hidden);
});
