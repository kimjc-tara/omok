import { avatarImage } from './avatars.js';
import { PROFILES, findProfile } from './profiles.js';
import { gameMessage } from './game-messages.js';

export function startApp(window) {
const { document, location, history, navigator } = window;
const $ = (id) => document.getElementById(id);
const storage = {
  read(area, key) { try { return window[area].getItem(key); } catch { return null; } },
  write(area, key, value) { try { window[area].setItem(key, value); } catch { /* Private browsing can deny storage. */ } },
  remove(area, key) { try { window[area].removeItem(key); } catch { /* Storage is optional. */ } },
};
let saved;
try { saved = JSON.parse(storage.read('localStorage', 'omok-profile')); } catch { /* Use defaults. */ }
const remembered = findProfile(saved?.profileId);
let profile = {
  profileId: remembered?.profileId || null,
};
let activeProfile = null;
let sessionReady = false;
let currentPage = null;
let requestedPage = pageFromPath(location.pathname);
const url = new URL(location.href);
const candidateCode = url.searchParams.get('room') || location.hash.slice(1) || location.pathname.match(/^\/game\/([A-Z2-9]{6})\/?$/)?.[1] || storage.read('sessionStorage', 'omok-invite') || '';
let pendingInvite = /^[A-Z2-9]{6}$/.test(candidateCode.toUpperCase()) ? candidateCode.toUpperCase() : '';
if (pendingInvite) storage.write('sessionStorage', 'omok-invite', pendingInvite);
let room = null;
let playerId = null;
let online = false;
let busy = false;
let selected = null;
let focusCell = [7, 7];
let toastTimer;
const gameEventDialog = $('game-event-dialog');
const seenGameEvents = new Set([storage.read('sessionStorage', 'omok-last-game-event')].filter(Boolean));
let currentGameEvent = null;
const socket = window.io({ autoConnect: false, auth: { token: storage.read('sessionStorage', 'omok-session') } });
const cells = [];
const column = (x) => String.fromCharCode(65 + x);
const coordinate = (x, y) => `${column(x)}${y + 1}`;
const me = () => room?.players.find((player) => player.id === playerId);
const canPlace = () => online && !busy && room?.game.status === 'playing' && room.players.length === 2
  && room.players.every((player) => player.connected) && room.game.turn === me()?.color
  && !gameEventDialog.open && !$('confirm-dialog').open;

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 5000);
}

async function request(event, payload = {}) {
  if (!online) { toast('서버 재연결 중'); return null; }
  if (busy) return null;
  busy = true;
  renderControls();
  try {
    return await new Promise((resolve) => socket.timeout(5000).emit(event, payload, (error, result) => {
      if (error) { toast('서버 응답 지연'); resolve(null); }
      else if (!result?.ok) { toast(result?.error || '요청 실패'); resolve(null); }
      else resolve(result);
    }));
  } finally { busy = false; renderControls(); }
}

function pageFromPath(path) {
  if (/^\/game\//.test(path)) return 'game';
  return /^\/lobby\/?$/.test(path) ? 'lobby' : 'profile';
}

function navigate(page, { replace = false, focus = true } = {}) {
  let next = page;
  if (!sessionReady) next = 'profile';
  else if (room) next = 'game';
  else if ((next === 'lobby' || next === 'game') && !activeProfile) next = 'profile';
  else if (next === 'game') next = 'lobby';
  const path = next === 'game' ? `/game/${room.code}` : next === 'lobby' && pendingInvite ? `/lobby?room=${pendingInvite}` : `/${next}`;
  if (location.pathname + location.search + location.hash !== path) history[replace || next !== page ? 'replaceState' : 'pushState'](null, '', path);
  const changed = currentPage !== next;
  currentPage = next;
  for (const section of document.querySelectorAll('[data-page]')) section.hidden = section.dataset.page !== next;
  for (const step of document.querySelectorAll('[data-step]')) {
    if (step.dataset.step === next) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  }
  document.title = `오목의 전설 — ${{ profile: '프로필 선택', lobby: '대국실', game: room?.title || '대국' }[next]}`;
  if (focus && changed) $(`${next}-heading`).focus({ preventScroll: true });
}

function renderProfile() {
  for (const button of $('profile-options').children) {
    const selected = button.dataset.profileId === profile.profileId;
    button.setAttribute('aria-pressed', String(selected));
    const avatar = findProfile(button.dataset.profileId).avatar;
    const face = button.querySelector('.profile-face');
    if (!face.firstElementChild) face.innerHTML = avatarImage(avatar);
  }
  if (activeProfile) {
    $('active-profile-name').textContent = `${activeProfile.name}님`;
    $('active-profile-avatar').innerHTML = avatarImage(activeProfile.avatar);
  }
  $('profile-invite').textContent = pendingInvite ? `초대 ${pendingInvite}` : '';
  $('profile-invite').hidden = !pendingInvite;
}

for (const preset of PROFILES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'profile-option';
  button.dataset.profileId = preset.profileId;
  button.setAttribute('aria-label', `${preset.name} 선택`);
  button.innerHTML = `<span class="profile-face"></span><strong>${preset.name}</strong>`;
  button.addEventListener('click', () => {
    profile = { profileId: preset.profileId };
    renderProfile();
    renderControls();
  });
  $('profile-options').append(button);
}
for (let y = 0; y < 15; y++) {
  const row = document.createElement('div');
  row.className = 'board-row';
  row.setAttribute('role', 'row');
  cells[y] = [];
  for (let x = 0; x < 15; x++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-rowindex', String(y + 1));
    cell.setAttribute('aria-colindex', String(x + 1));
    if (([3, 11].includes(x) && [3, 11].includes(y)) || (x === 7 && y === 7)) cell.classList.add('star');
    cell.tabIndex = x === 7 && y === 7 ? 0 : -1;
    cell.addEventListener('click', () => {
      if (!canPlace() || room.game.board[y][x]) return;
      selected = [x, y];
      updateFocus(x, y);
      renderBoard();
      renderControls();
    });
    cell.addEventListener('keydown', (event) => {
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!direction) return;
      event.preventDefault();
      const nx = Math.max(0, Math.min(14, x + direction[0]));
      const ny = Math.max(0, Math.min(14, y + direction[1]));
      updateFocus(nx, ny);
      cells[ny][nx].focus({ preventScroll: true });
    });
    cells[y][x] = cell;
    row.append(cell);
  }
  $('board').append(row);
}

function updateFocus(x, y) {
  cells[focusCell[1]][focusCell[0]].tabIndex = -1;
  focusCell = [x, y];
  cells[y][x].tabIndex = 0;
}

function renderBoard() {
  const last = room?.game.moves.at(-1);
  const winning = new Set(room?.game.winningLine.map(([x, y]) => `${x},${y}`));
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
    const cell = cells[y][x];
    const color = room?.game.board[y][x] || 0;
    const isSelected = selected?.[0] === x && selected?.[1] === y;
    const preview = !color && isSelected && canPlace();
    const stoneColor = color || (preview ? me().color : 0);
    const isLast = color && last?.x === x && last?.y === y;
    const isWinning = winning.has(`${x},${y}`);
    const key = `${stoneColor}-${preview}-${isLast}-${isWinning}`;
    if (cell.dataset.visual !== key) {
      cell.innerHTML = stoneColor ? `<span class="stone${stoneColor === 2 ? ' white' : ''}${preview ? ' preview' : ''}${isLast ? ' last' : ''}${isWinning ? ' winning' : ''}" aria-hidden="true"></span>` : '';
      cell.dataset.visual = key;
    }
    cell.setAttribute('aria-label', `${coordinate(x, y)}, ${color === 1 ? '흑돌' : color === 2 ? '백돌' : '빈 자리'}${isLast ? ', 마지막 수' : ''}${isWinning ? ', 승리한 연결' : ''}`);
    cell.setAttribute('aria-selected', String(isSelected));
    cell.setAttribute('aria-disabled', String(!canPlace() || Boolean(color)));
  }
}

function playerCard(player) {
  const card = document.createElement('div');
  card.className = 'player';
  if (room.game.status === 'playing' && room.game.turn === player.color) card.classList.add('current');
  card.innerHTML = `${avatarImage(player.avatar)}<div><strong></strong><span></span></div>`;
  const name = card.querySelector('strong');
  name.textContent = player.name;
  if (player.id === playerId) {
    const label = document.createElement('span');
    label.className = 'me-label';
    label.textContent = '나';
    name.append(label);
  }
  const description = card.querySelector('div > span');
  const stone = document.createElement('i');
  stone.className = `stone-label${player.color === 2 ? ' white' : ''}`;
  description.append(stone, `${player.color === 1 ? '흑 · 선공' : '백 · 후공'}${player.connected ? '' : ' · 연결 끊김'}`);
  return card;
}

function renderPlayers() {
  if (!room) {
    $('players').replaceChildren();
    return;
  }
  const players = [...room.players].sort((a, b) => a.color - b.color);
  const versus = document.createElement('span');
  versus.className = 'versus';
  versus.textContent = 'VS';
  const empty = document.createElement('div');
  empty.className = 'player empty';
  empty.innerHTML = '<div class="empty-avatar">?</div><strong>상대 입장 대기</strong>';
  $('players').replaceChildren(playerCard(players[0]), versus, players[1] ? playerCard(players[1]) : empty);
}

function renderStatus() {
  let title = '대기 중';
  if (!online) title = '서버 연결 중';
  else if (room) {
    const game = room.game;
    const offlinePlayer = room.players.find((player) => !player.connected);
    if (game.status === 'finished') {
      title = room.rematch.includes(playerId) ? '재대국 동의 대기'
        : room.rematch.length ? '재대국 요청' : gameMessage(room, playerId).title;
    } else if (offlinePlayer) {
      const seconds = Math.max(0, Math.ceil((offlinePlayer.reconnectDeadline - Date.now()) / 1000));
      title = `재접속 대기 · ${seconds}초`;
    } else if (game.status === 'waiting') title = '상대 입장 대기';
    else title = game.turn === me()?.color ? '내 차례' : '상대 차례';
  }
  $('status-title').textContent = title;
  $('turn-symbol').className = `turn-symbol${room?.game.status === 'playing' ? room.game.turn === 1 ? ' black' : ' white' : ''}`;
}

function renderControls() {
  const preset = findProfile(profile.profileId);
  $('profile-continue').disabled = !online || !sessionReady || busy || !preset;
  $('profile-continue').textContent = busy && currentPage === 'profile' ? '확인 중' : preset ? '대기실 입장' : '프로필 선택';
  for (const button of $('profile-options').children) button.disabled = busy;
  for (const id of ['create-button', 'join-button', 'refresh-rooms']) $(id).disabled = !online || !sessionReady || busy || !activeProfile;
  $('leave-button').disabled = !online || busy;
  for (const button of $('room-list').querySelectorAll('button')) button.disabled = !online || busy || !activeProfile;
  $('place-button').hidden = room?.game.status === 'finished';
  $('place-button').disabled = !canPlace() || !selected;
  $('place-button').textContent = selected && canPlace() ? `${coordinate(...selected)}에 두기` : '위치를 선택해 주세요';
  $('resign-button').hidden = room?.game.status !== 'playing';
  $('resign-button').disabled = !online || busy;
  $('rematch-button').hidden = room?.game.status !== 'finished';
  const ready = room?.rematch.includes(playerId);
  const bothOnline = room?.players.length === 2 && room.players.every((player) => player.connected);
  const rematchLabel = room?.game.status === 'finished' ? gameMessage(room, playerId).primary : '한판더';
  $('rematch-button').textContent = ready ? '상대 동의 대기' : bothOnline ? rematchLabel : '상대 입장 대기';
  $('rematch-button').disabled = !online || busy || ready || !bothOnline;
  renderGameEventActions();
}

function closeGameEvent() {
  currentGameEvent = null;
  if (gameEventDialog.open) gameEventDialog.close();
}

function renderGameEventActions() {
  if (!currentGameEvent || !room) return;
  const copy = gameMessage(room, playerId);
  const start = currentGameEvent.kind === 'start';
  const ready = room.rematch.includes(playerId);
  const bothOnline = room.players.length === 2 && room.players.every((player) => player.connected);
  $('game-event-primary').textContent = start ? copy.primary : ready ? '상대 동의 대기' : !bothOnline ? '상대 입장 대기' : copy.primary;
  $('game-event-primary').disabled = !online || busy || (!start && (ready || !bothOnline));
  $('game-event-primary').setAttribute('aria-label', start ? '시작' : copy.primary);
  $('game-event-secondary').textContent = copy.secondary;
  $('game-event-secondary').hidden = start || !copy.secondary;
  $('game-event-close').hidden = start;
}

function renderGameEvent() {
  const copy = gameMessage(room, playerId);
  gameEventDialog.dataset.tone = copy.tone;
  $('game-event-title').textContent = copy.title;
  $('game-event-body').textContent = copy.body;
  $('game-event-body').hidden = !copy.body;
  const participants = [];
  for (const player of [...room.players].sort((a, b) => a.color - b.color)) {
    if (participants.length) {
      const versus = document.createElement('span');
      versus.className = 'versus';
      versus.textContent = 'VS';
      participants.push(versus);
    }
    const face = document.createElement('div');
    face.className = `event-player${room.game.status === 'finished' && player.color === room.game.winner ? ' event-winner' : ''}`;
    face.innerHTML = `${avatarImage(player.avatar)}<strong></strong><small></small>`;
    face.querySelector('strong').textContent = player.name;
    face.querySelector('small').textContent = `${player.color === 1 ? '흑' : '백'}${player.id === playerId ? ' · 나' : ''}`;
    participants.push(face);
  }
  $('game-event-players').replaceChildren(...participants);
  renderGameEventActions();
}

function syncGameEvent() {
  if (!room || room.game.status === 'waiting') {
    closeGameEvent();
    if (!room && $('confirm-dialog').open) $('confirm-dialog').close('cancel');
    return;
  }
  const kind = room.game.status === 'playing' ? 'start' : 'result';
  if (kind === 'start' && (room.players.length !== 2 || room.players.some((player) => !player.connected))) {
    closeGameEvent();
    return;
  }
  const key = `${playerId}/${room.code}/${room.game.round}/${kind}`;
  if (currentGameEvent?.key === key && gameEventDialog.open) { renderGameEvent(); return; }
  closeGameEvent();
  // Joining a game in progress is a reconnect, not a fresh starting bell.
  if ((kind === 'start' && room.game.moves.length > 0) || seenGameEvents.has(key)) return;
  if ($('confirm-dialog').open) $('confirm-dialog').close('cancel');
  currentGameEvent = { key, kind };
  renderGameEvent();
  gameEventDialog.showModal();
  seenGameEvents.add(key);
  storage.write('sessionStorage', 'omok-last-game-event', key);
  renderBoard();
  renderControls();
}

gameEventDialog.addEventListener('close', () => {
  if (!gameEventDialog.open) currentGameEvent = null;
  renderBoard();
  renderControls();
});
gameEventDialog.addEventListener('cancel', (event) => {
  if (currentGameEvent?.kind === 'start') event.preventDefault();
});
for (const id of ['game-event-close', 'game-event-secondary']) $(id).addEventListener('click', () => {
  if (currentGameEvent?.kind !== 'start') closeGameEvent();
});
$('game-event-primary').addEventListener('click', async () => {
  const rematch = currentGameEvent?.kind === 'result';
  closeGameEvent();
  if (rematch) await request('game:rematch');
});

function render() {
  $('game-title').textContent = room?.title || '';
  $('game-eyebrow').textContent = room ? `ROOM ${room.code}` : 'YOUR NEXT MOVE';
  $('round-label').textContent = room ? `${room.game.round}번째 판 · ${room.game.moves.length}수` : '대국 대기';
  $('invite-code').textContent = room?.code || '';
  $('visibility-label').textContent = room?.visibility === 'private' ? '비공개' : '공개';
  renderProfile();
  renderPlayers();
  renderBoard();
  renderStatus();
  renderControls();
}

function renderLobby(rooms) {
  $('room-count').textContent = rooms.length;
  $('room-list').replaceChildren();
  if (!rooms.length) {
    $('room-list').innerHTML = '<p class="empty-rooms">대기 중인 방 없음</p>';
    return;
  }
  for (const item of rooms) {
    const button = document.createElement('button');
    button.className = 'room-item';
    button.innerHTML = `${avatarImage(item.host.avatar)}<span class="room-item-copy"><strong></strong><small></small></span><span class="room-item-arrow" aria-hidden="true">↗</span>`;
    button.querySelector('strong').textContent = item.title;
    button.querySelector('small').textContent = `${item.host.name} · 1 / 2명`;
    button.addEventListener('click', () => request('room:join', { code: item.code }));
    $('room-list').append(button);
  }
  renderControls();
}

socket.on('session', ({ token, playerId: id, profile: restoredProfile }) => {
  playerId = id;
  socket.auth.token = token;
  storage.write('sessionStorage', 'omok-session', token);
  activeProfile = restoredProfile;
  if (activeProfile) profile = { profileId: activeProfile.profileId };
  renderProfile();
});
socket.on('connect', () => {
  online = true;
  $('connection').className = 'connection online';
  $('connection-text').textContent = '서버 연결됨';
  render();
});
socket.on('disconnect', () => {
  online = false;
  selected = null;
  if (currentGameEvent?.kind === 'start') closeGameEvent();
  $('connection').className = 'connection offline';
  $('connection-text').textContent = '다시 연결 중';
  render();
});
socket.on('connect_error', (error) => {
  online = false;
  $('connection').className = 'connection offline';
  $('connection-text').textContent = '연결을 확인해 주세요';
  render();
  // Middleware rejections do not trigger automatic reconnection.
  if (!socket.active) { toast(error.message); window.setTimeout(() => socket.connect(), 5000); }
});
socket.on('room:state', (next) => {
  const oldKey = `${room?.code}/${room?.game.round}/${room?.game.moves.length}/${room?.game.status}`;
  const nextKey = `${next?.code}/${next?.game.round}/${next?.game.moves.length}/${next?.game.status}`;
  if (oldKey !== nextKey) selected = null;
  const wasReady = sessionReady;
  const wasInRoom = Boolean(room);
  room = next;
  sessionReady = true;
  if (room) {
    pendingInvite = '';
    storage.remove('sessionStorage', 'omok-invite');
    $('room-code').value = '';
  }
  if (wasInRoom && !room) requestedPage = 'lobby';
  navigate(room ? 'game' : requestedPage, { replace: !wasReady || wasInRoom, focus: wasReady });
  render();
  syncGameEvent();
});
socket.on('lobby:state', renderLobby);
socket.on('notice', toast);

$('profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!findProfile(profile.profileId)) return;
  const result = await request('profile:set', profile);
  if (!result) return;
  activeProfile = result.profile;
  profile = { profileId: activeProfile.profileId };
  storage.write('localStorage', 'omok-profile', JSON.stringify(profile));
  requestedPage = 'lobby';
  navigate('lobby');
  render();
});
function openProfile() {
  if (room) { toast('대기실에서 변경 가능'); return; }
  requestedPage = 'profile';
  navigate('profile');
}
$('home-link').addEventListener('click', (event) => { event.preventDefault(); openProfile(); });
$('change-profile').addEventListener('click', openProfile);
function onPopState() {
  requestedPage = pageFromPath(location.pathname);
  navigate(requestedPage, { replace: true });
}
window.addEventListener('popstate', onPopState);

$('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await request('room:create', { title: $('room-title').value, visibility: $('private-room').checked ? 'private' : 'public' });
});
$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await request('room:join', { code: $('room-code').value });
});
$('refresh-rooms').addEventListener('click', async () => {
  const result = await request('lobby:list');
  if (result) renderLobby(result.rooms);
});
$('place-button').addEventListener('click', async () => {
  if (!selected || !canPlace()) return;
  const [x, y] = selected;
  await request('game:move', { x, y, round: room.game.round, moveNumber: room.game.moves.length });
  renderBoard();
});
$('rematch-button').addEventListener('click', () => request('game:rematch'));

function confirmAction(title, action = '예', cancel = '아니오') {
  if ($('confirm-dialog').open || gameEventDialog.open) return Promise.resolve(false);
  $('confirm-title').textContent = title;
  $('confirm-action').textContent = action;
  $('confirm-cancel').textContent = cancel;
  $('confirm-dialog').returnValue = 'cancel';
  $('confirm-dialog').showModal();
  renderBoard();
  renderControls();
  return new Promise((resolve) => $('confirm-dialog').addEventListener('close', () => {
    resolve($('confirm-dialog').returnValue === 'confirm');
    renderBoard();
    renderControls();
  }, { once: true }));
}
$('resign-button').addEventListener('click', async () => {
  if (await confirmAction('빤스 벗고 도망가기')) await request('game:resign');
});
$('leave-button').addEventListener('click', async () => {
  if (room?.game.status === 'playing' && !await confirmAction('쳐발리기전에 도망칠까요?? ㅋㅋ...')) return;
  await request('room:leave');
});

async function copy(text, success) {
  try { await navigator.clipboard.writeText(text); toast(success); }
  catch { toast(`복사 실패: ${text}`); }
}
$('copy-code').addEventListener('click', () => copy(room.code, '코드 복사됨'));
$('copy-link').addEventListener('click', () => copy(`${location.origin}/lobby?room=${room.code}`, '링크 복사됨'));
if (pendingInvite) $('room-code').value = pendingInvite;
const statusTimer = window.setInterval(renderStatus, 1000);
navigate('profile', { replace: true, focus: false });
render();
socket.connect();
return {
  destroy() {
    window.removeEventListener('popstate', onPopState);
    window.clearInterval(statusTimer);
    window.clearTimeout(toastTimer);
    socket.removeAllListeners();
    socket.disconnect();
  },
};
}

if (typeof window !== 'undefined' && window.document) startApp(window);
