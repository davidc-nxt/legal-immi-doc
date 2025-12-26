const { neon } = require("@neondatabase/serverless");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

exports.handler = async (event) => {
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

    try {
        const { email, password } = JSON.parse(event.body);

        // Validation
        if (!email || !password) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Email and password are required" }),
            };
        }

        // Connect to Neon
        const sql = neon(process.env.DATABASE_URL);

        // Find user
        const users = await sql`
      SELECT id, email, name, password_hash, created_at 
      FROM users 
      WHERE email = ${email}
    `;

        if (users.length === 0) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ error: "Invalid credentials" }),
            };
        }

        const user = users[0];

        // Verify password
        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ error: "Invalid credentials" }),
            };
        }

        // Generate JWT
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                token,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    createdAt: user.created_at,
                },
            }),
        };
    } catch (error) {
        console.error("Login error:", error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Internal server error" }),
        };
    }
};
