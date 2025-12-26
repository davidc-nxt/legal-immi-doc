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
        const limit = Math.min(parseInt(params.limit) || 50, 100); // Max 100
        const offset = parseInt(params.offset) || 0;

        // Get user's chat history
        const interactions = await sql`
            SELECT 
                id,
                query,
                answer,
                sources,
                model,
                response_time_ms,
                created_at
            FROM interactions 
            WHERE user_id = ${user.userId}
            ORDER BY created_at DESC
            LIMIT ${limit}
            OFFSET ${offset}
        `;

        // Get total count
        const countResult = await sql`
            SELECT COUNT(*) as total FROM interactions WHERE user_id = ${user.userId}
        `;
        const total = parseInt(countResult[0].total);

        // Format response
        const history = interactions.map(i => ({
            id: i.id,
            query: i.query,
            answer: typeof i.answer === 'string' ? JSON.parse(i.answer) : i.answer,
            sources: i.sources || [],
            model: i.model,
            responseTimeMs: i.response_time_ms,
            createdAt: i.created_at
        }));

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                data: history,
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
