const { corsHeaders, respond, handleMethodCheck, requireAuth, getDb } = require("./shared");

exports.handler = async (event) => {
    const headers = corsHeaders("GET, OPTIONS");

    const methodError = handleMethodCheck(event, "GET", headers);
    if (methodError) return methodError;

    const { user, errorResponse } = requireAuth(event, headers);
    if (errorResponse) return errorResponse;

    try {
        const sql = getDb();
        const conversationId = event.queryStringParameters?.id;

        if (!conversationId) {
            // List all conversations
            const conversations = await sql`
                SELECT c.id, c.created_at, 
                       (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY created_at LIMIT 1) as first_query,
                       (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
                FROM conversations c
                WHERE c.user_id = ${user.userId}
                ORDER BY c.created_at DESC
                LIMIT 20
            `;

            return respond(200, headers, {
                success: true,
                conversations: conversations.map(c => ({
                    id: c.id,
                    firstQuery: c.first_query,
                    messageCount: parseInt(c.message_count),
                    createdAt: c.created_at
                }))
            });
        }

        // Verify conversation belongs to user
        const convCheck = await sql`
            SELECT id FROM conversations 
            WHERE id = ${conversationId}::uuid AND user_id = ${user.userId}
        `;

        if (convCheck.length === 0) {
            return respond(404, headers, { error: "Conversation not found" });
        }

        // Get all messages
        const messages = await sql`
            SELECT role, content, sources, created_at
            FROM messages 
            WHERE conversation_id = ${conversationId}::uuid
            ORDER BY created_at ASC
        `;

        const formattedMessages = messages.map(msg => {
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
                createdAt: msg.created_at
            };
        });

        return respond(200, headers, {
            success: true,
            conversationId,
            messageCount: messages.length,
            messages: formattedMessages
        });
    } catch (error) {
        console.error("Conversation error:", error);
        return respond(500, headers, { error: "Failed to retrieve conversation" });
    }
};
