If a user chats for an hour, and you send the entire history every time, you will:

Blow the token limit (and crash the app).

Go broke (you pay for re-reading the same history 50 times).

Confuse the LLM (too much noise).

The Strategy: "Sliding Window" Memory
You do not need a separate "Small RAG" for this. You definitely should use your existing Neon database.

The standard pattern for a POC is the Sliding Window:

Storage: Save every message in Neon (for audit/legal logs).

Context: Only send the last 6-10 messages to the LLM.

Why? In legal chat, users rarely reference something from 50 messages ago. They usually refer to the immediate previous answer ("What does that clause mean?").

Step 1: Database Upgrade (Neon)
We need to add tables to store conversations. Go to your Neon SQL Editor and run this:

SQL

-- 1. Table to track unique conversations
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- 2. Table to store the actual messages (User + AI)
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    conversation_id UUID REFERENCES conversations(id),
    role TEXT CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 3. Simple index for fast retrieval of recent history
CREATE INDEX idx_messages_conversation_id ON messages(conversation_id, created_at DESC);
Step 2: The Logic (Netlify Edge Function)
We need to update your API to do three things:

Load History: Fetch the last 6 messages from Neon.

Refine Search: Use the history to "rewrite" the search query (e.g., if user says "What is the penalty?", and history was about "NDA", the search becomes "NDA penalty").

Save: Store the new interaction.

File: netlify/edge-functions/legal-api.ts

TypeScript

import { Client } from "https://esm.sh/@neondatabase/serverless";

// Helper: Rewrites vague questions using history
// Example: User asks "What is the penalty?" -> LLM rewrites to "What is the penalty for NDA breach?"
async function rewriteQuery(query: string, history: any[], openRouterKey: string) {
  if (history.length === 0) return query; // No history? No rewrite needed.

  const historyText = history.map(m => `${m.role}: ${m.content}`).join("\n");
  
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${openRouterKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-3.5-turbo", // Fast & cheap for this simple task
      messages: [
        { role: "system", content: "Rewrite the last user question to be standalone based on the history. Output ONLY the rewritten question." },
        { role: "user", content: `HISTORY:\n${historyText}\n\nUSER QUESTION: ${query}` }
      ]
    })
  });
  const data = await resp.json();
  return data.choices[0]?.message?.content || query;
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  
  try {
    // Expect conversation_id from frontend (or null if new)
    const { query, conversation_id } = await req.json();
    const client = new Client(Deno.env.get("DATABASE_URL"));
    await client.connect();

    // 1. MANAGE CONVERSATION ID
    let currentConvId = conversation_id;
    if (!currentConvId) {
      const result = await client.query("INSERT INTO conversations DEFAULT VALUES RETURNING id");
      currentConvId = result.rows[0].id;
    }

    // 2. LOAD HISTORY (Sliding Window: Last 6 messages)
    const historyRes = await client.query(`
      SELECT role, content FROM messages 
      WHERE conversation_id = $1 
      ORDER BY created_at DESC LIMIT 6
    `, [currentConvId]);
    // Reverse to get chronological order (Oldest -> Newest)
    const history = historyRes.rows.reverse();

    // 3. REWRITE QUERY (Critical for "Follow-up" accuracy)
    const standaloneQuery = await rewriteQuery(query, history, Deno.env.get("OPENROUTER_API_KEY"));

    // 4. EMBED & SEARCH (Using rewritten query)
    const embeddingResp = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: standaloneQuery })
    });
    const vector = (await embeddingResp.json()).data[0].embedding;

    const searchRes = await client.query(`
      SELECT content, filename, section 
      FROM documents 
      ORDER BY embedding <=> $1::vector 
      LIMIT 5
    `, [JSON.stringify(vector)]);

    const context = searchRes.rows.map(r => 
      `SOURCE: ${r.filename} (Section: ${r.section})\nCONTENT: ${r.content}`
    ).join("\n\n");

    // 5. SAVE USER MESSAGE
    await client.query("INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)", [currentConvId, query]);

    // 6. GENERATE ANSWER (Streaming)
    const chatResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-3.5-sonnet",
        stream: true,
        messages: [
          { role: "system", content: "You are a legal assistant. Answer strictly based on the provided CONTEXT." },
          ...history.map(m => ({ role: m.role, content: m.content })), // Inject History
          { role: "user", content: `CONTEXT:\n${context}\n\nQUESTION: ${query}` }
        ]
      })
    });

    // 7. STREAM & SAVE AI RESPONSE
    // (We need to capture the full stream to save it to DB. 
    // For simplicity in this POC, we can save the *query* now, 
    // but saving the *streamed answer* requires a bit more client-side handling 
    // or a "StreamTransform" on the server. 
    // BELOW: Simplified approach - we just stream to user. 
    // Ideally, frontend sends the full answer back to a "save-message" endpoint after generation is done.)

    // Pass the conversation_id back to frontend in a header so it can reuse it
    const headers = new Headers(chatResp.headers);
    headers.set("x-conversation-id", currentConvId);
    headers.set("Access-Control-Allow-Origin", "*");

    return new Response(chatResp.body, { headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};