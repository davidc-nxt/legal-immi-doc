const { neon } = require("@neondatabase/serverless");
const jwt = require("jsonwebtoken");

const SLIDING_WINDOW_SIZE = 6; // Last 6 messages for context

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

// Rewrite vague follow-up questions using conversation history
async function rewriteQueryWithHistory(query, history, apiKey) {
    if (history.length === 0) return query;

    // Check if query seems like a follow-up (short, contains pronouns like "it", "that", "this")
    const followUpIndicators = /^(what|how|why|can|is|are|does|do|tell|explain).{0,20}(it|that|this|they|them|those|the same)/i;
    const isShortQuery = query.split(' ').length < 8;

    if (!followUpIndicators.test(query) && !isShortQuery) {
        return query; // Seems standalone, no rewrite needed
    }

    const historyText = history.map(m => `${m.role}: ${m.content.substring(0, 200)}`).join("\n");

    try {
        const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "x-ai/grok-4.1-fast", // Lower cost for simple query rewriting
                messages: [
                    {
                        role: "system",
                        content: "Rewrite the user's question to be standalone based on the conversation history. If the question is already clear and standalone, return it unchanged. Output ONLY the rewritten question, nothing else."
                    },
                    {
                        role: "user",
                        content: `CONVERSATION HISTORY:\n${historyText}\n\nUSER'S QUESTION: ${query}\n\nRewritten standalone question:`
                    }
                ],
                max_tokens: 150,
                temperature: 0.1
            })
        });
        const data = await resp.json();
        return data.choices?.[0]?.message?.content?.trim() || query;
    } catch (error) {
        console.error("Query rewrite error:", error);
        return query; // Fallback to original
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
        const { query, conversationId } = JSON.parse(event.body);

        if (!query || query.trim() === "") {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Query is required" }),
            };
        }

        const sql = neon(process.env.DATABASE_URL);

        // 1. MANAGE CONVERSATION SESSION
        let currentConversationId = conversationId;

        if (!currentConversationId) {
            // Create new conversation
            const convResult = await sql`
                INSERT INTO conversations (user_id) VALUES (${user.userId}) 
                RETURNING id
            `;
            currentConversationId = convResult[0].id;
        }

        // 2. LOAD CONVERSATION HISTORY (Sliding Window: Last 6 messages)
        const historyResult = await sql`
            SELECT role, content FROM messages 
            WHERE conversation_id = ${currentConversationId}
            ORDER BY created_at DESC 
            LIMIT ${SLIDING_WINDOW_SIZE}
        `;
        // Reverse to chronological order (oldest -> newest)
        const conversationHistory = historyResult.reverse();

        // 3. REWRITE QUERY if it seems like a follow-up
        const standaloneQuery = await rewriteQueryWithHistory(
            query,
            conversationHistory,
            process.env.OPENROUTER_API_KEY
        );

        // 4. Generate embedding for the (possibly rewritten) query
        const embeddingResponse = await fetch("https://openrouter.ai/api/v1/embeddings", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "openai/text-embedding-3-small",
                input: standaloneQuery,
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

        // 5. Vector search in Neon
        const results = await sql`
            SELECT content, filename, section,
                   1 - (embedding <=> ${JSON.stringify(queryVector)}::vector) as similarity
            FROM documents
            WHERE 1 - (embedding <=> ${JSON.stringify(queryVector)}::vector) > 0.4
            ORDER BY embedding <=> ${JSON.stringify(queryVector)}::vector
            LIMIT 8
        `;

        // 6. SAVE USER MESSAGE to conversation
        await sql`
            INSERT INTO messages (conversation_id, role, content)
            VALUES (${currentConversationId}, 'user', ${query})
        `;

        if (results.length === 0) {
            const responseTime = Date.now() - startTime;
            const modelName = "google/gemini-3-flash-preview";

            // Standard format response for no results
            const noResultsAnswer = {
                summary: "I couldn't find sufficient information in my knowledge base to fully answer your question.",
                keyPoints: [],
                legalReferences: [],
                details: "The knowledge base does not contain documents that match your query with sufficient relevance. This may be because your question is outside the scope of C11 work permits, immigration policy, or the specific legal documents available.",
                recommendation: "For complex or specific legal questions, I recommend consulting with our professional legal team who can provide personalized guidance.",
                confidence: "low"
            };

            // Save assistant response to messages
            await sql`
                INSERT INTO messages (conversation_id, role, content, sources)
                VALUES (${currentConversationId}, 'assistant', ${JSON.stringify(noResultsAnswer)}, ${JSON.stringify([])})
            `;

            // Log full interaction to interactions table
            await sql`
                INSERT INTO interactions (user_id, query, answer, sources, model, response_time_ms)
                VALUES (${user.userId}, ${query}, ${JSON.stringify(noResultsAnswer)}, ${JSON.stringify([])}, ${modelName}, ${responseTime})
            `;

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    conversationId: currentConversationId,
                    data: noResultsAnswer,
                    sources: [],
                    consultationAvailable: true,
                    consultationPrompt: "Would you like to speak with a legal professional? We can connect you with an immigration lawyer who specializes in C11 work permits. Please note that professional consultation fees may apply.",
                    metadata: {
                        query,
                        rewrittenQuery: standaloneQuery !== query ? standaloneQuery : null,
                        model: modelName,
                        responseTimeMs: responseTime,
                        documentsFound: 0,
                        conversationLength: conversationHistory.length + 1
                    }
                }),
            };
        }

        // 7. Build context from search results
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

        // 8. Build messages array with sliding window history
        const llmMessages = [
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
            }
        ];

        // Add conversation history (sliding window)
        for (const msg of conversationHistory) {
            llmMessages.push({
                role: msg.role,
                content: typeof msg.content === 'string' && msg.content.startsWith('{')
                    ? JSON.parse(msg.content).summary || msg.content
                    : msg.content
            });
        }

        // Add current query with context
        llmMessages.push({
            role: "user",
            content: `Based on the following legal documents, answer this question:

QUESTION: ${query}

CONTEXT FROM LEGAL DOCUMENTS:
${context}

Remember to respond with ONLY the JSON structure specified.`
        });

        // 9. Generate answer using LLM
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
                messages: llmMessages,
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
            const cleanJson = rawAnswer.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            structuredAnswer = JSON.parse(cleanJson);
        } catch (parseError) {
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

        // 10. SAVE ASSISTANT MESSAGE to conversation (with source citations)
        await sql`
            INSERT INTO messages (conversation_id, role, content, sources)
            VALUES (${currentConversationId}, 'assistant', ${JSON.stringify(structuredAnswer)}, ${JSON.stringify(sources)})
        `;

        // 11. Log interaction for analytics (with source citations)
        await sql`
            INSERT INTO interactions (user_id, query, answer, sources, model, response_time_ms)
            VALUES (${user.userId}, ${query}, ${JSON.stringify(structuredAnswer)}, ${JSON.stringify(sources)}, ${modelName}, ${responseTime})
        `;

        // 12. Strip [Source X] citations from API response (keep clean for mobile app)
        const stripSourceCitations = (text) => {
            if (!text) return text;
            return text.replace(/\s*\[Source\s*\d+\]/gi, '').replace(/\s*\[Sources?\s*[\d,\s]+\]/gi, '').trim();
        };

        const cleanAnswer = {
            ...structuredAnswer,
            summary: stripSourceCitations(structuredAnswer.summary),
            details: stripSourceCitations(structuredAnswer.details),
            recommendation: stripSourceCitations(structuredAnswer.recommendation),
            keyPoints: (structuredAnswer.keyPoints || []).map(stripSourceCitations)
        };

        // Determine if consultation should be offered
        const confidence = structuredAnswer.confidence || "medium";
        const offerConsultation = confidence === "low" || confidence === "medium";

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                conversationId: currentConversationId,
                data: cleanAnswer,
                sources,
                consultationAvailable: offerConsultation,
                consultationPrompt: offerConsultation
                    ? "Need more detailed guidance? Connect with our legal team for personalized consultation. Professional fees may apply."
                    : null,
                metadata: {
                    query,
                    rewrittenQuery: standaloneQuery !== query ? standaloneQuery : null,
                    model: modelName,
                    responseTimeMs: responseTime,
                    documentsFound: sources.length,
                    conversationLength: conversationHistory.length + 1
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
