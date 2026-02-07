import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 代理配置 - 仅本地开发时使用
// 部署到 Railway 后不需要代理（服务器在国外）
let clientOptions = {
  apiKey: process.env.OPENAI_API_KEY,
};

// 如果设置了 USE_PROXY=true，才使用代理（本地开发用）
if (process.env.USE_PROXY === "true") {
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  const PROXY = process.env.PROXY_URL || "http://127.0.0.1:7890";
  clientOptions.httpAgent = new HttpsProxyAgent(PROXY);
  console.log("Using proxy:", PROXY);
}

const client = new OpenAI(clientOptions);

// ============================================
// LLM 润色函数 - 让固定回复更自然
// ============================================

async function polishResponse(responses, context) {
  // 如果回复太短或太简单，不需要润色
  if (responses.length === 0) return responses;
  
  const totalLength = responses.reduce((sum, r) => sum + r.text.length, 0);
  if (totalLength < 15) return responses; // 太短的不润色
  
  const prompt = `You are rewriting dialogue for 3 college students to sound more natural and casual.

CHARACTERS:
- Alex: Energetic, uses "like", "honestly", "right?", casual
- Leo: Calm, thoughtful, friendly
- Bella: Quiet, brief (keep her lines SHORT - max 5-6 words)

CONTEXT: ${context}

ORIGINAL LINES:
${responses.map(r => `${r.speaker}: "${r.text}"`).join("\n")}

Rewrite these lines to sound more natural and conversational. Keep the same meaning and speakers. Keep Bella's lines very short.

Return JSON only:
{"responses": [{"speaker": "alex", "text": "..."}, ...]}`;

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: prompt }],
      temperature: 0.8,
      max_tokens: 200,
      response_format: { type: "json_object" }
    }, { timeout: 8000 });

    const result = JSON.parse(completion.choices[0].message.content);
    return result.responses || responses;
  } catch (e) {
    console.error("Polish error:", e.message);
    return responses; // 失败就用原版
  }
}

// ============================================
// LLM 生成回应 - 用于用户输入后的自然回复
// ============================================

async function generateReaction(userMsg, context, userName) {
  const prompt = `You are 3 college students reacting to what ${userName} just said.

CHARACTERS:
- Alex: Energetic, casual ("like", "honestly", "totally")
- Leo: Calm, thoughtful
- Bella: Very quiet, brief (max 4-5 words, often just "Yeah." or "Mm-hmm.")

CONTEXT: ${context}
${userName} SAID: "${userMsg}"

Generate 1-2 natural reactions (not all 3 need to respond). Keep it SHORT and casual.

Return JSON only:
{"responses": [{"speaker": "alex", "text": "..."}, ...]}`;

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: prompt }],
      temperature: 0.85,
      max_tokens: 150,
      response_format: { type: "json_object" }
    }, { timeout: 8000 });

    const result = JSON.parse(completion.choices[0].message.content);
    return result.responses || [];
  } catch (e) {
    console.error("Reaction error:", e.message);
    return [];
  }
}

// ============================================
// 编排器 API
// ============================================

app.post("/orchestrate", async (req, res) => {
  try {
    const { userMessage, conversationState, userName } = req.body;
    const result = await orchestrate(conversationState || {}, userMessage || "", userName || "friend");
    return res.json(result);
  } catch (e) {
    console.error("Error:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ============================================
// 主编排函数
// ============================================

async function orchestrate(state, userMsg, userName) {
  const phase = state.phase || "greeting";
  const step = state.step || 0;
  const msg = (userMsg || "").toLowerCase().trim();
  
  // 已结束
  if (phase === "done") {
    return { responses: [], newState: state };
  }
  
  // 用户沉默 - 主动推进对话
  if (!msg) {
    return proactiveAdvance(state, userName);
  }
  
  // 获取基础回复
  let result;
  switch (phase) {
    case "greeting": result = greetingPhase(state, msg, userName); break;
    case "topic_list": result = topicListPhase(state, msg, userName); break;
    case "topic_preference": result = topicPreferencePhase(state, msg, userName); break;
    case "topic_choose": result = topicChoosePhase(state, msg, userName); break;
    case "topic_debate": result = topicDebatePhase(state, msg, userName); break;
    case "topic_confirm": result = topicConfirmPhase(state, msg, userName); break;
    case "structure_intro": result = structureIntroPhase(state, msg, userName); break;
    case "structure_causes": result = structureCausesPhase(state, msg, userName); break;
    case "structure_effects": result = structureEffectsPhase(state, msg, userName); break;
    case "structure_solutions": result = structureSolutionsPhase(state, msg, userName); break;
    case "structure_confirm": result = structureConfirmPhase(state, msg, userName); break;
    case "task_claim": result = taskClaimPhase(state, msg, userName); break;
    case "task_ask": result = taskAskPhase(state, msg, userName); break;
    case "task_respond": result = taskRespondPhase(state, msg, userName); break;
    case "task_summary": result = taskSummaryPhase(state, msg, userName); break;
    case "ending": result = endingPhase(state, msg, userName); break;
    default: return { responses: [], newState: state };
  }
  
  // 在某些阶段使用 LLM 润色回复
  const shouldPolish = ["structure_causes", "structure_effects", "structure_solutions", "task_claim", "task_respond"].includes(phase);
  
  if (shouldPolish && result.responses && result.responses.length > 0) {
    const context = `Phase: ${phase}, Topic: ${state.chosenTopic || "TBD"}, User said: "${userMsg}"`;
    result.responses = await polishResponse(result.responses, context);
  }
  
  return result;
}


// ============================================
// GREETING 阶段
// ============================================

function greetingPhase(state, msg, userName) {
  const step = state.step || 0;
  
  // 用户想开始项目
  if (msg.match(/yes|yeah|ok|okay|sure|let's|start|project|begin/i)) {
    return {
      responses: [{ speaker: "alex", text: "Alright! So we need to pick a topic for our group presentation." }],
      newState: { phase: "topic_list", step: 0 }
    };
  }
  
  // 正常寒暄回应
  let resp;
  if (msg.match(/good|great|fine|not bad|doing well|pretty good/i)) {
    resp = random([
      [{ speaker: "alex", text: "Same here, honestly." }],
      [{ speaker: "leo", text: "Good to hear." }],
      [{ speaker: "alex", text: "Nice nice." }],
    ]);
  } else if (msg.match(/tired|exhausted|sleepy|busy|stressed/i)) {
    resp = random([
      [{ speaker: "alex", text: "Ugh, same. This semester is rough." }],
      [{ speaker: "leo", text: "Yeah, I feel that." }],
    ]);
  } else if (msg.match(/you|how about you|what about you/i)) {
    resp = random([
      [{ speaker: "alex", text: "I'm doing okay. A bit tired but surviving." }],
      [{ speaker: "leo", text: "Pretty good, just trying to keep up with everything." }],
    ]);
  } else {
    resp = random([
      [{ speaker: "alex", text: "Yeah." }],
      [{ speaker: "leo", text: "Mm." }],
      [{ speaker: "bella", text: "Mm-hmm." }],
    ]);
  }
  
  return {
    responses: resp,
    newState: { phase: "greeting", step: step + 1 }
  };
}

// ============================================
// TOPIC LIST 阶段 - 连续列出话题（不等用户）
// ============================================

function topicListPhase(state, msg, userName) {
  const step = state.step || 0;
  
  // 用户可能在这个阶段直接选了一个topic
  const choice = detectTopicChoice(msg);
  if (choice) {
    return handleTopicSelection(choice, state.chosenTopic, userName);
  }
  
  // 连续列出所有topics
  switch (step) {
    case 0:
      return {
        responses: [
          { speaker: "alex", text: "The professor gave us five options." },
          { speaker: "alex", text: "Stress and Mental Health, Social Media and Study Habits, Group Work vs Individual Work, Online vs In-person Learning, and Procrastination." }
        ],
        newState: { phase: "topic_preference", step: 0 }
      };
    default:
      return {
        responses: [],
        newState: { phase: "topic_preference", step: 0 }
      };
  }
}

// ============================================
// TOPIC PREFERENCE 阶段 - Agent表达偏好
// ============================================

function topicPreferencePhase(state, msg, userName) {
  const step = state.step || 0;
  
  // 用户可能直接选了
  const choice = detectTopicChoice(msg);
  if (choice) {
    return handleTopicSelection(choice, null, userName);
  }
  
  switch (step) {
    case 0:
      return {
        responses: [{ speaker: "alex", text: "I kind of want to do Procrastination. Super relatable, right?" }],
        newState: { phase: "topic_preference", step: 1 }
      };
    case 1:
      return {
        responses: [{ speaker: "leo", text: "I was thinking Stress and Mental Health. Important topic." }],
        newState: { phase: "topic_preference", step: 2 }
      };
    case 2:
      return {
        responses: [{ speaker: "bella", text: "Online Learning could be interesting." }],
        newState: { phase: "topic_choose", step: 0 }
      };
    default:
      return {
        responses: [],
        newState: { phase: "topic_choose", step: 0 }
      };
  }
}

// ============================================
// TOPIC CHOOSE 阶段 - 询问用户选择
// ============================================

function topicChoosePhase(state, msg, userName) {
  // 用户选择了明确的一个
  const choice = detectTopicChoice(msg);
  if (choice) {
    return handleTopicSelection(choice, null, userName);
  }
  
  // 用户提到了多个topic - 让团队讨论
  const mentionsOnline = msg.match(/online|in-person/i);
  const mentionsProcrastination = msg.match(/procrastination/i);
  const mentionsStress = msg.match(/stress|mental/i);
  const mentionsSocial = msg.match(/social media/i);
  const mentionsGroup = msg.match(/group|individual/i);
  const mentionCount = [mentionsOnline, mentionsProcrastination, mentionsStress, mentionsSocial, mentionsGroup].filter(Boolean).length;
  
  if (mentionCount > 1) {
    // 用户提到了多个，让团队讨论并做决定
    let chosenTopic = "Online Learning"; // 默认
    if (mentionsProcrastination) chosenTopic = "Procrastination";
    else if (mentionsOnline) chosenTopic = "Online Learning";
    else if (mentionsStress) chosenTopic = "Stress and Mental Health";
    
    return {
      responses: [
        { speaker: "leo", text: "Both sound good actually." },
        { speaker: "alex", text: "Yeah, let's just pick one. How about " + chosenTopic + "?" },
        { speaker: "bella", text: "Works for me." }
      ],
      newState: { phase: "topic_confirm", step: 0, chosenTopic: chosenTopic, chosenBy: "team" }
    };
  }
  
  // 用户让他们决定
  if (msg.match(/you.*(choose|decide|pick)|up to you|don't know|whatever|any|not sure|you guys/i)) {
    return {
      responses: [
        { speaker: "alex", text: "Let's go with Procrastination then!" },
        { speaker: "leo", text: "Works for me." }
      ],
      newState: { phase: "topic_confirm", step: 0, chosenTopic: "Procrastination", chosenBy: "alex" }
    };
  }
  
  // 第一次问
  if (state.step === 0) {
    return {
      responses: [{ speaker: "leo", text: `${userName}, what do you think? Which one interests you?` }],
      newState: { phase: "topic_choose", step: 1 }
    };
  }
  
  // 用户说了其他的，友好地再问
  return {
    responses: [{ speaker: "alex", text: "So which topic are you leaning towards?" }],
    newState: { phase: "topic_choose", step: 2 }
  };
}

// ============================================
// 处理Topic选择 - 增加确认环节
// ============================================

function handleTopicSelection(choice, currentTopic, userName) {
  const topicNames = {
    stress: "Stress and Mental Health",
    social: "Social Media and Study Habits",
    group: "Group Work vs Individual Work",
    online: "Online Learning",
    procrastination: "Procrastination"
  };
  
  const topicName = topicNames[choice] || choice;
  
  // Alex 想要 procrastination
  if (choice === "procrastination") {
    return {
      responses: [
        { speaker: "alex", text: "Yes! That's what I wanted!" },
        { speaker: "leo", text: "Sounds good to me." },
        { speaker: "bella", text: "Okay." }
      ],
      newState: { phase: "topic_confirm", step: 0, chosenTopic: topicName, chosenBy: "user_alex" }
    };
  }
  
  // Leo 想要 stress
  if (choice === "stress") {
    return {
      responses: [
        { speaker: "leo", text: "Nice, I was hoping we'd pick that one." },
        { speaker: "alex", text: "Fine by me." },
        { speaker: "bella", text: "Sure." }
      ],
      newState: { phase: "topic_confirm", step: 0, chosenTopic: topicName, chosenBy: "user_leo" }
    };
  }
  
  // Bella 想要 online
  if (choice === "online") {
    return {
      responses: [
        { speaker: "bella", text: "Oh, that's what I wanted." },
        { speaker: "alex", text: "Yeah, Online Learning could be interesting." },
        { speaker: "leo", text: "Works for me." }
      ],
      newState: { phase: "topic_confirm", step: 0, chosenTopic: topicName, chosenBy: "user_bella" }
    };
  }
  
  // 用户选了别人都没选的 - Alex会争辩
  return {
    responses: [{ speaker: "alex", text: "Hmm, I was hoping we'd do Procrastination. Everyone can relate to it, right?" }],
    newState: { phase: "topic_debate", step: 0, userChoice: choice, userChoiceName: topicName }
  };
}

// ============================================
// TOPIC DEBATE 阶段 - 争辩
// ============================================

function topicDebatePhase(state, msg, userName) {
  const userChoice = state.userChoice;
  const userChoiceName = state.userChoiceName;
  
  // 用户让团队决定
  if (msg.match(/what.*(you|do you|guys|team|we|think|should)/i) || msg.match(/you.*(decide|choose|pick)/i)) {
    return {
      responses: [
        { speaker: "leo", text: "Hmm, I think " + userChoiceName + " could work well." },
        { speaker: "alex", text: "Yeah, let's just go with that." }
      ],
      newState: { phase: "topic_confirm", step: 0, chosenTopic: userChoiceName, chosenBy: "team" }
    };
  }
  
  // 用户坚持自己的选择
  if (msg.match(/yes|yeah|still|prefer|want|my choice|let's do|go with that|that one|i think/i) && !msg.match(/procrastination|your/i)) {
    return {
      responses: [
        { speaker: "leo", text: "Alright, let's go with " + userChoiceName + " then." },
        { speaker: "alex", text: "Okay, fine by me." }
      ],
      newState: { phase: "topic_confirm", step: 0, chosenTopic: userChoiceName, chosenBy: "user" }
    };
  }
  
  // 用户同意改成procrastination
  if (msg.match(/ok|okay|alright|fine|sure|procrastination|your|change|sounds good/i)) {
    return {
      responses: [
        { speaker: "alex", text: "Sweet! Procrastination it is!" },
        { speaker: "leo", text: "Sounds good." }
      ],
      newState: { phase: "topic_confirm", step: 0, chosenTopic: "Procrastination", chosenBy: "alex" }
    };
  }
  
  // 继续问
  return {
    responses: [{ speaker: "leo", text: "What do you think? Should we stick with " + userChoiceName + " or go with Procrastination?" }],
    newState: { phase: "topic_debate", step: 1, userChoice, userChoiceName }
  };
}

// ============================================
// TOPIC CONFIRM 阶段 - 过渡到structure
// ============================================

function topicConfirmPhase(state, msg, userName) {
  const topic = state.chosenTopic;
  return {
    responses: [{ speaker: "leo", text: "Alright, " + topic + " it is. Let's figure out the structure." }],
    newState: { phase: "structure_intro", step: 0, chosenTopic: topic }
  };
}

// ============================================
// STRUCTURE INTRO 阶段
// ============================================

function structureIntroPhase(state, msg, userName) {
  const step = state.step || 0;
  const topic = state.chosenTopic || "the topic";
  
  switch (step) {
    case 0:
      return {
        responses: [{ speaker: "alex", text: "I think we should have three main points." }],
        newState: { ...state, step: 1 }
      };
    case 1:
      return {
        responses: [{ speaker: "leo", text: "Yeah. How about Causes, Effects, and Solutions?" }],
        newState: { ...state, step: 2 }
      };
    case 2:
      return {
        responses: [{ speaker: "bella", text: "Sounds good." }],
        newState: { phase: "structure_causes", step: 0, chosenTopic: topic }
      };
    default:
      return {
        responses: [],
        newState: { phase: "structure_causes", step: 0, chosenTopic: topic }
      };
  }
}

// ============================================
// STRUCTURE CAUSES 阶段 - 使用实际topic
// ============================================

function structureCausesPhase(state, msg, userName) {
  const step = state.step || 0;
  const topic = state.chosenTopic || "this issue";
  
  // 真正的 CAUSES - 是什么导致了这个现象的出现
  const causeExamples = {
    "Online Learning": "the pandemic, technology advancement, cost and accessibility",
    "Stress and Mental Health": "academic pressure, social expectations, financial worries",
    "Procrastination": "fear of failure, perfectionism, lack of clear goals",
    "Social Media and Study Habits": "dopamine addiction, fear of missing out, peer pressure",
    "Group Work vs Individual Work": "different learning styles, scheduling conflicts, varying commitment levels"
  };
  
  const causes = causeExamples[topic] || "various factors";
  
  // 用户在任何时候说了有意义的内容，都要回应
  const userContributed = msg.length > 3 && !msg.match(/^(no|nope|nothing|ok|okay|good|sure|fine|yes|yeah|yep|yup|idk|i don't know|alright|right|cool|nice)$/i);
  
  if (userContributed && step >= 1 && step <= 3) {
    return {
      responses: [
        { speaker: "leo", text: "Yeah, that's a good one." },
        { speaker: "alex", text: "Definitely should include that." }
      ],
      newState: { ...state, step: step + 1 }
    };
  }
  
  switch (step) {
    case 0:
      return {
        responses: [{ speaker: "leo", text: "Let's start with Causes. Why does " + topic.toLowerCase() + " happen?" }],
        newState: { ...state, step: 1 }
      };
    case 1:
      return {
        responses: [{ speaker: "alex", text: "I'd say " + causes.split(",")[0] + "." }],
        newState: { ...state, step: 2 }
      };
    case 2:
      return {
        responses: [{ speaker: "leo", text: "Also " + (causes.split(",")[1] || "other factors") + "." }],
        newState: { ...state, step: 3 }
      };
    case 3:
      return {
        responses: [{ speaker: "alex", text: `${userName}, any other causes you can think of?` }],
        newState: { ...state, step: 4 }
      };
    case 4:
      if (userContributed) {
        return {
          responses: [
            { speaker: "leo", text: "Good point!" },
            { speaker: "alex", text: "Let's add that. Now onto Effects." }
          ],
          newState: { phase: "structure_effects", step: 0, chosenTopic: topic }
        };
      } else {
        return {
          responses: [{ speaker: "alex", text: "Alright, let's move to Effects." }],
          newState: { phase: "structure_effects", step: 0, chosenTopic: topic }
        };
      }
    default:
      return {
        responses: [],
        newState: { phase: "structure_effects", step: 0, chosenTopic: topic }
      };
  }
}

// ============================================
// STRUCTURE EFFECTS 阶段 - 使用实际topic
// ============================================

function structureEffectsPhase(state, msg, userName) {
  const step = state.step || 0;
  const topic = state.chosenTopic || "this issue";
  
  // EFFECTS - 这个现象带来的影响/后果
  const effectExamples = {
    "Online Learning": "more flexibility but less interaction, screen fatigue, self-discipline challenges",
    "Stress and Mental Health": "anxiety and depression, sleep problems, lower academic performance",
    "Procrastination": "rushed work and lower quality, increased stress, missed deadlines",
    "Social Media and Study Habits": "shorter attention span, less deep learning, sleep deprivation",
    "Group Work vs Individual Work": "uneven workload distribution, conflict between members, coordination overhead"
  };
  
  const effects = effectExamples[topic] || "negative impacts";
  
  // 用户在任何时候说了有意义的内容，都要回应
  const userContributed = msg.length > 3 && !msg.match(/^(no|nope|nothing|ok|okay|good|sure|fine|yes|yeah|yep|yup|idk|i don't know|alright|right|cool|nice|that's good|that's it)$/i);
  
  if (userContributed && step >= 1 && step <= 3) {
    return {
      responses: [
        { speaker: "alex", text: "Yeah, that's true." },
        { speaker: "leo", text: "Good point, we should mention that." }
      ],
      newState: { ...state, step: step + 1 }
    };
  }
  
  switch (step) {
    case 0:
      return {
        responses: [{ speaker: "leo", text: "Now Effects. What impact does " + topic.toLowerCase() + " have on students?" }],
        newState: { ...state, step: 1 }
      };
    case 1:
      return {
        responses: [{ speaker: "bella", text: effects.split(",")[0] + "." }],
        newState: { ...state, step: 2 }
      };
    case 2:
      return {
        responses: [{ speaker: "alex", text: "And " + (effects.split(",")[1] || "other issues") + "." }],
        newState: { ...state, step: 3 }
      };
    case 3:
      return {
        responses: [{ speaker: "leo", text: `Anything to add, ${userName}?` }],
        newState: { ...state, step: 4 }
      };
    case 4:
      if (userContributed) {
        return {
          responses: [
            { speaker: "alex", text: "True, that's a big one." },
            { speaker: "leo", text: "Alright, let's move to Solutions." }
          ],
          newState: { phase: "structure_solutions", step: 0, chosenTopic: topic }
        };
      } else {
        return {
          responses: [{ speaker: "alex", text: "Okay, onto Solutions." }],
          newState: { phase: "structure_solutions", step: 0, chosenTopic: topic }
        };
      }
    default:
      return {
        responses: [],
        newState: { phase: "structure_solutions", step: 0, chosenTopic: topic }
      };
  }
}

// ============================================
// STRUCTURE SOLUTIONS 阶段 - 使用实际topic
// ============================================

function structureSolutionsPhase(state, msg, userName) {
  const step = state.step || 0;
  const topic = state.chosenTopic || "this issue";
  
  // SOLUTIONS - 如何解决/应对这个问题
  const solutionExamples = {
    "Online Learning": "create a dedicated study space, use the Pomodoro technique, join online study groups",
    "Stress and Mental Health": "practice mindfulness, seek counseling services, maintain work-life balance",
    "Procrastination": "break tasks into smaller chunks, set specific deadlines, use accountability partners",
    "Social Media and Study Habits": "use app blockers during study time, schedule specific social media breaks, turn off notifications",
    "Group Work vs Individual Work": "establish clear roles early, use project management tools, have regular check-ins"
  };
  
  const solutions = solutionExamples[topic] || "various strategies";
  
  // 用户在任何时候说了有意义的内容，都要回应
  const userContributed = msg.length > 3 && !msg.match(/^(no|nope|nothing|ok|okay|good|sure|fine|yes|yeah|yep|yup|idk|i don't know|alright|right|cool|nice|that's good|that's it)$/i);
  
  if (userContributed && step >= 1 && step <= 4) {
    return {
      responses: [
        { speaker: "leo", text: "Nice one!" },
        { speaker: "alex", text: "Yeah, that could really help." }
      ],
      newState: { ...state, step: step + 1 }
    };
  }
  
  switch (step) {
    case 0:
      return {
        responses: [{ speaker: "leo", text: "Last one: Solutions. How can students deal with " + topic.toLowerCase() + "?" }],
        newState: { ...state, step: 1 }
      };
    case 1:
      return {
        responses: [{ speaker: "alex", text: solutions.split(",")[0] + "." }],
        newState: { ...state, step: 2 }
      };
    case 2:
      return {
        responses: [{ speaker: "bella", text: (solutions.split(",")[1] || "Other methods") + "." }],
        newState: { ...state, step: 3 }
      };
    case 3:
      return {
        responses: [{ speaker: "leo", text: (solutions.split(",")[2] || "More tips") + "." }],
        newState: { ...state, step: 4 }
      };
    case 4:
      return {
        responses: [{ speaker: "alex", text: `${userName}, any tips to add?` }],
        newState: { ...state, step: 5 }
      };
    case 5:
      if (userContributed) {
        return {
          responses: [
            { speaker: "leo", text: "Great idea!" },
            { speaker: "alex", text: "Alright, I think we've got a solid structure." }
          ],
          newState: { phase: "structure_confirm", step: 0, chosenTopic: topic }
        };
      } else {
        return {
          responses: [{ speaker: "alex", text: "Cool, I think we're good on structure." }],
          newState: { phase: "structure_confirm", step: 0, chosenTopic: topic }
        };
      }
    default:
      return {
        responses: [],
        newState: { phase: "structure_confirm", step: 0, chosenTopic: topic }
      };
  }
}

// ============================================
// STRUCTURE CONFIRM 阶段
// ============================================

function structureConfirmPhase(state, msg, userName) {
  const topic = state.chosenTopic;
  return {
    responses: [
      { speaker: "leo", text: "Okay, structure is done: Causes, Effects, Solutions." },
      { speaker: "alex", text: "Let's divide up the work." }
    ],
    newState: { phase: "task_claim", step: 0, chosenTopic: topic }
  };
}

// ============================================
// TASK CLAIM 阶段 - Agent认领任务
// ============================================

function taskClaimPhase(state, msg, userName) {
  const step = state.step || 0;
  const topic = state.chosenTopic;
  const tasks = state.tasks || {};
  
  // 用户主动认领任务 - 直接处理，不跳转
  const wantsIntro = msg.match(/\b(intro)/i);
  const wantsCauses = msg.match(/\b(cause)/i);
  const wantsEffects = msg.match(/\b(effect)/i);
  const wantsSolutions = msg.match(/\b(solution)/i);
  const wantsConclusion = msg.match(/\b(conclusion)/i);
  
  if (wantsIntro || wantsCauses || wantsEffects || wantsSolutions || wantsConclusion) {
    // 用户选了东西，直接分配
    const newTasks = { intro: "Alex", effects: "Leo" };
    let userParts = [];
    let responses = [];
    
    // 用户同时要 conclusion 和 solution
    if (wantsConclusion && wantsSolutions) {
      newTasks.conclusion = userName;
      newTasks.solutions = userName;
      newTasks.causes = "Bella";
      userParts.push("Conclusion");
      userParts.push("Solutions");
      responses.push({ speaker: "bella", text: "Oh wow, you want both? Okay, I'll do Causes then." });
      responses.push({ speaker: "alex", text: "Nice, thanks for taking on more!" });
    }
    // 只要 conclusion
    else if (wantsConclusion) {
      newTasks.conclusion = userName;
      newTasks.causes = "Bella";
      newTasks.solutions = "Bella";
      userParts.push("Conclusion");
      responses.push({ speaker: "bella", text: "Oh, I wanted Conclusion... I'll take Causes then." });
    }
    // 只要 solutions
    else if (wantsSolutions) {
      newTasks.solutions = userName;
      newTasks.conclusion = "Bella";
      newTasks.causes = "Bella";
      userParts.push("Solutions");
      responses.push({ speaker: "bella", text: "You want Solutions? Okay, I'll do Conclusion and Causes." });
    }
    // 要 causes
    else if (wantsCauses) {
      newTasks.causes = userName;
      newTasks.solutions = "Bella";
      newTasks.conclusion = "Bella";
      userParts.push("Causes");
      responses.push({ speaker: "leo", text: "Got it!" });
    }
    // 要 effects
    else if (wantsEffects) {
      newTasks.effects = userName;
      newTasks.causes = "Leo";
      newTasks.solutions = "Bella";
      newTasks.conclusion = "Bella";
      userParts.push("Effects");
      responses.push({ speaker: "leo", text: "Effects? I was gonna do that... Okay, I'll take Causes." });
    }
    // 要 intro
    else if (wantsIntro) {
      newTasks.intro = userName;
      newTasks.causes = "Alex";
      newTasks.solutions = "Bella";
      newTasks.conclusion = "Bella";
      userParts.push("Intro");
      responses.push({ speaker: "alex", text: "What? You want Intro? That's my thing!" });
      responses.push({ speaker: "alex", text: "Fine... I'll do Causes then." });
    }
    
    return {
      responses,
      newState: { phase: "task_summary", step: 0, tasks: newTasks, userTask: userParts.join(" and "), chosenTopic: topic }
    };
  }
  
  // 正常流程 - agents 认领
  switch (step) {
    case 0:
      return {
        responses: [{ speaker: "alex", text: "I'll do Intro!" }],
        newState: { ...state, step: 1, tasks: { intro: "Alex" } }
      };
    case 1:
      return {
        responses: [{ speaker: "leo", text: "I can take Effects." }],
        newState: { ...state, step: 2, tasks: { ...state.tasks, effects: "Leo" } }
      };
    case 2:
      return {
        responses: [{ speaker: "bella", text: "Conclusion for me." }],
        newState: { ...state, step: 3, tasks: { ...state.tasks, conclusion: "Bella" } }
      };
    case 3:
      return {
        responses: [{ speaker: "alex", text: "Bella, Conclusion is kinda short. Maybe you can take Solutions too?" }],
        newState: { ...state, step: 4 }
      };
    case 4:
      return {
        responses: [{ speaker: "bella", text: "Sure, I can do both." }],
        newState: { phase: "task_ask", step: 0, tasks: { ...state.tasks, solutions: "Bella" }, chosenTopic: topic }
      };
    default:
      return {
        responses: [],
        newState: { phase: "task_ask", step: 0, tasks: state.tasks, chosenTopic: topic }
      };
  }
}

// ============================================
// TASK ASK 阶段 - 问用户
// ============================================

function taskAskPhase(state, msg, userName) {
  const topic = state.chosenTopic;
  return {
    responses: [{ speaker: "leo", text: `So ${userName}, that leaves Causes for you. You okay with that, or want to swap?` }],
    newState: { phase: "task_respond", step: 0, tasks: state.tasks, chosenTopic: topic }
  };
}

// ============================================
// TASK RESPOND 阶段 - 处理用户选择
// ============================================

function taskRespondPhase(state, msg, userName) {
  const tasks = state.tasks || { intro: "Alex", effects: "Leo", solutions: "Bella", conclusion: "Bella" };
  const topic = state.chosenTopic;
  
  // 检测用户想要哪些部分
  const wantsIntro = msg.match(/\b(intro)/i);
  const wantsCauses = msg.match(/\b(cause)/i);
  const wantsEffects = msg.match(/\b(effect)/i);
  const wantsSolutions = msg.match(/\b(solution)/i);
  const wantsConclusion = msg.match(/\b(conclusion)/i);
  const wantsMore = msg.match(/\b(more|also|too|and|both)\b/i);
  
  // 用户想要多个部分
  if ((wantsConclusion && wantsSolutions) || (wantsMore && (wantsSolutions || wantsConclusion))) {
    const newTasks = { ...tasks };
    let userParts = [];
    
    if (wantsConclusion || tasks.conclusion === userName) {
      newTasks.conclusion = userName;
      userParts.push("Conclusion");
    }
    if (wantsSolutions) {
      newTasks.solutions = userName;
      userParts.push("Solutions");
    }
    if (wantsCauses) {
      newTasks.causes = userName;
      userParts.push("Causes");
    }
    
    // Bella 需要重新分配
    if (newTasks.conclusion === userName && newTasks.solutions === userName) {
      newTasks.causes = "Bella";
    } else if (newTasks.solutions === userName) {
      newTasks.causes = "Bella";
    }
    
    return {
      responses: [
        { speaker: "bella", text: "Okay, I'll take Causes then." },
        { speaker: "alex", text: "Nice, thanks for stepping up!" }
      ],
      newState: { phase: "task_summary", step: 0, tasks: newTasks, userTask: userParts.join(" and "), chosenTopic: topic }
    };
  }
  
  // 用户同意做 Causes
  if (msg.match(/^(yes|yeah|ok|okay|sure|fine|sounds good|yep|yup|alright|i'm good|good|no problem|i can do that)$/i) ||
      (wantsCauses && !wantsEffects && !wantsSolutions && !wantsConclusion && !wantsIntro)) {
    return {
      responses: [{ speaker: "alex", text: "Cool!" }],
      newState: { phase: "task_summary", step: 0, tasks: { ...tasks, causes: userName }, userTask: "Causes", chosenTopic: topic }
    };
  }
  
  // 用户想要 Intro
  if (wantsIntro) {
    return {
      responses: [
        { speaker: "alex", text: "Wait, you want Intro? That's mine..." },
        { speaker: "alex", text: "Ugh fine, I'll do Causes then." }
      ],
      newState: { phase: "task_summary", step: 0, tasks: { ...tasks, intro: userName, causes: "Alex" }, userTask: "Intro", chosenTopic: topic }
    };
  }
  
  // 用户想要 Effects
  if (wantsEffects) {
    return {
      responses: [
        { speaker: "leo", text: "Effects? I was gonna do that one." },
        { speaker: "leo", text: "Okay, I'll take Causes instead." }
      ],
      newState: { phase: "task_summary", step: 0, tasks: { ...tasks, effects: userName, causes: "Leo" }, userTask: "Effects", chosenTopic: topic }
    };
  }
  
  // 用户只想要 Solutions
  if (wantsSolutions && !wantsConclusion) {
    return {
      responses: [
        { speaker: "bella", text: "You want Solutions? Okay, I'll just do Conclusion and Causes." }
      ],
      newState: { phase: "task_summary", step: 0, tasks: { ...tasks, solutions: userName, causes: "Bella" }, userTask: "Solutions", chosenTopic: topic }
    };
  }
  
  // 用户只想要 Conclusion
  if (wantsConclusion && !wantsSolutions) {
    return {
      responses: [
        { speaker: "bella", text: "Oh, I wanted Conclusion..." },
        { speaker: "bella", text: "Fine, I'll do Causes instead." }
      ],
      newState: { phase: "task_summary", step: 0, tasks: { ...tasks, conclusion: userName, causes: "Bella" }, userTask: "Conclusion", chosenTopic: topic }
    };
  }
  
  // 用户说了别的或者没说清楚，再问一次
  if (state.step >= 2) {
    // 问了太多次，默认分配
    return {
      responses: [{ speaker: "leo", text: "Alright, you take Causes then!" }],
      newState: { phase: "task_summary", step: 0, tasks: { ...tasks, causes: userName }, userTask: "Causes", chosenTopic: topic }
    };
  }
  
  return {
    responses: [{ speaker: "alex", text: "So Causes works for you? Or you wanna swap with someone?" }],
    newState: { phase: "task_respond", step: (state.step || 0) + 1, tasks, chosenTopic: topic }
  };
}

// ============================================
// TASK SUMMARY 阶段 - 总结分工
// ============================================

function taskSummaryPhase(state, msg, userName) {
  const tasks = state.tasks || {};
  const topic = state.chosenTopic;
  
  // 确保所有任务都有分配
  const intro = tasks.intro || "Alex";
  const causes = tasks.causes || userName;
  const effects = tasks.effects || "Leo";
  const solutions = tasks.solutions || "Bella";
  const conclusion = tasks.conclusion || "Bella";
  
  // 合并同一个人的任务
  const assignments = {};
  assignments[intro] = assignments[intro] || [];
  assignments[intro].push("Intro");
  assignments[causes] = assignments[causes] || [];
  assignments[causes].push("Causes");
  assignments[effects] = assignments[effects] || [];
  assignments[effects].push("Effects");
  assignments[solutions] = assignments[solutions] || [];
  assignments[solutions].push("Solutions");
  assignments[conclusion] = assignments[conclusion] || [];
  assignments[conclusion].push("Conclusion");
  
  // 生成总结文本
  const parts = Object.entries(assignments).map(([person, tasks]) => {
    return person + " does " + tasks.join(" and ");
  });
  
  return {
    responses: [{ speaker: "leo", text: "So: " + parts.join(", ") + ". Everyone good?" }],
    newState: { phase: "ending", step: 0, tasks: { intro, causes, effects, solutions, conclusion }, chosenTopic: topic }
  };
}

// ============================================
// ENDING 阶段
// ============================================

function endingPhase(state, msg, userName) {
  const step = state.step || 0;
  
  switch (step) {
    case 0:
      return {
        responses: [{ speaker: "alex", text: "Sounds good to me!" }],
        newState: { phase: "ending", step: 1 }
      };
    case 1:
      return {
        responses: [{ speaker: "bella", text: "Yeah." }],
        newState: { phase: "ending", step: 2 }
      };
    case 2:
      return {
        responses: [
          { speaker: "leo", text: "Awesome! Good luck everyone. Let's crush this presentation." },
          { speaker: "alex", text: "See you guys!" },
          { speaker: "bella", text: "Bye." }
        ],
        newState: { phase: "done" }
      };
    default:
      return { responses: [], newState: { phase: "done" } };
  }
}

// ============================================
// 主动推进对话（用户沉默时）
// ============================================

function proactiveAdvance(state, userName) {
  const phase = state.phase;
  const proactiveCount = state.proactiveCount || 0;
  
  // 限制主动说话次数，防止无限重复
  if (proactiveCount >= 1) {
    // 直接推进到下一步
    return orchestrate({ ...state, proactiveCount: 0 }, "ok", userName);
  }
  
  // 根据阶段推进
  if (phase === "greeting") {
    return {
      responses: [{ speaker: "alex", text: "So, should we start working on the project?" }],
      newState: { ...state, proactiveCount: proactiveCount + 1 }
    };
  }
  
  if (phase === "topic_choose" || phase === "topic_debate") {
    return {
      responses: [{ speaker: "alex", text: "What do you think?" }],
      newState: { ...state, proactiveCount: proactiveCount + 1 }
    };
  }
  
  if (phase === "task_respond") {
    return {
      responses: [{ speaker: "leo", text: "Causes or Solutions?" }],
      newState: { ...state, proactiveCount: proactiveCount + 1 }
    };
  }
  
  // 其他阶段直接推进
  return orchestrate({ ...state, proactiveCount: 0 }, "ok", userName);
}

// ============================================
// 工具函数
// ============================================

function random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function detectTopicChoice(msg) {
  // 计算用户提到了几个topic
  let count = 0;
  let lastMatch = null;
  
  if (msg.match(/stress|mental health/i)) { count++; lastMatch = "stress"; }
  if (msg.match(/social media/i)) { count++; lastMatch = "social"; }
  if (msg.match(/group|individual/i)) { count++; lastMatch = "group"; }
  if (msg.match(/online|in-person|in person/i)) { count++; lastMatch = "online"; }
  if (msg.match(/procrastination/i)) { count++; lastMatch = "procrastination"; }
  
  // 如果用户提到多个topic，返回null让团队讨论
  if (count > 1) return null;
  // 如果用户在问问题（what do you think等），返回null
  if (msg.match(/what.*(you|do you|guys|team|we|think|should)/i)) return null;
  
  return lastMatch;
}

// ============================================
// 简单聊天 API
// ============================================

app.post("/chat", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }
    const message = req.body?.message;
    if (!message) return res.status(400).json({ error: "Missing message" });
    
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Reply with ONE short sentence only." },
        { role: "user", content: message },
      ],
      temperature: 0.7,
      max_tokens: 80,
    }, { timeout: 60000 });
    
    return res.json({ reply: completion.choices?.[0]?.message?.content?.trim() || "..." });
  } catch (e) {
    console.error("OPENAI ERROR:", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});
// ============================================
// 生产环境：serve 前端静态文件
// ============================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "dist")));
  
  app.get("*", (req, res) => {
    if (!req.path.startsWith("/chat") && !req.path.startsWith("/orchestrate")) {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    }
  });
}

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

