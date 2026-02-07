const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { corsHeaders, respond, handleMethodCheck, getDb } = require("./shared");

exports.handler = async (event) => {
  const headers = corsHeaders("POST, OPTIONS");

  const methodError = handleMethodCheck(event, "POST", headers);
  if (methodError) return methodError;

  try {
    const { email, password, name } = JSON.parse(event.body);

    if (!email || !password) {
      return respond(400, headers, { error: "Email and password are required" });
    }

    if (password.length < 6) {
      return respond(400, headers, { error: "Password must be at least 6 characters" });
    }

    const sql = getDb();

    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length > 0) {
      return respond(409, headers, { error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await sql`
            INSERT INTO users (email, password_hash, name)
            VALUES (${email}, ${passwordHash}, ${name || null})
            RETURNING id, email, name, created_at
        `;

    const user = result[0];

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return respond(201, headers, {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);
    return respond(500, headers, { error: "Internal server error" });
  }
};
