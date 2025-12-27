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

        // Parse query parameters
        const params = event.queryStringParameters || {};
        const limit = Math.min(parseInt(params.limit) || 20, 50); // Limit conversations, not messages
        const offset = parseInt(params.offset) || 0;

        // Get user's conversations with their messages grouped
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

        // Get total count of conversations
        const countResult = await sql`
            SELECT COUNT(*) as total FROM conversations WHERE user_id = ${user.userId}
        `;
        const total = parseInt(countResult[0].total);

        // Format response - group messages within each conversation
        const history = conversations.map(conv => {
            // Parse messages content
            const messages = (conv.messages || []).map(msg => {
                let parsedContent = msg.content;
                try {
                    if (typeof msg.content === 'string' && msg.content.startsWith('{')) {
                        parsedContent = JSON.parse(msg.content);
                    }
                } catch (e) {
                    // Keep as string
                }
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
                messages: messages
            };
        });

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                conversations: history,
                pagination: {
                    total,
                    limit,
                    offset,
                    hasMore: offset + limit < total
                }
            }),
        };
    } catch (error) {
        console.error("Chat history error:", error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Failed to retrieve chat history" }),
        };
    }
};
