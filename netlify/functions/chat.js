const { neon } = require("@neondatabase/serverless");
const jwt = require("jsonwebtoken");

// Verify JWT token
function verifyToken(authHeader) {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return null;
    }

    const token = authHeader.substring(7);
    try {
        return jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return null;
    }
}

exports.handler = async (event) => {
    // CORS headers
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
    };

    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers, body: "" };
    }

    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Method not allowed" }),
        };
    }

    // Verify authentication
    const user = verifyToken(event.headers.authorization || event.headers.Authorization);
    if (!user) {
        return {
            statusCode: 401,
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Unauthorized" }),
        };
    }

    try {
        const { query } = JSON.parse(event.body);

        if (!query || query.trim() === "") {
            return {
                statusCode: 400,
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Query is required" }),
            };
        }

        // 1. Generate embedding for user query
        const embeddingResponse = await fetch("https://openrouter.ai/api/v1/embeddings", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "openai/text-embedding-3-small",
                input: query,
            }),
        });

        if (!embeddingResponse.ok) {
            const errorText = await embeddingResponse.text();
            console.error("Embedding error:", errorText);
            return {
                statusCode: 500,
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Failed to generate embedding" }),
            };
        }

        const embeddingData = await embeddingResponse.json();
        const queryVector = embeddingData.data[0].embedding;

        // 2. Vector search in Neon
        const sql = neon(process.env.DATABASE_URL);

        const results = await sql`
      SELECT content, filename, section,
             1 - (embedding <=> ${JSON.stringify(queryVector)}::vector) as similarity
      FROM documents
      WHERE 1 - (embedding <=> ${JSON.stringify(queryVector)}::vector) > 0.4
      ORDER BY embedding <=> ${JSON.stringify(queryVector)}::vector
      LIMIT 8
    `;

        if (results.length === 0) {
            return {
                statusCode: 200,
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({
                    answer: "I don't have any relevant information in my knowledge base to answer this question. Please make sure the knowledge base has been populated with documents.",
                    sources: [],
                }),
            };
        }

        // 3. Build context from search results
        const context = results
            .map((r, i) => `[Source ${i + 1}] ${r.filename} (${r.section}):\n${r.content}`)
            .join("\n\n---\n\n");

        const sources = results.map((r) => ({
            filename: r.filename,
            section: r.section,
            similarity: parseFloat(r.similarity).toFixed(3),
        }));

        // 4. Generate answer using LLM
        const chatResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "google/gemini-3-flash-preview",
                stream: false,
                messages: [
                    {
                        role: "system",
                        content: `You are a professional legal assistant specializing in Canadian immigration law, particularly work permits and C11 applications. 

Your role is to:
1. Answer questions based ONLY on the provided context from official legal documents
2. Be precise and cite specific sources when possible
3. If the context doesn't contain enough information, clearly state that
4. Use professional but accessible language
5. Structure your answers clearly with key points

Always reference the source documents in your answer using [Source X] notation.`,
                    },
                    {
                        role: "user",
                        content: `Based on the following legal documents, please answer this question:

QUESTION: ${query}

CONTEXT FROM LEGAL DOCUMENTS:
${context}

Provide a professional, well-structured answer with source citations.`,
                    },
                ],
                temperature: 0.1,
                max_tokens: 2000,
            }),
        });

        if (!chatResponse.ok) {
            const errorText = await chatResponse.text();
            console.error("Chat error:", errorText);
            return {
                statusCode: 500,
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Failed to generate response" }),
            };
        }

        const chatData = await chatResponse.json();
        const answer = chatData.choices[0].message.content;

        return {
            statusCode: 200,
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
                answer,
                sources,
                query,
            }),
        };
    } catch (error) {
        console.error("Chat error:", error);
        return {
            statusCode: 500,
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Internal server error" }),
        };
    }
};
