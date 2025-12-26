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

// Generate summary of conversation using Grok
async function generateConversationSummary(interactions, apiKey) {
    if (!interactions || interactions.length === 0) {
        return "No previous conversation history available.";
    }

    const conversationText = interactions.map((i, idx) => {
        const answer = typeof i.answer === 'string' ?
            (i.answer.startsWith('{') ? JSON.parse(i.answer) : { summary: i.answer }) :
            i.answer;
        return `Q${idx + 1}: ${i.query}\nA${idx + 1}: ${answer?.summary || answer?.details || 'No response'}`;
    }).join("\n\n");

    try {
        const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "x-ai/grok-4.1-fast",
                messages: [
                    {
                        role: "system",
                        content: `You are a legal case analyst. Summarize the following conversation between a client and an AI legal assistant into a concise case brief for a lawyer. Include:
1. **Client's Main Concern** - What is the core issue?
2. **Topics Discussed** - Key areas covered
3. **AI Guidance Given** - Summary of advice provided
4. **Potential Issues** - Areas needing professional attention
5. **Recommended Next Steps** - What the lawyer should focus on

Keep the summary professional and under 300 words.`
                    },
                    {
                        role: "user",
                        content: `CONVERSATION:\n${conversationText}`
                    }
                ],
                max_tokens: 500,
                temperature: 0.3
            })
        });

        const data = await resp.json();
        return data.choices?.[0]?.message?.content || "Summary generation failed.";
    } catch (error) {
        console.error("Summary generation error:", error);
        return "Error generating summary. Please review the full conversation below.";
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
        const { contactEmail, contactPhone, chatHistory, originalQuery, additionalNotes, feeAcknowledged } = JSON.parse(event.body);

        // Validation - must acknowledge fees first
        if (!feeAcknowledged) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: "Fee acknowledgment required",
                    requiresAcknowledgment: true,
                    feeDisclosure: "Professional legal consultation may incur fees. By proceeding, you acknowledge that fees may apply and our team will discuss pricing before any chargeable work begins.",
                    action: "Please set feeAcknowledged to true to confirm you understand fees may apply."
                }),
            };
        }

        if (!contactEmail || !contactPhone) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Contact email and phone are required" }),
            };
        }

        const sql = neon(process.env.DATABASE_URL);

        // Get user details
        const users = await sql`SELECT email, name FROM users WHERE id = ${user.userId}`;
        const userData = users[0] || { email: user.email, name: "Unknown" };

        // Fetch ALL user's past interactions from database
        const allInteractions = await sql`
            SELECT query, answer, sources, created_at 
            FROM interactions 
            WHERE user_id = ${user.userId}
            ORDER BY created_at ASC
        `;

        // Generate LLM summary of the entire conversation history
        const llmSummary = await generateConversationSummary(
            allInteractions,
            process.env.OPENROUTER_API_KEY
        );

        // Store consultation request in database
        const consultationResult = await sql`
            INSERT INTO consultations (user_id, contact_email, contact_phone, original_query, chat_history, additional_notes, status)
            VALUES (${user.userId}, ${contactEmail}, ${contactPhone}, ${originalQuery || ""}, ${JSON.stringify(allInteractions)}, ${additionalNotes || ""}, 'pending')
            RETURNING id, created_at
        `;
        const consultation = consultationResult[0];

        // Format full conversation history for email
        const fullConversation = allInteractions.map((interaction, i) => {
            const answer = typeof interaction.answer === 'string' ?
                (interaction.answer.startsWith('{') ? JSON.parse(interaction.answer) : { details: interaction.answer }) :
                interaction.answer;

            const sources = interaction.sources || [];
            const sourceList = sources.length > 0
                ? `<br><em>Sources: ${sources.map(s => s.filename).slice(0, 3).join(', ')}</em>`
                : '';

            return `
                <div style="margin-bottom: 20px; padding: 15px; background: #f8f9fa; border-radius: 8px;">
                    <div style="color: #2563eb; font-weight: bold;">Question ${i + 1}:</div>
                    <div style="margin: 10px 0;">${interaction.query}</div>
                    <div style="color: #059669; font-weight: bold; margin-top: 10px;">AI Response:</div>
                    <div style="margin: 10px 0;">${answer?.summary || answer?.details || 'No summary available'}</div>
                    ${answer?.keyPoints?.length ? `<div style="margin: 10px 0;"><strong>Key Points:</strong><ul>${answer.keyPoints.map(p => `<li>${p}</li>`).join('')}</ul></div>` : ''}
                    ${answer?.confidence ? `<div><em>Confidence: ${answer.confidence}</em></div>` : ''}
                    ${sourceList}
                    <div style="color: #6b7280; font-size: 12px; margin-top: 10px;">${new Date(interaction.created_at).toLocaleString()}</div>
                </div>
            `;
        }).join('');

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
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; }
        .header { background: #1a365d; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .content { padding: 20px; }
        .section { margin-bottom: 25px; padding: 20px; background: #f7fafc; border-radius: 8px; border-left: 4px solid #3182ce; }
        .summary-section { background: #fef3c7; border-left-color: #f59e0b; }
        .label { font-weight: bold; color: #2d3748; }
        .conversation-container { max-height: 600px; overflow-y: auto; padding: 10px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; }
        .footer { margin-top: 30px; padding: 20px; border-top: 2px solid #3182ce; font-size: 12px; color: #718096; background: #f7fafc; }
        .stats { display: flex; gap: 20px; margin-top: 10px; }
        .stat { background: #e2e8f0; padding: 8px 15px; border-radius: 20px; font-size: 14px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔔 New Consultation Request</h1>
        <p>Request ID: #${consultation.id}</p>
        <div class="stats">
            <span class="stat">📊 ${allInteractions.length} total interactions</span>
            <span class="stat">📅 ${new Date(consultation.created_at).toLocaleDateString()}</span>
        </div>
    </div>
    
    <div class="content">
        <div class="section">
            <h2>📋 Client Information</h2>
            <p><span class="label">Name:</span> ${userData.name || "Not provided"}</p>
            <p><span class="label">App Email:</span> ${userData.email}</p>
            <p><span class="label">Contact Email:</span> ${contactEmail}</p>
            <p><span class="label">Contact Phone:</span> ${contactPhone}</p>
        </div>

        ${additionalNotes ? `
        <div class="section">
            <h2>📝 Client's Additional Notes</h2>
            <p>${additionalNotes}</p>
        </div>
        ` : ""}
        
        <div class="section summary-section">
            <h2>🤖 AI-Generated Case Summary</h2>
            <div style="white-space: pre-wrap;">${llmSummary.replace(/\*\*/g, '<strong>').replace(/\n/g, '<br>')}</div>
        </div>
        
        <div class="section">
            <h2>💬 Full Conversation History (${allInteractions.length} interactions)</h2>
            <div class="conversation-container">
                ${fullConversation || '<p>No conversation history available.</p>'}
            </div>
        </div>
        
        <div class="footer">
            <p>This consultation request was submitted on ${new Date(consultation.created_at).toLocaleString()}.</p>
            <p><strong>✅ The client has acknowledged that professional consultation fees may apply.</strong></p>
            <p><em>Summary generated by x-ai/grok-4.1-fast</em></p>
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
                interactionsIncluded: allInteractions.length,
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
