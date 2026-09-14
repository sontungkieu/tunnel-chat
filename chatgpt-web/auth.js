'use strict';
(async () => {
  const status = document.getElementById('authStatus');
  const params = new URLSearchParams(location.hash.slice(1));
  const ticket = params.get('ticket');
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  async function exchange(path, options = {}) {
    const response = await fetch(path, { method:'POST', cache:'no-store', ...options });
    if (!response.ok) throw new Error(response.status === 401 ? 'Quyền đã hết hạn hoặc đã được sử dụng.' : 'Không thể mở phiên truy cập.');
    location.replace('/chat/');
  }
  try {
    if (ticket) {
      status.textContent = 'Đang đổi liên kết dùng một lần thành phiên 30 phút…';
      await exchange('/chat/_auth/exchange', { headers:{'content-type':'application/json'}, body:JSON.stringify({ticket}) });
      return;
    }
    const token = localStorage.getItem('tunnelChatToken');
    if (token) {
      status.textContent = 'Đang dùng quyền Codex để mở phiên ChatGPT web 30 phút…';
      await exchange('/chat/_auth/codex', { headers:{'x-chat-token':token} });
      return;
    }
    status.textContent = 'Máy này chưa có quyền Codex hoặc liên kết 30 phút. Bạn có thể dùng mật khẩu dự phòng.';
  } catch (error) { status.textContent = error.message + ' Bạn có thể dùng mật khẩu dự phòng.'; }
})();
