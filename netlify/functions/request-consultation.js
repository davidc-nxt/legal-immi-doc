const { neon } = require("@neondatabase/serverless");
const jwt = require("jsonwebtoken");
const { Resend } = require("resend");

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
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json",
    };

    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers, body: "" };
    }

    if (event.httpMethod !== "POST") {
        return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
    }

    // Verify authentication
    const user = verifyToken(event.headers.authorization || event.headers.Authorization);
    if (!user) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    try {
        const { contactEmail, contactPhone, chatHistory, originalQuery, additionalNotes } = JSON.parse(event.body);

        // Validation
        if (!contactEmail || !contactPhone) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Contact email and phone are required" }),
            };
        }

        if (!chatHistory || !Array.isArray(chatHistory)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Chat history is required" }),
            };
        }

        const sql = neon(process.env.DATABASE_URL);

        // Get user details
        const users = await sql`SELECT email, name FROM users WHERE id = ${user.userId}`;
        const userData = users[0] || { email: user.email, name: "Unknown" };

        // Store consultation request in database
        const consultationResult = await sql`
            INSERT INTO consultations (user_id, contact_email, contact_phone, original_query, chat_history, additional_notes, status)
            VALUES (${user.userId}, ${contactEmail}, ${contactPhone}, ${originalQuery || ""}, ${JSON.stringify(chatHistory)}, ${additionalNotes || ""}, 'pending')
            RETURNING id, created_at
        `;
        const consultation = consultationResult[0];

        // Format chat history for email
        const formattedHistory = chatHistory.map((msg, i) => {
            if (msg.role === "user") {
                return `**User Question ${i + 1}:**\n${msg.content}\n`;
            } else {
                const data = msg.data || {};
                return `**AI Response:**\n${data.summary || msg.content}\n\nKey Points:\n${(data.keyPoints || []).map(p => `• ${p}`).join("\n")}\n\nConfidence: ${data.confidence || "N/A"}\n`;
            }
        }).join("\n---\n\n");

        // Send email to admin lawyer via Resend
        const resend = new Resend(process.env.RESEND_API_KEY);

        const emailResult = await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL,
            to: process.env.ADMIN_EMAIL,
            subject: `[Consultation Request #${consultation.id}] ${originalQuery?.substring(0, 50) || "Legal Inquiry"}...`,
            html: `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .header { background: #1a365d; color: white; padding: 20px; }
        .content { padding: 20px; }
        .section { margin-bottom: 20px; padding: 15px; background: #f7fafc; border-radius: 8px; }
        .label { font-weight: bold; color: #2d3748; }
        .chat-history { background: #edf2f7; padding: 15px; border-radius: 8px; white-space: pre-wrap; }
        .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #718096; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔔 New Consultation Request</h1>
        <p>Request ID: #${consultation.id}</p>
    </div>
    
    <div class="content">
        <div class="section">
            <h2>📋 Client Information</h2>
            <p><span class="label">Name:</span> ${userData.name || "Not provided"}</p>
            <p><span class="label">App Email:</span> ${userData.email}</p>
            <p><span class="label">Contact Email:</span> ${contactEmail}</p>
            <p><span class="label">Contact Phone:</span> ${contactPhone}</p>
        </div>
        
        <div class="section">
            <h2>❓ Original Query</h2>
            <p>${originalQuery || "Not specified"}</p>
        </div>
        
        ${additionalNotes ? `
        <div class="section">
            <h2>📝 Additional Notes from Client</h2>
            <p>${additionalNotes}</p>
        </div>
        ` : ""}
        
        <div class="section">
            <h2>💬 Chat History Summary</h2>
            <div class="chat-history">${formattedHistory.replace(/\n/g, "<br>")}</div>
        </div>
        
        <div class="footer">
            <p>This consultation request was submitted on ${new Date(consultation.created_at).toLocaleString()}.</p>
            <p>The client has been notified that a fee may apply for professional consultation.</p>
        </div>
    </div>
</body>
</html>
            `,
        });

        // Update consultation with email status
        await sql`
            UPDATE consultations 
            SET email_sent = true, email_id = ${emailResult.data?.id || null}
            WHERE id = ${consultation.id}
        `;

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: "Your consultation request has been submitted. Our legal team will contact you within 1-2 business days.",
                consultationId: consultation.id,
                feeNotice: "Please note that professional legal consultation may incur fees. Our team will discuss pricing before any chargeable work begins."
            }),
        };
    } catch (error) {
        console.error("Consultation request error:", error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Failed to submit consultation request" }),
        };
    }
};
