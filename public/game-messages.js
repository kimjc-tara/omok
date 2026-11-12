// Keep the banter in one place so the game's tone is easy to change.
export function gameMessage(room, playerId) {
  const { game, players } = room;
  const me = players.find((player) => player.id === playerId);
  if (game.status === 'playing') {
    return {
      tone: 'start',
      title: '게임시작',
      body: '상대를 개패볼까요?',
      primary: '시작', secondary: '',
    };
  }
  if (!game.winner) return {
    tone: 'draw', title: '무승부입니다.',
    body: '니네 뭐하냐?',
    primary: '한판더', secondary: '닫기',
  };
  const won = game.winner === me?.color;
  let title = won ? '당신이 이겼습니다!' : '당신이 쳐 발렸습니다!';
  let body = won ? '엌ㅋ 개쉽노 ㅋㅋㅋ' : '엌ㅋㅋ';
  if (game.reason === 'resign' && won) {
    title = '상대가 기권 했습니다!';
  } else if (game.reason === 'leave') {
    title = won ? '상대가 빤스런했습니다!' : '퇴장은 빨랐다.';
    body = won ? '오목은 못하는데 도망치는건 빠르네여 ㅋㅋ' : '승부보다 먼저 대국실을 탈출했습니다.';
  } else if (game.reason === 'disconnect') {
    title = won ? '상대방의 연결이 종료되었습니다.' : '연결 시간이 초과되었습니다.';
    body = won ? '상대방이 제한 시간 안에 다시 접속하지 않아 승리했습니다.' : '제한 시간 안에 다시 접속하지 못해 패배했습니다.';
  } else if (game.reason === 'idle') {
    title = '대국실이 종료되었습니다.';
    body = '';
  }
  return {
    tone: won ? 'win' : 'lose', title, body,
    primary: won ? '한판더 · 한번 더 쳐바르기' : '한판더 · 한번 더 쳐발리기',
    secondary: '닫기',
  };
}
