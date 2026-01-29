# API Test Cases

**Base URL**: `https://your-site.netlify.app`  
**Test Date**: 2025-12-26

## Test Summary

| # | Test Case | Status | Notes |
|---|-----------|--------|-------|
| 1 | User Registration | ✅ PASS | Returns token and user object |
| 2 | User Login | ✅ PASS | Returns token for existing user |
| 3 | Chat - High Confidence | ✅ PASS | Returns structured answer with sources, consultationAvailable: false |
| 4 | Chat - Low Confidence | ✅ PASS | Returns answer with consultationAvailable: true and prompt |
| 5 | Consultation Request | ✅ PASS | Email sent to admin, returns consultationId |
| 6 | Auth - Invalid Token | ✅ PASS | Returns 401 Unauthorized |
| 7 | Chat - Missing Query | ✅ PASS | Returns 400 error |

---

## Test 1: User Registration

**Endpoint**: `POST /.netlify/functions/auth-register`

```bash
curl -X POST https://your-site.netlify.app/.netlify/functions/auth-register \
  -H "Content-Type: application/json" \
  -d '{"email":"testuser@example.com","password":"test123","name":"Test User"}'
```

**Expected Response** (201):
```json
{
  "token": "eyJhbG...",
  "user": {
    "id": 3,
    "email": "testuser@example.com",
    "name": "Test User",
    "createdAt": "2025-12-26T03:56:29.828Z"
  }
}
```

**Result**: ✅ PASS

---

## Test 2: User Login

**Endpoint**: `POST /.netlify/functions/auth-login`

```bash
curl -X POST https://your-site.netlify.app/.netlify/functions/auth-login \
  -H "Content-Type: application/json" \
  -d '{"email":"testuser@example.com","password":"test123"}'
```

**Expected Response** (200):
```json
{
  "token": "eyJhbG...",
  "user": {
    "id": 3,
    "email": "testuser@example.com",
    "name": "Test User",
    "createdAt": "2025-12-26T03:56:29.828Z"
  }
}
```

**Result**: ✅ PASS

---

## Test 3: Chat - High Confidence Query

**Endpoint**: `POST /.netlify/functions/chat`

```bash
curl -X POST https://your-site.netlify.app/.netlify/functions/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"query":"What is R205(a) and how does it apply to C11?"}'
```

**Expected Response** (200):
- `success`: true
- `data.confidence`: "high"
- `data.summary`: Non-empty summary
- `data.keyPoints`: Array of key points
- `data.legalReferences`: Array of references
- `consultationAvailable`: false
- `sources`: Array with 3+ documents

**Actual Response**:
```json
{
  "success": true,
  "data": {
    "summary": "R205(a) of the IRPR is the regulatory authority...",
    "keyPoints": ["R205(a) refers to Section 205(a)...", ...],
    "legalReferences": ["Section 205(a) of the IRPR", "SOR/2002-227", ...],
    "details": "Section 205(a) of the IRPR is a regulatory provision...",
    "recommendation": "When applying under C11, ensure...",
    "confidence": "high"
  },
  "sources": [...],
  "consultationAvailable": false,
  "consultationPrompt": null,
  "metadata": {
    "query": "What is R205(a) and how does it apply to C11?",
    "model": "google/gemini-3-flash-preview",
    "responseTimeMs": 6842,
    "documentsFound": 3
  }
}
```

**Result**: ✅ PASS

---

## Test 4: Chat - Low Confidence Query (Out of Scope)

**Endpoint**: `POST /.netlify/functions/chat`

```bash
curl -X POST https://your-site.netlify.app/.netlify/functions/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"query":"How do I apply for Canadian citizenship?"}'
```

**Expected Response** (200):
- `success`: true
- `data.confidence`: "low"
- `consultationAvailable`: true
- `consultationPrompt`: Non-empty string

**Actual Response**:
```json
{
  "success": true,
  "data": {
    "summary": "The provided documents do not contain information on citizenship...",
    "keyPoints": [...],
    "confidence": "low"
  },
  "consultationAvailable": true,
  "consultationPrompt": "Need more detailed guidance? Connect with our legal team for personalized consultation. Professional fees may apply.",
  "metadata": {
    "responseTimeMs": 3191,
    "documentsFound": 8
  }
}
```

**Result**: ✅ PASS

---

## Test 5: Consultation Request

**Endpoint**: `POST /.netlify/functions/request-consultation`

```bash
curl -X POST https://your-site.netlify.app/.netlify/functions/request-consultation \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "contactEmail": "testclient@example.com",
    "contactPhone": "+1-555-123-4567",
    "feeAcknowledged": true,
    "originalQuery": "How do I apply for Canadian citizenship?",
    "chatHistory": [
      {"role": "user", "content": "How do I apply for Canadian citizenship?"},
      {"role": "assistant", "data": {"summary": "No info found", "confidence": "low"}}
    ],
    "additionalNotes": "I have been a PR for 4 years"
  }'
```

**Expected Response** (200):
- `success`: true
- `consultationId`: Number
- `message`: Contains "1-2 business days"
- `feeNotice`: Contains "fees may apply"

**Actual Response**:
```json
{
  "success": true,
  "message": "Your consultation request has been submitted. Our legal team will contact you within 1-2 business days.",
  "consultationId": 3,
  "feeNotice": "Please note that professional legal consultation may incur fees. Our team will discuss pricing before any chargeable work begins."
}
```

**Email Verification**: ✅ Email sent to davidchan.public@gmail.com

**Result**: ✅ PASS

---

## Test 6: Invalid Token

**Endpoint**: `POST /.netlify/functions/chat`

```bash
curl -X POST https://your-site.netlify.app/.netlify/functions/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer invalid_token" \
  -d '{"query":"test"}'
```

**Expected Response** (401):
```json
{"error": "Unauthorized"}
```

**Result**: ✅ PASS

---

## Test 7: Missing Query

**Endpoint**: `POST /.netlify/functions/chat`

```bash
curl -X POST https://your-site.netlify.app/.netlify/functions/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{}'
```

**Expected Response** (400):
```json
{"error": "Query is required"}
```

**Result**: ✅ PASS

---

## Database Verification

```sql
-- Check interactions logged
SELECT COUNT(*) FROM interactions;
-- Result: 6 interactions logged

-- Check consultations
SELECT id, contact_email, status, email_sent FROM consultations;
-- Result: 3 consultations, all with email_sent = true
```

---

## Performance Metrics

| Endpoint | Avg Response Time |
|----------|------------------|
| auth-register | ~300ms |
| auth-login | ~200ms |
| chat (with sources) | 3-7 seconds |
| request-consultation | ~500ms |
