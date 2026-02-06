// 原来的简单聊天接口（保留）
export async function sendToBackend(message) {
  const res = await fetch("http://localhost:8787/chat", {
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
  const res = await fetch("http://localhost:8787/orchestrate", {
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