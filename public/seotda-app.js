import { PROFILES, findProfile } from './profiles.js';
import { avatarImage } from './avatars.js';
import { SEOTDA_RANKS } from './seotda-ranks.js';
import { sessionAuth, navigateWithSession } from './session-navigation.js';

export function startSeotda(window) {
  const { document, location, history } = window;
  const $ = (id) => document.getElementById(id);
  const read = (area, key) => { try { return window[area].getItem(key); } catch { return null; } };
  const write = (area, key, value) => { try { window[area].setItem(key, value); } catch { /* Storage is optional. */ } };
  const remove = (area, key) => { try { window[area].removeItem(key); } catch { /* Storage is optional. */ } };
  let saved;
  try { saved = JSON.parse(read('localStorage', 'omok-profile')); } catch { /* Use defaults. */ }
  let selectedProfile = findProfile(saved?.profileId)?.profileId;
  let activeProfile = null, playerId = null, room = null, online = false, ready = false, busy = false, editing = false;
  let wallet = null;
  let refillChallenge = null;
  let composingRefill = false;
  let pasteWarningTimer;
  let pendingKick = null;
  let noticeKickId = null;
  let resultTimer;
  let messages = [], chatBusy = false, page = null, toastTimer, animateDeal = false;
  let pendingCode = new URL(location.href).searchParams.get('room') || location.pathname.match(/\/game\/([A-Z2-9]{6})/)?.[1] || read('sessionStorage', 'seotda-invite') || '';
  pendingCode = /^[A-Z2-9]{6}$/.test(pendingCode.toUpperCase()) ? pendingCode.toUpperCase() : '';
  if (pendingCode) { write('sessionStorage', 'seotda-invite', pendingCode); $('room-code').value = pendingCode; }
  const socket = window.io({ autoConnect: false, auth: sessionAuth(window) });

  function toast(text) {
    $('toast').textContent = text; $('toast').hidden = false;
    window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 5000);
  }
  async function request(event, data = {}) {
    if (!online || busy) return null;
    busy = true; controls();
    try {
      return await new Promise((resolve) => socket.timeout(5000).emit(event, data, (error, result) => {
        if (error || !result?.ok) {
          if (result?.code === 'INSUFFICIENT_CHIPS') showAccountNotice(result.error);
          else toast(result?.error || '서버 응답 지연');
          resolve(null);
        }
        else resolve(result);
      }));
    } finally { busy = false; controls(); }
  }
  function showAccountNotice(message, kickId = null) {
    for (const id of ['refill-dialog', 'rules-dialog', 'confirm-dialog']) if ($(id).open) $(id).close('no');
    $('account-title').textContent = message;
    noticeKickId = kickId;
    if (!$('account-dialog').open) $('account-dialog').showModal();
  }
  $('account-close').addEventListener('click', () => $('account-dialog').close());
  $('account-dialog').addEventListener('close', () => {
    const id = noticeKickId;
    noticeKickId = null;
    if (id) {
      pendingKick = null;
      request('seotda:kick:ack', { id });
    }
  });
  async function loadRefillChallenge() {
    const result = await request('wallet:challenge');
    if (!result) return;
    refillChallenge = result.challenge;
    composingRefill = false;
    $('refill-phrase').textContent = refillChallenge.text;
    $('refill-input').value = '';
    $('refill-error').hidden = true;
    $('refill-paste-warning').hidden = true;
    window.clearTimeout(pasteWarningTimer);
    controls();
    if (!$('refill-dialog').open) $('refill-dialog').showModal();
    $('refill-input').focus();
  }
  $('refill-button').addEventListener('click', loadRefillChallenge);
  $('refill-change').addEventListener('click', loadRefillChallenge);
  $('refill-cancel').addEventListener('click', () => $('refill-dialog').close());
  function rejectPaste(event) {
    event.preventDefault();
    $('refill-paste-warning').hidden = false;
    window.clearTimeout(pasteWarningTimer);
    pasteWarningTimer = window.setTimeout(() => { $('refill-paste-warning').hidden = true; }, 2000);
  }
  for (const event of ['paste', 'drop']) $('refill-input').addEventListener(event, rejectPaste);
  $('refill-input').addEventListener('dragover', (event) => event.preventDefault());
  $('refill-input').addEventListener('beforeinput', (event) => {
    if (['insertFromPaste', 'insertFromPasteAsQuotation', 'insertFromDrop'].includes(event.inputType)) rejectPaste(event);
  });
  $('refill-input').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v' || event.shiftKey && event.key === 'Insert') rejectPaste(event);
  });
  $('refill-input').addEventListener('input', () => { $('refill-error').hidden = true; controls(); });
  $('refill-input').addEventListener('compositionstart', () => { composingRefill = true; controls(); });
  $('refill-input').addEventListener('compositionend', () => { composingRefill = false; controls(); });
  $('refill-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!refillChallenge || composingRefill || $('refill-input').value.normalize('NFC') !== refillChallenge.text) return;
    const result = await request('wallet:refill', { id: refillChallenge.id, text: $('refill-input').value });
    if (!result) { $('refill-error').textContent = '충전 실패. 다시 시도해 주세요.'; $('refill-error').hidden = false; return; }
    wallet = result.wallet;
    refillChallenge = null;
    $('refill-dialog').close();
    renderWallet();
    toast('1,000칩 충전 완료');
  });
  function navigate() {
    const next = !ready || !activeProfile || editing ? 'profile' : room ? 'game' : 'lobby';
    for (const id of ['profile', 'lobby', 'game']) $(`${id}-page`).hidden = next !== id;
    const path = room ? `/seotda/game/${room.code}` : pendingCode ? `/seotda?room=${pendingCode}` : '/seotda';
    if (location.pathname + location.search !== path) history.replaceState(null, '', path);
    document.title = `${next === 'profile' ? '프로필 선택' : '섯다'} | 타라미니게임천국`;
    if (page !== next && ready) $(`${next}-heading`).focus({ preventScroll: true });
    page = next;
  }

  for (const preset of PROFILES) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'profile-option'; button.dataset.profileId = preset.profileId;
    button.setAttribute('aria-label', `${preset.name} 선택`);
    button.innerHTML = `<span class="profile-face">${avatarImage(preset.avatar)}</span><strong>${preset.name}</strong>`;
    button.addEventListener('click', () => { selectedProfile = preset.profileId; renderProfile(); controls(); });
    $('profile-options').append(button);
  }
  function renderProfile() {
    for (const button of $('profile-options').children) button.setAttribute('aria-pressed', String(button.dataset.profileId === selectedProfile));
    if (activeProfile) {
      $('profile-name').textContent = `${activeProfile.name}님`;
      $('profile-avatar').innerHTML = avatarImage(activeProfile.avatar);
    }
  }
  for (const group of ['bright', 'pair', 'special', 'point']) {
    const family = document.createElement('li');
    family.className = 'rank-family';
    const compact = group === 'pair' || group === 'point';
    if (compact) {
      const title = document.createElement('p');
      title.className = 'rank-family-label';
      title.textContent = group === 'pair' ? '땡 · 같은 월 두 장' : '끗 · 합의 끝자리';
      family.append(title);
    }
    const entries = document.createElement('div');
    entries.className = compact ? 'rank-grid' : 'rank-rows';
    for (const rank of SEOTDA_RANKS.filter((entry) => entry.group === group)) {
      const item = document.createElement('div');
      item.className = 'guide-rank';
      item.dataset.rankScore = rank.score;
      item.title = `${rank.name} · ${rank.combination}`;
      const name = document.createElement('strong');
      name.textContent = compact && rank.score === 9 ? '갑오' : rank.name;
      item.append(name);
      if (!compact) {
        const combination = document.createElement('span');
        combination.textContent = rank.combination;
        item.append(combination);
      }
      entries.append(item);
    }
    family.append(entries);
    $('rank-board').append(family);
  }
  function renderHandGuide(hand) {
    const score = hand?.rankScore;
    const index = SEOTDA_RANKS.findIndex((rank) => rank.score === score);
    $('guide-current-rank').textContent = hand?.rank || '패 받기 대기';
    $('guide-neighbors').hidden = index < 0;
    $('guide-stronger').textContent = index > 0 ? SEOTDA_RANKS[index - 1].name : '없음 · 가장 강함';
    $('guide-weaker').textContent = index >= 0 && index < SEOTDA_RANKS.length - 1 ? SEOTDA_RANKS[index + 1].name : '없음 · 가장 약함';
    for (const item of $('rank-board').querySelectorAll('[data-rank-score]')) {
      const current = index >= 0 && Number(item.dataset.rankScore) === score;
      item.classList.toggle('is-current', current);
      if (current) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
    const board = $('rank-board');
    const handKey = `${room.code}/${room.game.round}/${score}`;
    if (board.dataset.handKey !== handKey) {
      board.dataset.handKey = handKey;
      const current = board.querySelector('[aria-current="true"]');
      board.scrollTop = current ? Math.max(0, current.offsetTop - (board.clientHeight - current.offsetHeight) / 2) : 0;
    }
  }
  function renderWallet() {
    const currentWallet = room?.wallet ?? wallet;
    const color = room?.players.find((player) => player.id === playerId)?.color;
    const hand = room?.game.players.find((player) => player.color === color);
    const payout = room?.game.payouts[color] || 0;
    const pending = awaitingResult();
    const balance = pending && hand ? hand.chips - payout : currentWallet?.balance ?? 0;
    const profit = (currentWallet?.totalProfit ?? 0) - (pending && hand ? payout - hand.committed : 0);
    $('lobby-balance').textContent = `잔고 ${balance.toLocaleString('ko-KR')} 칩`;
    $('wallet-balance').textContent = `${balance.toLocaleString('ko-KR')} 칩`;
    $('wallet-profit').textContent = `${profit > 0 ? '+' : ''}${profit.toLocaleString('ko-KR')} 칩`;
    $('wallet-profit').dataset.change = profit > 0 ? 'positive' : profit < 0 ? 'negative' : 'even';
    const settled = room?.game.status === 'finished' && !pending;
    const amount = settled ? (room.game.payouts[color] || 0) - (hand?.committed || 0) : hand?.committed || 0;
    $('wallet-hand-label').textContent = settled ? '이번 판 손익' : '이번 판 베팅';
    $('wallet-hand-value').textContent = `${settled && amount > 0 ? '+' : ''}${amount.toLocaleString('ko-KR')} 칩`;
  }
  function awaitingResult() {
    return room?.game.status === 'finished' && room.game.resultAt > Date.now();
  }
  function scheduleResult() {
    window.clearTimeout(resultTimer);
    if (!awaitingResult()) return;
    resultTimer = window.setTimeout(() => {
      if (awaitingResult()) scheduleResult();
      else render();
    }, Math.max(1, room.game.resultAt - Date.now()));
  }
  $('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!findProfile(selectedProfile)) return;
    const result = await request('profile:set', { profileId: selectedProfile });
    if (!result) return;
    activeProfile = result.profile; editing = false;
    write('localStorage', 'omok-profile', JSON.stringify({ profileId: selectedProfile }));
    render();
  });
  $('change-profile').addEventListener('click', () => { editing = true; render(); });

  function controls() {
    $('profile-continue').disabled = !online || !ready || busy || !selectedProfile;
    for (const button of $('profile-options').children) button.disabled = busy;
    for (const id of ['create-button', 'join-button', 'refresh-rooms']) $(id).disabled = !online || !ready || busy || !activeProfile;
    $('refill-button').disabled = !online || !ready || busy || !activeProfile;
    $('refill-change').disabled = !online || !ready || busy || !activeProfile;
    $('refill-submit').disabled = !online || busy || composingRefill || !refillChallenge || $('refill-input').value.normalize('NFC') !== refillChallenge.text;
    $('leave-button').disabled = !online || busy;
    $('chat-input').disabled = !room || !online || chatBusy;
    $('chat-send').disabled = !room || !online || chatBusy || !$('chat-input').value.trim();
    const game = room?.game;
    const self = game?.players.find((p) => p.color === room.players.find((p) => p.id === playerId)?.color);
    const host = room?.hostId === playerId;
    const mayStart = room?.canStart ?? host;
    const everyoneOnline = room?.players.every((p) => p.connected);
    const activePlayersOnline = room?.players.every((player) => player.connected || !game.players.some((hand) => hand.color === player.color && !hand.folded));
    $('auto-next').checked = Boolean(room?.autoNext);
    $('auto-next').disabled = !host || !online || busy;
    $('auto-next-status').textContent = room?.startRequired ? '시작 버튼 대기' : room?.autoNext ? '켜짐' : '꺼짐';
    const playing = game?.status === 'playing';
    const turn = playing && game.turn === self?.color && !self?.folded && activePlayersOnline;
    const due = self ? Math.max(0, game.currentBet - self.committed) : 0;
    $('start-button').hidden = !room || playing || !mayStart;
    $('start-button').disabled = !online || busy || !everyoneOnline || awaitingResult() || (room?.players.length || 0) < 2;
    $('start-button').textContent = game?.round && !room.startRequired ? '한판더 · 패 돌리기' : '게임 시작';
    $('bet-actions').hidden = !playing || !self;
    $('call-button').textContent = due ? self?.chips <= due ? `올인 콜 ${self.chips}` : `콜 ${due}` : '체크';
    $('call-button').disabled = !online || busy || !turn;
    $('fold-button').disabled = !online || busy || !turn;
    const raisable = game?.players.some((p) => p.color !== self?.color && !p.folded && p.chips > 0);
    for (const amount of [10, 50]) $(`raise-${amount}`).disabled = !online || busy || !turn || !raisable || self.chips < due + amount;
    $('all-in-button').textContent = `올인 ${self?.chips ?? 0}`;
    $('all-in-button').disabled = !online || busy || !turn || !self?.chips || !raisable && self.chips > due;
    let label = !online ? '서버 연결 중' : !playing ? room?.players.length < 2 ? '상대 입장 대기' : host ? '모였으면 패 돌리기' : '방장 시작 대기' : self?.folded ? '다이 · 이번 판 구경 중' : turn ? '내 차례' : `${room.players.find((p) => p.color === game.turn)?.name || '상대'}님 차례`;
    const disconnected = room?.players.find((p) => !p.connected && (!playing || game.players.some((hand) => hand.color === p.color && !hand.folded)));
    if (disconnected) label = `${disconnected.name}님 재접속 대기 · ${Math.max(0, Math.ceil((disconnected.reconnectDeadline - Date.now()) / 1000))}초`;
    if (game?.status === 'finished' && !disconnected) {
      label = mayStart ? room.startRequired ? '게임 시작 대기' : '다음 판도 갈까요?' : '다음 판 시작 대기';
    }
    if (room?.nextRoundAt && !disconnected) {
      label = `${Math.max(0, Math.ceil((room.nextRoundAt - Date.now()) / 1000))}초 후 다음 판`;
    }
    if (awaitingResult() && !disconnected) label = '패 공개 중';
    if (room && game.players.length && !self) label = '다음 판 참가 대기';
    $('turn-label').textContent = label;
  }

  // Original, simple vector card illustrations: each month has its own flower/tree motif.
  function cardArt(card) {
    const colors = ['#3c6140', '#ab3548', '#d75a70', '#754c83', '#466da2', '#af3f62', '#507a58', '#657964', '#bf963d', '#c7492d'];
    const month = card.month, color = colors[month - 1];
    const petals = month === 1 || month === 8 ? `<path d="M0 65L16 36 29 56 44 28 62 66V100H0Z" fill="${color}"/><path d="M18 100L27 40M32 100L44 32" stroke="#272d21" stroke-width="4"/>` : `<path d="M15 100Q44 62 24 25M32 95Q10 67 49 42" fill="none" stroke="#38543a" stroke-width="4"/>${[[23,34],[43,53],[17,69],[38,80]].map(([x,y],i) => `<g fill="${color}" stroke="#321e22" stroke-width=".8"><circle cx="${x}" cy="${y}" r="9"/><circle cx="${x-6}" cy="${y+3}" r="6"/><circle cx="${x+6}" cy="${y+3}" r="6"/><circle cx="${x}" cy="${y}" r="2" fill="#f7d981"/></g>`).join('')}`;
    return `<svg viewBox="0 0 62 100" aria-hidden="true"><path fill="#fff4d4" d="M0 0h62v100H0z"/>${card.bright ? '<circle cx="42" cy="24" r="16" fill="#d94330"/>' : ''}${petals}${card.id % 2 ? '<path d="M5 17h18v40H5z" fill="#ad302c"/><path d="M9 24h10m-10 7h10m-10 7h10" stroke="#fff3d4" stroke-width="2"/>' : ''}</svg>`;
  }
  function revealCard(element, card) {
    if (!card || element.classList.contains('face-up')) return;
    element.classList.add('face-up');
    element.setAttribute('aria-label', `${card.month}월${card.bright ? ' 광' : ''}`);
    const front = element.querySelector('.card-front');
    front.innerHTML = `${cardArt(card)}<span class="card-month">${card.month}월</span>${card.bright ? '<span class="card-bright">光</span>' : ''}`;
  }
  function seatElement(player, own, index, animate) {
    const game = room.game;
    const hand = game.players.find((p) => p.color === player.color);
    const key = `${room.code}/${game.round}/${player.id}`;
    const container = own ? $('own-seat') : $('opponent-seats');
    let element = [...container.children].find((el) => el.dataset.seatKey === key);
    const fresh = !element;
    if (fresh) {
      element = document.createElement('article'); element.className = 'seotda-seat'; element.dataset.seatKey = key;
      element.innerHTML = `<div class="seat-action-slot"><div class="seat-action" role="status" aria-live="polite" aria-atomic="true" hidden></div></div><div class="seat-head">${avatarImage(player.avatar)}<div><strong></strong><small></small></div></div><div class="seat-contribution"></div><div class="seat-cards" aria-label="${own ? '내 패' : '상대 패'}"></div><div class="seat-rank"></div>`;
      element.querySelector('.seat-action').addEventListener('animationend', (event) => {
        if (event.animationName === 'action-pop') event.currentTarget.classList.remove('popping');
      });
    }
    element.dataset.playerId = player.id;
    element.classList.toggle('current', game.status === 'playing' && game.turn === player.color);
    element.classList.toggle('folded', Boolean(hand?.folded));
    element.querySelector('strong').textContent = `${player.name}${own ? ' · 나' : ''}${player.id === room.hostId ? ' · 방장' : ''}`;
    const chips = (hand?.chips ?? player.chips) - (awaitingResult() ? game.payouts[player.color] || 0 : 0);
    element.querySelector('small').textContent = `${chips} 칩`;
    element.querySelector('.seat-contribution').textContent = hand ? `낸 칩 ${hand.committed}` : game.players.length ? '다음 판 참가' : '대기 중';
    const bubble = element.querySelector('.seat-action');
    const actionType = player.connected ? hand?.actionType || 'ready' : 'disconnect';
    const actionText = player.connected ? hand?.action || '' : '재접속 중';
    bubble.hidden = actionType === 'ready';
    if (bubble.textContent !== actionText) bubble.textContent = actionText;
    bubble.dataset.action = actionType;
    const actionKey = `${hand?.actionVersion ?? actionText}/${player.connected}`;
    if (!bubble.hidden && bubble.dataset.actionKey !== actionKey) {
      bubble.dataset.actionKey = actionKey;
      bubble.classList.remove('popping');
      void bubble.offsetWidth;
      bubble.classList.add('popping');
    }
    const cards = element.querySelector('.seat-cards');
    for (let i = 0; i < (hand?.cards.length || 0); i++) {
      let card = cards.children[i];
      if (!card) {
        card = document.createElement('div'); card.className = `playing-card${animate ? ' dealing' : ''}`;
        card.setAttribute('role', 'img'); card.setAttribute('aria-label', '비공개 패');
        card.innerHTML = '<div class="card-inner"><div class="card-side card-back" aria-hidden="true">섯</div><div class="card-side card-front" aria-hidden="true"></div></div>';
        const delay = (i * room.players.length + index) * 95;
        if (animate) { card.style.animationDelay = `${delay}ms`; card.querySelector('.card-inner').style.animationDelay = `${delay + 330}ms`; }
        card.addEventListener('animationend', (event) => {
          if (event.animationName === 'turn-card' || event.animationName === 'deal-card' && !card.classList.contains('face-up')) card.classList.remove('dealing');
        });
        cards.append(card);
      }
      revealCard(card, hand.cards[i]);
    }
    const rank = element.querySelector('.seat-rank');
    rank.textContent = hand?.rank || (hand ? hand.folded ? '다이' : '비공개' : '');
    if (fresh && animate && own) {
      rank.classList.add('arriving'); rank.style.animationDelay = `${(room.players.length + index) * 95 + 650}ms`;
      rank.addEventListener('animationend', () => rank.classList.remove('arriving'), { once: true });
    }
    return element;
  }
  function renderTable() {
    if (!room) return;
    const game = room.game;
    const animate = animateDeal;
    const other = room.players.filter((p) => p.id !== playerId);
    const opponents = other.map((p) => seatElement(p, false, room.players.indexOf(p), animate));
    while (opponents.length < 3) { const empty = $('opponent-seats').children[opponents.length]?.classList.contains('empty-seat') ? $('opponent-seats').children[opponents.length] : document.createElement('div'); empty.className = 'seotda-seat empty-seat'; empty.textContent = '빈자리'; opponents.push(empty); }
    if (opponents.some((node, index) => $('opponent-seats').children[index] !== node)) $('opponent-seats').replaceChildren(...opponents);
    const self = room.players.find((p) => p.id === playerId);
    renderHandGuide(game.players.find((player) => player.color === self?.color));
    if (self) {
      const own = seatElement(self, true, room.players.indexOf(self), animate);
      if ($('own-seat').firstElementChild !== own) $('own-seat').replaceChildren(own);
    }
    // Flights start at the center deck, including seats on small screens.
    const deck = $('deck').getBoundingClientRect();
    for (const card of document.querySelectorAll('.playing-card.dealing')) {
      if (card.dataset.flightSet) continue;
      card.style.animationName = 'none';
      const target = card.getBoundingClientRect();
      card.style.setProperty('--deal-x', `${deck.x + deck.width / 2 - target.x - target.width / 2}px`);
      card.style.setProperty('--deal-y', `${deck.y + deck.height / 2 - target.y - target.height / 2}px`);
      card.dataset.flightSet = 'true';
      card.style.removeProperty('animation-name');
    }
    $('pot-value').textContent = game.pot;
    $('bet-label').textContent = game.status === 'playing' ? `현재 ${game.currentBet} 칩` : '기본 10';
    $('round-label').textContent = game.round ? `${game.round}번째 판` : '시작 대기';
    $('game-heading').textContent = room.title;
    $('invite-code').textContent = room.code;
    $('seat-count').textContent = `${room.players.length} / 4명`;
    const ownHand = game.players.find((player) => player.color === self?.color);
    $('result').hidden = game.status !== 'finished' || awaitingResult() || !ownHand;
    if (game.status === 'finished') {
      const hand = game.players.find((p) => p.color === self?.color);
      const payout = game.payouts[self?.color] || 0;
      const gain = payout - (hand?.committed || 0);
      $('result').dataset.outcome = gain > 0 ? 'win' : gain < 0 ? 'lose' : 'draw';
      $('result-title').textContent = gain > 0 ? 'WIN!' : gain < 0 ? 'LOSE' : 'DRAW';
      $('result-title').setAttribute('aria-label', gain > 0 ? '승리' : gain < 0 ? '패배' : '무승부');
      $('result-body').textContent = `${gain > 0 ? '+' : ''}${gain.toLocaleString('ko-KR')} 칩`;
    }
  }
  function render() { navigate(); renderProfile(); renderTable(); renderWallet(); controls(); }

  function renderLobby(list) {
    const rooms = list.filter((r) => r.type === 'seotda');
    $('room-count').textContent = rooms.length; $('room-list').replaceChildren();
    if (!rooms.length) { const text = document.createElement('p'); text.className = 'empty-rooms'; text.textContent = '대기 중인 방 없음'; $('room-list').append(text); }
    for (const item of rooms) {
      const button = document.createElement('button'); button.className = 'room-item';
      button.innerHTML = `${avatarImage(item.host.avatar)}<span class="room-item-copy"><strong></strong><small></small></span><span aria-hidden="true">↗</span>`;
      button.querySelector('strong').textContent = item.title; button.querySelector('small').textContent = `${item.host.name} · ${item.count} / 4명${item.status === 'playing' ? ' · 관전 후 참가' : ''}`;
      button.addEventListener('click', () => request('room:join', { code: item.code, type: 'seotda' }));
      $('room-list').append(button);
    }
  }
  $('create-form').addEventListener('submit', async (event) => { event.preventDefault(); await request('room:create', { type: 'seotda', title: $('room-title').value, visibility: $('private-room').checked ? 'private' : 'public' }); });
  $('join-form').addEventListener('submit', async (event) => { event.preventDefault(); await request('room:join', { code: $('room-code').value, type: 'seotda' }); });
  $('refresh-rooms').addEventListener('click', async () => { const response = await request('lobby:list'); if (response) renderLobby(response.rooms); });
  $('start-button').addEventListener('click', () => request('seotda:start'));
  $('auto-next').addEventListener('change', async () => {
    const enabled = $('auto-next').checked;
    await request('seotda:autoplay', { enabled });
    controls();
  });
  function bet(action, amount) { if (room) return request('seotda:action', { action, amount, round: room.game.round, version: room.game.version }); }
  $('call-button').addEventListener('click', () => bet('call'));
  $('fold-button').addEventListener('click', () => bet('fold'));
  $('all-in-button').addEventListener('click', () => bet('all-in'));
  for (const amount of [10, 50]) $(`raise-${amount}`).addEventListener('click', () => bet('raise', amount));

  function confirmLeave() {
    if ($('confirm-dialog').open) return Promise.resolve(false);
    $('confirm-dialog').showModal();
    return new Promise((resolve) => $('confirm-dialog').addEventListener('close', () => resolve($('confirm-dialog').returnValue === 'yes'), { once: true }));
  }
  $('confirm-yes').addEventListener('click', () => $('confirm-dialog').close('yes'));
  $('confirm-no').addEventListener('click', () => $('confirm-dialog').close('no'));
  async function leave() {
    if (room?.game.status === 'playing' && !await confirmLeave()) return false;
    return !room || Boolean(await request('room:leave'));
  }
  $('leave-button').addEventListener('click', leave);
  $('home-link').addEventListener('click', async (event) => {
    event.preventDefault();
    if (!await leave()) return;
    try { await navigateWithSession(window, socket, '/'); }
    catch { toast('화면 이동 실패. 다시 시도해 주세요.'); }
  });
  $('rules-button').addEventListener('click', () => $('rules-dialog').showModal());
  $('rules-close').addEventListener('click', () => $('rules-dialog').close());
  async function copy(text) { try { await window.navigator.clipboard.writeText(text); toast('복사됨'); } catch { toast(`복사 실패: ${text}`); } }
  $('copy-code').addEventListener('click', () => copy(room.code));
  $('copy-link').addEventListener('click', () => copy(`${location.origin}/seotda?room=${room.code}`));

  function renderChat() {
    const log = $('chat-log'); const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren(...messages.map((message) => {
      const item = document.createElement('li'); item.className = `chat-message${message.playerId === playerId ? ' own' : ''}`;
      const name = document.createElement('strong'); name.textContent = message.name;
      const text = document.createElement('span'); text.textContent = message.text;
      item.append(name, text); return item;
    }));
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  $('chat-input').addEventListener('input', controls);
  $('chat-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const text = $('chat-input').value.trim();
    if (!text || !online || !room || chatBusy) return;
    const code = room.code; chatBusy = true; controls();
    try {
      await new Promise((resolve) => socket.timeout(5000).emit('chat:send', { text }, (error, response) => {
        if (error || !response?.ok) toast(response?.error || '채팅 전송 실패');
        else if (room?.code === code) $('chat-input').value = '';
        resolve();
      }));
    } finally { chatBusy = false; controls(); }
  });
  socket.on('chat:history', ({ roomCode, messages: history }) => { if (roomCode === room?.code) { messages = history.slice(-50); renderChat(); } });
  socket.on('chat:message', ({ roomCode, message }) => { if (roomCode === room?.code && !messages.some((m) => m.id === message.id)) { messages = [...messages, message].slice(-50); renderChat(); } });
  socket.on('session', ({ token, playerId: id, profile, wallet: restoredWallet, pendingKick: restoredKick }) => {
    playerId = id;
    activeProfile = profile;
    wallet = restoredWallet;
    pendingKick = restoredKick;
    if (profile) selectedProfile = profile.profileId;
    socket.auth.token = token;
    write('sessionStorage', 'omok-session', token);
  });
  socket.on('wallet:state', (next) => { wallet = next; renderWallet(); });
  socket.on('seotda:kicked', (notice) => { pendingKick = notice; showAccountNotice(notice.message, notice.id); });
  socket.on('connect', () => { online = true; $('connection').className = 'connection online'; $('connection-text').textContent = '서버 연결됨'; controls(); });
  socket.on('disconnect', () => { online = false; $('connection').className = 'connection offline'; $('connection-text').textContent = '다시 연결 중'; controls(); });
  const retryTimers = new Set();
  socket.on('connect_error', (error) => {
    online = false; toast(error.message); controls();
    if (!socket.active) { const timer = window.setTimeout(() => { retryTimers.delete(timer); socket.connect(); }, 5000); retryTimers.add(timer); }
  });
  socket.on('notice', toast);
  socket.on('lobby:state', renderLobby);
  socket.on('room:state', (next) => {
    if (next && next.type !== 'seotda') {
      navigateWithSession(window, socket, `/game/${next.code}`, { replace: true }).catch(() => toast('화면 이동 실패. 다시 시도해 주세요.'));
      return;
    }
    if (room?.code !== next?.code) { messages = []; renderChat(); $('chat-input').value = ''; }
    room = next; ready = true;
    if (room?.wallet) wallet = room.wallet;
    const dealKey = room ? `${room.code}/${room.game.round}` : '';
    animateDeal = room?.game.status === 'playing' && Date.now() - room.game.dealAt < 2000 && read('sessionStorage', 'seotda-last-deal') !== dealKey;
    if (room?.game.status === 'playing') write('sessionStorage', 'seotda-last-deal', dealKey);
    if (room) { pendingCode = ''; remove('sessionStorage', 'seotda-invite'); $('room-code').value = ''; }
    if ($('confirm-dialog').open && (!room || room.game.status !== 'playing')) $('confirm-dialog').close('no');
    render();
    scheduleResult();
    if (pendingKick && !$('account-dialog').open) showAccountNotice(pendingKick.message, pendingKick.id);
    animateDeal = false;
  });
  function onPopState() { navigate(); }
  window.addEventListener('popstate', onPopState);
  const statusTimer = window.setInterval(controls, 1000);
  render(); socket.connect();
  return { destroy() { socket.removeAllListeners(); socket.disconnect(); window.clearInterval(statusTimer); window.clearTimeout(toastTimer); window.clearTimeout(resultTimer); window.clearTimeout(pasteWarningTimer); for (const timer of retryTimers) window.clearTimeout(timer); window.removeEventListener('popstate', onPopState); } };
}

if (typeof window !== 'undefined' && window.document) startSeotda(window);
