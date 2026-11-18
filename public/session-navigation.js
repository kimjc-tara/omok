const pendingNavigations = new WeakSet();

export function sessionAuth(window) {
  try {
    const token = window.sessionStorage.getItem('omok-session');
    const handoff = window.sessionStorage.getItem('omok-handoff');
    window.sessionStorage.removeItem('omok-handoff');
    return { token, handoff };
  } catch {
    return {};
  }
}

export async function navigateWithSession(window, socket, path, { replace = false } = {}) {
  if (pendingNavigations.has(socket)) return;
  pendingNavigations.add(socket);
  try {
    const result = await socket.timeout(5000).emitWithAck('session:handoff', {});
    if (!result?.ok) throw new Error('화면 이동 실패');
    try {
      window.sessionStorage.setItem('omok-session', result.token);
      window.sessionStorage.setItem('omok-handoff', result.handoff);
    } catch { /* Browsers that deny storage cannot preserve sessions across pages. */ }
    socket.disconnect();
    if (replace) window.location.replace(path);
    else window.location.assign(path);
  } catch (error) {
    pendingNavigations.delete(socket);
    throw error;
  }
}
