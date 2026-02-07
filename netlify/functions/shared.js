const { neon } = require("@neondatabase/serverless");
const jwt = require("jsonwebtoken");

/**
 * Verify JWT token from Authorization header
 * @param {string} authHeader - "Bearer <token>"
 * @returns {object|null} Decoded user payload or null
 */
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

/**
 * Build CORS headers for a given set of allowed methods
 * @param {string} methods - e.g. "POST, OPTIONS" or "GET, OPTIONS"
 */
function corsHeaders(methods = "GET, POST, OPTIONS") {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": methods,
        "Content-Type": "application/json",
    };
}

/**
 * Build a standard JSON response
 */
function respond(statusCode, headers, body) {
    return {
        statusCode,
        headers,
        body: JSON.stringify(body),
    };
}

/**
 * Handle CORS preflight and method validation.
 * Returns a response object if the request should be short-circuited, or null to continue.
 * @param {object} event - Netlify event
 * @param {string} allowedMethod - "POST" or "GET"
 * @param {object} headers - CORS headers
 */
function handleMethodCheck(event, allowedMethod, headers) {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers, body: "" };
    }
    if (event.httpMethod !== allowedMethod) {
        return respond(405, headers, { error: "Method not allowed" });
    }
    return null; // Continue processing
}

/**
 * Authenticate the request. Returns the user or an error response.
 * @param {object} event - Netlify event
 * @param {object} headers - CORS headers
 * @returns {{ user: object|null, errorResponse: object|null }}
 */
function requireAuth(event, headers) {
    const user = verifyToken(event.headers.authorization || event.headers.Authorization);
    if (!user) {
        return { user: null, errorResponse: respond(401, headers, { error: "Unauthorized" }) };
    }
    return { user, errorResponse: null };
}

/**
 * Get a Neon SQL tagged template function
 */
function getDb() {
    return neon(process.env.DATABASE_URL);
}

/**
 * Strip [Source X] citations from text for clean API responses
 */
function stripSourceCitations(text) {
    if (!text) return text;
    return text
        .replace(/\s*\[Source\s*\d+(?:\s*,\s*Source\s*\d+)*\]/gi, '')
        .replace(/\s*\[Sources?\s*[\d,\s]+\]/gi, '')
        .replace(/\s*\[Source\s*\d+\]/gi, '')
        .replace(/\s+([.,])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

module.exports = {
    verifyToken,
    corsHeaders,
    respond,
    handleMethodCheck,
    requireAuth,
    getDb,
    stripSourceCitations,
};
