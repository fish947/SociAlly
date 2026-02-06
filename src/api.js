// API 地址配置
// 本地开发: http://localhost:8787
// 部署后: 改成 Railway 给你的地址
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8787";

// 原来的简单聊天接口（保留）
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

// 新的编排接口 - 多Agent对话
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

  return await res.json(); // 返回 { responses, newState }
}
