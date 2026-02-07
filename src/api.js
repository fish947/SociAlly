// API 地址 - 空字符串表示同域名（前后端部署在一起）
const API_BASE = "";

// 简单聊天接口
export async function sendToBackend(message) {
  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }

  const data = await res.json();
  return data.reply;
}

// 编排接口 - 多Agent对话
export async function orchestrate(userMessage, conversationState, userName) {
  const res = await fetch(`${API_BASE}/orchestrate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userMessage, conversationState, userName }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }

  return await res.json();
}
