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
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Content-Type": "application/json",
    };

    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers, body: "" };
    }

    if (event.httpMethod !== "GET") {
        return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
    }

    // Verify authentication
    const user = verifyToken(event.headers.authorization || event.headers.Authorization);
    if (!user) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    try {
        const sql = neon(process.env.DATABASE_URL);

        // Get conversationId from query params
        const conversationId = event.queryStringParameters?.id;

        if (!conversationId) {
            // If no conversationId, return list of user's conversations
            const conversations = await sql`
                SELECT c.id, c.created_at, 
                       (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY created_at LIMIT 1) as first_query,
                       (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
                FROM conversations c
                WHERE c.user_id = ${user.userId}
                ORDER BY c.created_at DESC
                LIMIT 20
            `;

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    conversations: conversations.map(c => ({
                        id: c.id,
                        firstQuery: c.first_query,
                        messageCount: parseInt(c.message_count),
                        createdAt: c.created_at
                    }))
                }),
            };
        }

        // Verify conversation belongs to user
        const convCheck = await sql`
            SELECT id FROM conversations 
            WHERE id = ${conversationId}::uuid AND user_id = ${user.userId}
        `;

        if (convCheck.length === 0) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: "Conversation not found" }),
            };
        }

        // Get all messages for the conversation
        const messages = await sql`
            SELECT role, content, sources, created_at
            FROM messages 
            WHERE conversation_id = ${conversationId}::uuid
            ORDER BY created_at ASC
        `;

        // Parse content and format response
        const formattedMessages = messages.map(msg => {
            let parsedContent = msg.content;
            try {
                if (typeof msg.content === 'string' && msg.content.startsWith('{')) {
                    parsedContent = JSON.parse(msg.content);
                }
            } catch (e) {
                // Keep as string if parsing fails
            }

            return {
                role: msg.role,
                content: parsedContent,
                sources: msg.sources || [],
                createdAt: msg.created_at
            };
        });

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                conversationId: conversationId,
                messageCount: messages.length,
                messages: formattedMessages
            }),
        };
    } catch (error) {
        console.error("Conversation error:", error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Failed to retrieve conversation" }),
        };
    }
};
