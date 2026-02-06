import { useState, useRef, useEffect, useCallback } from "react";
import { orchestrate } from "./api";
import "./App.css";

// Agent 配置
const AGENTS = {
  alex: { name: "Alex", color: "#f43f5e", gradient: "linear-gradient(135deg, #f43f5e 0%, #ec4899 100%)" },
  leo: { name: "Leo", color: "#10b981", gradient: "linear-gradient(135deg, #10b981 0%, #14b8a6 100%)" },
  bella: { name: "Bella", color: "#6366f1", gradient: "linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)" },
};

const TOPICS = [
  "Stress and Mental Health",
  "Social Media and Study Habits", 
  "Group Work vs Individual Work",
  "Online vs In-person Learning",
  "Procrastination"
];

// 配置
const CONFIG = {
  typingDelayBase: 1000,    // 基础打字时间
  typingDelayPerChar: 25,   // 每个字符增加的时间
  typingDelayMax: 2000,     // 最大打字时间
  betweenMessagesMin: 800,  // 消息之间最小间隔
  betweenMessagesMax: 1500, // 消息之间最大间隔
  silenceThreshold: 8000,   // 8秒沉默后Agent主动说话
};

export default function App() {
  const [view, setView] = useState("home");
  const [userName, setUserName] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [typing, setTyping] = useState(null);
  const [state, setState] = useState({ phase: "greeting", step: 0 });
  const [userTyping, setUserTyping] = useState(false);

  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const silenceTimer = useRef(null);
  const userTypingTimer = useRef(null);

  // 自动滚动
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typing]);

  // 随机延迟
  const delay = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

  // 计算打字时间（根据消息长度）
  const getTypingDelay = (text) => {
    const base = CONFIG.typingDelayBase;
    const perChar = text.length * CONFIG.typingDelayPerChar;
    return Math.min(base + perChar, CONFIG.typingDelayMax);
  };

  // 添加消息（带自然打字效果）
  const addMessagesWithDelay = async (responses) => {
    for (let i = 0; i < responses.length; i++) {
      const res = responses[i];
      
      // 显示打字指示器
      setTyping(res.speaker);
      await delay(getTypingDelay(res.text), getTypingDelay(res.text) + 300);
      setTyping(null);
      
      // 添加消息
      setMessages(prev => [...prev, { who: res.speaker, text: res.text }]);
      
      // 消息之间的间隔
      if (i < responses.length - 1) {
        await delay(CONFIG.betweenMessagesMin, CONFIG.betweenMessagesMax);
      }
    }
  };

  // 主动推进对话
  const proactiveAdvance = useCallback(async () => {
    if (loading || typing || userTyping || state.phase === "done") return;
    
    setLoading(true);
    try {
      const data = await orchestrate("", state, userName);
      if (data.newState) setState(data.newState);
      if (data.responses?.length > 0) {
        await addMessagesWithDelay(data.responses);
      }
    } catch (e) {
      console.error("Error:", e);
    }
    setLoading(false);
  }, [loading, typing, userTyping, state, userName]);

  // 监听沉默
  useEffect(() => {
    if (view !== "chat" || loading || typing || state.phase === "done") return;
    
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    
    silenceTimer.current = setTimeout(() => {
      if (!userTyping && input.length === 0) {
        proactiveAdvance();
      }
    }, CONFIG.silenceThreshold);
    
    return () => {
      if (silenceTimer.current) clearTimeout(silenceTimer.current);
    };
  }, [view, loading, typing, userTyping, input, state.phase, messages, proactiveAdvance]);

  // 处理输入
  const handleInputChange = (e) => {
    setInput(e.target.value);
    setUserTyping(true);
    
    if (userTypingTimer.current) clearTimeout(userTypingTimer.current);
    userTypingTimer.current = setTimeout(() => setUserTyping(false), 2000);
  };

  // 开始对话
  const startChat = async () => {
    if (!nameInput.trim()) return;
    
    const name = nameInput.trim();
    setUserName(name);
    setView("chat");
    setMessages([]);
    setState({ phase: "greeting", step: 0 });
    
    // 开场白 - 分开发送，更自然
    await delay(600, 800);
    await addMessagesWithDelay([{ speaker: "alex", text: `Hey ${name}! Good to see you.` }]);
    
    await delay(800, 1200);
    await addMessagesWithDelay([{ speaker: "leo", text: "Hey! How's everyone doing?" }]);
    
    await delay(500, 800);
    await addMessagesWithDelay([{ speaker: "bella", text: "Hi." }]);
  };

  // 发送消息
  const onSend = async () => {
    const text = input.trim();
    if (!text || loading) return;
    
    setMessages(m => [...m, { who: "user", text }]);
    setInput("");
    setUserTyping(false);
    setLoading(true);
    
    // 思考延迟
    await delay(400, 700);
    
    try {
      const data = await orchestrate(text, state, userName);
      if (data.newState) setState(data.newState);
      if (data.responses?.length > 0) {
        await addMessagesWithDelay(data.responses);
      }
    } catch (e) {
      setMessages(m => [...m, { who: "system", text: "Error: " + e.message }]);
    }
    
    setLoading(false);
    inputRef.current?.focus();
  };

  // 重新开始
  const restart = () => {
    setView("home");
    setMessages([]);
    setState({ phase: "greeting", step: 0 });
    setNameInput("");
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
  };

  // ========== 首页 ==========
  if (view === "home") {
    return (
      <div className="app-container">
        <nav className="navbar">
          <div className="nav-logo">SociAlly</div>
          <div className="nav-links">
            <span className="nav-link active">Home</span>
            <span className="nav-link">About</span>
            <span className="nav-link">Help</span>
          </div>
        </nav>

        <div className="home-content">
          <h1 className="home-title">Welcome to SociAlly</h1>
          <p className="home-subtitle">Practice group discussions with AI teammates</p>

          <div className="home-grid">
            <div className="glass-card">
              <h3>📖 Background</h3>
              <p>Your professor assigned a group presentation. During a quick break, your team needs to pick a topic, plan the structure, and divide the work.</p>
            </div>

            <div className="glass-card">
              <h3>📋 Available Topics</h3>
              <div className="topics-list">
                {TOPICS.map((topic, i) => (
                  <div key={i} className="topic-item">
                    <span className="topic-num">{i + 1}</span>
                    <span>{topic}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="glass-card agents-card">
            <h3>👥 Your Teammates</h3>
            <div className="agents-grid">
              {Object.entries(AGENTS).map(([id, agent]) => (
                <div key={id} className="agent-item">
                  <div className="agent-avatar" style={{ background: agent.gradient }}>{agent.name[0]}</div>
                  <div className="agent-info">
                    <span className="agent-name">{agent.name}</span>
                    <span className="agent-desc">
                      {id === "alex" && "Energetic, opinionated"}
                      {id === "leo" && "Calm mediator"}
                      {id === "bella" && "Quiet, brief"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="start-section">
            <input
              className="name-input"
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && startChat()}
              placeholder="Enter your name..."
              autoFocus
            />
            <button className="start-btn" onClick={startChat}>Start Discussion →</button>
          </div>
        </div>
      </div>
    );
  }

  // ========== 聊天页面 ==========
  const isDone = state.phase === "done";
  
  return (
    <div className="app-container">
      <nav className="navbar">
        <div className="nav-logo">SociAlly</div>
        <div className="nav-links">
          <span className="nav-link" onClick={restart}>Home</span>
          <span className="nav-link">About</span>
          <span className="nav-link">Help</span>
        </div>
      </nav>

      <div className="chat-wrapper">
        <div className="chat-container glass-card">
          <div className="chat-header">
            <button className="back-btn" onClick={restart}>← Back</button>
            <div className="header-center">
              <h2>Group Discussion</h2>
              {!isDone && <span className="phase-badge">{state.phase?.replace(/_/g, " ")}</span>}
              {isDone && <span className="done-badge">✓ Discussion Complete</span>}
            </div>
            <div className="header-spacer"></div>
          </div>

          <div className="messages-area">
            {messages.map((m, i) => {
              const isUser = m.who === "user";
              const isSystem = m.who === "system";
              const agent = AGENTS[m.who];

              return (
                <div key={i} className={`message ${isUser ? "user" : ""} ${isSystem ? "system" : ""}`}>
                  {!isUser && !isSystem && (
                    <div className="msg-avatar" style={{ background: agent?.gradient }}>{agent?.name[0]}</div>
                  )}
                  <div className={`msg-bubble ${isUser ? "user-bubble" : "agent-bubble"}`}>
                    {!isUser && !isSystem && (
                      <div className="msg-name" style={{ color: agent?.color }}>{agent?.name}</div>
                    )}
                    <div className="msg-text">{m.text}</div>
                  </div>
                </div>
              );
            })}

            {typing && (
              <div className="message">
                <div className="msg-avatar" style={{ background: AGENTS[typing]?.gradient }}>{AGENTS[typing]?.name[0]}</div>
                <div className="msg-bubble agent-bubble">
                  <div className="msg-name" style={{ color: AGENTS[typing]?.color }}>{AGENTS[typing]?.name}</div>
                  <div className="typing-dots"><span></span><span></span><span></span></div>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {isDone ? (
            <div className="ended-banner">
              <span>🎉 Discussion ended successfully!</span>
              <button onClick={restart}>Start New Discussion</button>
            </div>
          ) : (
            <div className="input-area">
              <input
                ref={inputRef}
                className="msg-input"
                value={input}
                onChange={handleInputChange}
                onKeyDown={e => e.key === "Enter" && onSend()}
                placeholder="Type your message..."
                disabled={loading}
              />
              <button className="send-btn" onClick={onSend} disabled={loading || !input.trim()}>
                {loading ? "..." : "Send"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}