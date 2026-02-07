const { corsHeaders, respond, handleMethodCheck, requireAuth, getDb } = require("./shared");

exports.handler = async (event) => {
    const headers = corsHeaders("GET, OPTIONS");

    const methodError = handleMethodCheck(event, "GET", headers);
    if (methodError) return methodError;

    const { user, errorResponse } = requireAuth(event, headers);
    if (errorResponse) return errorResponse;

    try {
        const sql = getDb();
        const params = event.queryStringParameters || {};
        const limit = Math.min(parseInt(params.limit) || 20, 50);
        const offset = parseInt(params.offset) || 0;

        // Get conversations with grouped messages
        const conversations = await sql`
            SELECT 
                c.id as conversation_id,
                c.created_at as conversation_started,
                (
                    SELECT json_agg(
                        json_build_object(
                            'role', m.role,
                            'content', m.content,
                            'sources', m.sources,
                            'createdAt', m.created_at
                        ) ORDER BY m.created_at ASC
                    )
                    FROM messages m 
                    WHERE m.conversation_id = c.id
                ) as messages,
                (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY created_at LIMIT 1) as first_query,
                (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
            FROM conversations c
            WHERE c.user_id = ${user.userId}
            ORDER BY c.created_at DESC
            LIMIT ${limit}
            OFFSET ${offset}
        `;

        const countResult = await sql`
            SELECT COUNT(*) as total FROM conversations WHERE user_id = ${user.userId}
        `;
        const total = parseInt(countResult[0].total);

        // Format response
        const history = conversations.map(conv => {
            const messages = (conv.messages || []).map(msg => {
                let parsedContent = msg.content;
                try {
                    if (typeof msg.content === 'string' && msg.content.startsWith('{')) {
                        parsedContent = JSON.parse(msg.content);
                    }
                } catch (e) { /* Keep as string */ }
                return {
                    role: msg.role,
                    content: parsedContent,
                    sources: msg.sources || [],
                    createdAt: msg.createdAt
                };
            });

            return {
                conversationId: conv.conversation_id,
                firstQuery: conv.first_query,
                messageCount: parseInt(conv.message_count),
                startedAt: conv.conversation_started,
                messages
            };
        });

        return respond(200, headers, {
            success: true,
            conversations: history,
            pagination: { total, limit, offset, hasMore: offset + limit < total }
        });
    } catch (error) {
        console.error("Chat history error:", error);
        return respond(500, headers, { error: "Failed to retrieve chat history" });
    }
};
