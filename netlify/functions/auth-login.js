const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { corsHeaders, respond, handleMethodCheck, getDb } = require("./shared");

exports.handler = async (event) => {
    const headers = corsHeaders("POST, OPTIONS");

    const methodError = handleMethodCheck(event, "POST", headers);
    if (methodError) return methodError;

    try {
        const { email, password } = JSON.parse(event.body);

        if (!email || !password) {
            return respond(400, headers, { error: "Email and password are required" });
        }

        const sql = getDb();

        const users = await sql`
            SELECT id, email, name, password_hash, created_at 
            FROM users 
            WHERE email = ${email}
        `;

        if (users.length === 0) {
            return respond(401, headers, { error: "Invalid credentials" });
        }

        const user = users[0];

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return respond(401, headers, { error: "Invalid credentials" });
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        return respond(200, headers, {
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                createdAt: user.created_at,
            },
        });
    } catch (error) {
        console.error("Login error:", error);
        return respond(500, headers, { error: "Internal server error" });
    }
};
