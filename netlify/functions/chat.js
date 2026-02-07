const { corsHeaders, respond, handleMethodCheck, requireAuth, getDb, stripSourceCitations } = require("./shared");

const SLIDING_WINDOW_SIZE = 10; // Last 10 messages for context (5 Q&A pairs)

// Rewrite vague follow-up questions using conversation history
async function rewriteQueryWithHistory(query, history, apiKey) {
    if (history.length === 0) return query;

    const followUpIndicators = /^(what|how|why|can|is|are|does|do|tell|explain).{0,20}(it|that|this|they|them|those|the same)/i;
    const isShortQuery = query.split(' ').length < 8;

    if (!followUpIndicators.test(query) && !isShortQuery) {
        return query;
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
                model: "x-ai/grok-4.1-fast",
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
        return query;
    }
}

exports.handler = async (event) => {
    const startTime = Date.now();
    const headers = corsHeaders("POST, OPTIONS");

    const methodError = handleMethodCheck(event, "POST", headers);
    if (methodError) return methodError;

    const { user, errorResponse } = requireAuth(event, headers);
    if (errorResponse) return errorResponse;

    try {
        const { query, conversationId } = JSON.parse(event.body);

        if (!query || query.trim() === "") {
            return respond(400, headers, { error: "Query is required" });
        }

        const sql = getDb();

        // 1. Manage conversation session
        let currentConversationId = conversationId;
        if (!currentConversationId) {
            const convResult = await sql`
                INSERT INTO conversations (user_id) VALUES (${user.userId}) 
                RETURNING id
            `;
            currentConversationId = convResult[0].id;
        }

        // 2. Load conversation history (sliding window: last 10 messages)
        const historyResult = await sql`
            SELECT role, content FROM messages 
            WHERE conversation_id = ${currentConversationId}
            ORDER BY created_at DESC 
            LIMIT ${SLIDING_WINDOW_SIZE}
        `;
        const conversationHistory = historyResult.reverse();

        // 3. Rewrite query if it seems like a follow-up
        const standaloneQuery = await rewriteQueryWithHistory(
            query, conversationHistory, process.env.OPENROUTER_API_KEY
        );

        // 4. Generate embedding
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
            console.error("Embedding error:", await embeddingResponse.text());
            return respond(500, headers, { error: "Failed to generate embedding" });
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

        // 6. Save user message to conversation
        await sql`
            INSERT INTO messages (conversation_id, role, content)
            VALUES (${currentConversationId}, 'user', ${query})
        `;

        const modelName = "x-ai/grok-4.1-fast";

        // 7. Handle no results
        if (results.length === 0) {
            const responseTime = Date.now() - startTime;

            const noResultsAnswer = {
                summary: "I couldn't find sufficient information in my knowledge base to fully answer your question.",
                keyPoints: [],
                legalReferences: [],
                details: "The knowledge base does not contain documents that match your query with sufficient relevance. This may be because your question is outside the scope of C11 work permits, immigration policy, or the specific legal documents available.",
                recommendation: "For complex or specific legal questions, I recommend consulting with our professional legal team who can provide personalized guidance.",
                confidence: "low"
            };

            await sql`
                INSERT INTO messages (conversation_id, role, content, sources)
                VALUES (${currentConversationId}, 'assistant', ${JSON.stringify(noResultsAnswer)}, ${JSON.stringify([])})
            `;
            await sql`
                INSERT INTO interactions (user_id, query, answer, sources, model, response_time_ms)
                VALUES (${user.userId}, ${query}, ${JSON.stringify(noResultsAnswer)}, ${JSON.stringify([])}, ${modelName}, ${responseTime})
            `;

            return respond(200, headers, {
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
            });
        }

        // 8. Build context from search results
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

        // 9. Build LLM messages with sliding window history
        const llmMessages = [
            {
                role: "system",
                content: `You are a solution-focused legal assistant helping users who are struggling with their Canadian IRCC applications, particularly C11 work permits.

YOUR MISSION: Help users understand and SOLVE their immigration problems. Users come to you when they're stuck, confused, or facing application challenges.

RESPONSE FORMAT (JSON only):
{
  "summary": "1-2 sentences. State the answer clearly and offer hope/direction.",
  "keyPoints": ["3-5 actionable points. What they NEED to know."],
  "legalReferences": ["Specific sections: 'R205(a)', 'IRPR 200', etc."],
  "details": "2-3 paragraphs. Explain the issue AND the path forward.",
  "recommendation": "Clear next steps they can take TODAY to move forward.",
  "confidence": "high/medium/low"
}

SOLUTION-ORIENTED RULES:
- Focus on WHAT THEY CAN DO, not just what the law says.
- If refused, explain common reasons and how to address them.
- If missing documents, specify exactly what to prepare.
- If confused about process, provide step-by-step guidance.
- Always end with actionable next steps.
- Be empathetic but professional.
- Be BRIEF: max 150 words for details, 50 for summary.
- Answer from provided context only.
- Return ONLY valid JSON.`
            }
        ];

        for (const msg of conversationHistory) {
            llmMessages.push({
                role: msg.role,
                content: typeof msg.content === 'string' && msg.content.startsWith('{')
                    ? JSON.parse(msg.content).summary || msg.content
                    : msg.content
            });
        }

        llmMessages.push({
            role: "user",
            content: `Based on the following legal documents, answer this question:\n\nQUESTION: ${query}\n\nCONTEXT FROM LEGAL DOCUMENTS:\n${context}\n\nRemember to respond with ONLY the JSON structure specified.`
        });

        // 10. Generate answer using LLM with reasoning
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
                reasoning: { enabled: true },
                temperature: 0.1,
                max_tokens: 2000,
            }),
        });

        if (!chatResponse.ok) {
            console.error("Chat error:", await chatResponse.text());
            return respond(500, headers, { error: "Failed to generate response" });
        }

        const chatData = await chatResponse.json();
        const rawAnswer = chatData.choices[0].message.content;

        // 11. Parse structured response
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

        // 12. Save to database (with source citations)
        await sql`
            INSERT INTO messages (conversation_id, role, content, sources)
            VALUES (${currentConversationId}, 'assistant', ${JSON.stringify(structuredAnswer)}, ${JSON.stringify(sources)})
        `;
        await sql`
            INSERT INTO interactions (user_id, query, answer, sources, model, response_time_ms)
            VALUES (${user.userId}, ${query}, ${JSON.stringify(structuredAnswer)}, ${JSON.stringify(sources)}, ${modelName}, ${responseTime})
        `;

        // 13. Strip source citations for clean API response
        const cleanAnswer = {
            ...structuredAnswer,
            summary: stripSourceCitations(structuredAnswer.summary),
            details: stripSourceCitations(structuredAnswer.details),
            recommendation: stripSourceCitations(structuredAnswer.recommendation),
            keyPoints: (structuredAnswer.keyPoints || []).map(stripSourceCitations)
        };

        const confidence = structuredAnswer.confidence || "medium";
        const offerConsultation = confidence === "low" || confidence === "medium";

        return respond(200, headers, {
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
        });
    } catch (error) {
        console.error("Chat error:", error);
        return respond(500, headers, { error: "Internal server error" });
    }
};
