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
    const startTime = Date.now();

    // CORS headers
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json",
    };

    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers, body: "" };
    }

    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: "Method not allowed" }),
        };
    }

    // Verify authentication
    const user = verifyToken(event.headers.authorization || event.headers.Authorization);
    if (!user) {
        return {
            statusCode: 401,
            headers,
            body: JSON.stringify({ error: "Unauthorized" }),
        };
    }

    try {
        const { query } = JSON.parse(event.body);

        if (!query || query.trim() === "") {
            return {
                statusCode: 400,
                headers,
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
                headers,
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
            const responseTime = Date.now() - startTime;

            // Log interaction even for no results
            await sql`
                INSERT INTO interactions (user_id, query, answer, sources, model, response_time_ms)
                VALUES (${user.userId}, ${query}, ${"No relevant information found"}, ${JSON.stringify([])}, ${"google/gemini-3-flash-preview"}, ${responseTime})
            `;

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: {
                        summary: "I couldn't find sufficient information in my knowledge base to fully answer your question.",
                        keyPoints: [],
                        legalReferences: [],
                        recommendation: "For complex or specific legal questions, I recommend consulting with our professional legal team who can provide personalized guidance.",
                        confidence: "low"
                    },
                    sources: [],
                    consultationAvailable: true,
                    consultationPrompt: "Would you like to speak with a legal professional? We can connect you with an immigration lawyer who specializes in C11 work permits. Please note that professional consultation fees may apply.",
                    metadata: {
                        query,
                        responseTimeMs: responseTime,
                        documentsFound: 0
                    }
                }),
            };
        }

        // 3. Build context from search results
        const context = results
            .map((r, i) => `[Source ${i + 1}] ${r.filename} (${r.section}):\n${r.content}`)
            .join("\n\n---\n\n");

        const sources = results.map((r, i) => ({
            id: i + 1,
            filename: r.filename,
            section: r.section,
            similarity: parseFloat(r.similarity).toFixed(3),
            type: r.section === "Case Laws" ? "case_law" :
                r.section === "ATIP Notes" ? "atip_note" : "policy_document"
        }));

        // 4. Generate answer using LLM with structured output
        const modelName = "google/gemini-3-flash-preview";
        const chatResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: modelName,
                stream: false,
                messages: [
                    {
                        role: "system",
                        content: `You are a professional legal assistant specializing in Canadian immigration law, particularly work permits and C11 applications.

Your response MUST be in the following JSON format:
{
  "summary": "A concise 2-3 sentence summary of the answer",
  "keyPoints": ["Array of key points, each as a clear bullet point"],
  "legalReferences": ["Array of relevant legal references (e.g., 'R205(a)', 'IRPR Section 200')"],
  "details": "Detailed explanation with source citations using [Source X] notation",
  "recommendation": "Practical recommendation or next steps for the user",
  "confidence": "high/medium/low based on how well the sources answer the question"
}

Rules:
1. Answer ONLY based on the provided context
2. Always cite sources using [Source X] notation
3. Be precise with legal terminology
4. If information is incomplete, state it clearly
5. Return ONLY valid JSON, no additional text`
                    },
                    {
                        role: "user",
                        content: `Based on the following legal documents, answer this question:

QUESTION: ${query}

CONTEXT FROM LEGAL DOCUMENTS:
${context}

Remember to respond with ONLY the JSON structure specified.`
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
                headers,
                body: JSON.stringify({ error: "Failed to generate response" }),
            };
        }

        const chatData = await chatResponse.json();
        const rawAnswer = chatData.choices[0].message.content;

        // Parse the structured response
        let structuredAnswer;
        try {
            // Remove markdown code blocks if present
            const cleanJson = rawAnswer.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            structuredAnswer = JSON.parse(cleanJson);
        } catch (parseError) {
            // Fallback if LLM doesn't return valid JSON
            structuredAnswer = {
                summary: rawAnswer.substring(0, 200),
                keyPoints: [],
                legalReferences: [],
                details: rawAnswer,
                recommendation: "",
                confidence: "medium"
            };
        }

        const responseTime = Date.now() - startTime;

        // 5. Log interaction to database for analytics
        await sql`
            INSERT INTO interactions (user_id, query, answer, sources, model, response_time_ms)
            VALUES (${user.userId}, ${query}, ${JSON.stringify(structuredAnswer)}, ${JSON.stringify(sources)}, ${modelName}, ${responseTime})
        `;

        // Determine if consultation should be offered
        const confidence = structuredAnswer.confidence || "medium";
        const offerConsultation = confidence === "low" || confidence === "medium";

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                data: structuredAnswer,
                sources,
                consultationAvailable: offerConsultation,
                consultationPrompt: offerConsultation
                    ? "Need more detailed guidance? Connect with our legal team for personalized consultation. Professional fees may apply."
                    : null,
                metadata: {
                    query,
                    model: modelName,
                    responseTimeMs: responseTime,
                    documentsFound: sources.length
                }
            }),
        };
    } catch (error) {
        console.error("Chat error:", error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Internal server error" }),
        };
    }
};
