export default async (req) => {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
  
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response("Missing API key", { status: 500 });
    }
  
    const { message } = await req.json();
  
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a student in a small group discussion during a class break. Reply with ONE short sentence only."
          },
          { role: "user", content: message }
        ],
        max_tokens: 60,
        temperature: 0.7
      })
    });
  
    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content ?? "…";
  
    return new Response(
      JSON.stringify({ reply }),
      { headers: { "Content-Type": "application/json" } }
    );
  };
  