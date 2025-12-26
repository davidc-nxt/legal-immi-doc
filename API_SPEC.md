# Legal Knowledge Base API Specification

**Base URL**: `https://legal-immi-doc.netlify.app`

---

## Authentication

All API requests (except auth endpoints) require JWT authentication.

### Headers
```
Authorization: Bearer <token>
Content-Type: application/json
```

---

## Endpoints

### 1. Register User

**POST** `/.netlify/functions/auth-register`

Creates a new user account and returns a JWT token.

#### Request Body
```json
{
  "email": "user@example.com",
  "password": "password123",
  "name": "John Doe"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| email | string | Yes | User email (unique) |
| password | string | Yes | Min 6 characters |
| name | string | No | Display name |

#### Success Response (201)
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "name": "John Doe",
    "createdAt": "2025-12-26T03:20:34.491Z"
  }
}
```

#### Error Responses
| Status | Error | Description |
|--------|-------|-------------|
| 400 | Email and password are required | Missing fields |
| 400 | Password must be at least 6 characters | Password too short |
| 409 | Email already registered | Duplicate email |

---

### 2. Login

**POST** `/.netlify/functions/auth-login`

Authenticates user and returns a JWT token.

#### Request Body
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

#### Success Response (200)
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "name": "John Doe",
    "createdAt": "2025-12-26T03:20:34.491Z"
  }
}
```

#### Error Responses
| Status | Error | Description |
|--------|-------|-------------|
| 400 | Email and password are required | Missing fields |
| 401 | Invalid credentials | Wrong email/password |

---

### 3. Chat (Legal Q&A)

**POST** `/.netlify/functions/chat`

Queries the legal knowledge base using RAG (Retrieval Augmented Generation). Supports **conversation sessions** with sliding window memory (last 6 messages).

**🔒 Requires Authentication**

#### Request Body
```json
{
  "query": "What are the requirements for a C11 work permit?",
  "conversationId": "optional-uuid-from-previous-response"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| query | string | Yes | Legal question |
| conversationId | UUID | No | Pass from previous response to continue conversation |

> **Note**: For follow-up questions like "What does that mean?", pass the `conversationId` from the previous response. The system will automatically rewrite vague questions using conversation context.

#### Success Response (200)
```json
{
  "success": true,
  "data": {
    "summary": "Concise 2-3 sentence summary of the answer",
    "keyPoints": [
      "LMIA-exempt offer of employment required",
      "Proof of employer compliance fee payment",
      "Evidence of 'significant benefit' to Canada"
    ],
    "legalReferences": [
      "R205(a)",
      "IRPR Section 200",
      "C11 Administrative Code"
    ],
    "details": "Full detailed answer with [Source 1], [Source 2] citations...",
    "recommendation": "Practical next steps or advice for the user",
    "confidence": "high"
  },
  "sources": [
    {
      "id": 1,
      "filename": "Business owners seeking only temporary residence.pdf",
      "section": "Processing Legal Frame",
      "similarity": "0.598",
      "type": "policy_document"
    },
    {
      "id": 2,
      "filename": "2024 FC 1445 _ Fahimi v. Canada.pdf",
      "section": "Case Laws",
      "similarity": "0.560",
      "type": "case_law"
    }
  ],
  "metadata": {
    "query": "What are the requirements for a C11 work permit?",
    "model": "google/gemini-3-flash-preview",
    "responseTimeMs": 6167,
    "documentsFound": 8
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| success | boolean | Request success status |
| data.summary | string | Brief 2-3 sentence answer |
| data.keyPoints | string[] | Bullet points of key information |
| data.legalReferences | string[] | Relevant legal codes/sections |
| data.details | string | Full answer with source citations |
| data.recommendation | string | Practical next steps |
| data.confidence | string | "high", "medium", or "low" |
| sources | array | Matched documents from knowledge base |
| sources[].id | number | Source reference number |
| sources[].filename | string | Document filename |
| sources[].section | string | Category: "Case Laws", "ATIP Notes", "Processing Legal Frame" |
| sources[].similarity | string | Similarity score (0-1) |
| sources[].type | string | "case_law", "atip_note", or "policy_document" |
| **consultationAvailable** | boolean | True if professional consultation is recommended |
| **consultationPrompt** | string/null | Message to show user about consultation option |
| metadata.query | string | Original query |
| metadata.model | string | LLM model used |
| metadata.responseTimeMs | number | Response time in milliseconds |
| metadata.documentsFound | number | Number of relevant documents |

#### Error Responses
| Status | Error | Description |
|--------|-------|-------------|
| 400 | Query is required | Missing query |
| 401 | Unauthorized | Missing/invalid token |
| 500 | Failed to generate response | LLM error |

---

### 4. Chat History

**GET** `/.netlify/functions/chat-history`

Retrieves the user's past chat interactions with pagination.

**🔒 Requires Authentication**

#### Query Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | number | 50 | Max items to return (max 100) |
| offset | number | 0 | Items to skip for pagination |

#### Example Request
```bash
curl -X GET "https://legal-immi-doc.netlify.app/.netlify/functions/chat-history?limit=10&offset=0" \
  -H "Authorization: Bearer <token>"
```

#### Success Response (200)
```json
{
  "success": true,
  "data": [
    {
      "id": 5,
      "query": "What is R205(a)?",
      "answer": {
        "summary": "R205(a) is the regulatory authority...",
        "keyPoints": ["..."],
        "confidence": "high"
      },
      "sources": [...],
      "model": "google/gemini-3-flash-preview",
      "responseTimeMs": 6842,
      "createdAt": "2025-12-26T03:57:08.123Z"
    }
  ],
  "pagination": {
    "total": 25,
    "limit": 10,
    "offset": 0,
    "hasMore": true
  }
}
```

#### Error Responses
| Status | Error | Description |
|--------|-------|-------------|
| 401 | Unauthorized | Missing/invalid token |
| 500 | Failed to retrieve chat history | Server error |

---

### 5. Request Consultation

**POST** `/.netlify/functions/request-consultation`

Submits a consultation request to connect with a professional immigration lawyer. Sends case summary via email.

**🔒 Requires Authentication**

#### Request Body
```json
{
  "contactEmail": "user@example.com",
  "contactPhone": "+1-555-123-4567",
  "feeAcknowledged": true,
  "originalQuery": "What are the requirements for C11 work permit?",
  "chatHistory": [
    {
      "role": "user",
      "content": "What are the requirements for C11 work permit?"
    },
    {
      "role": "assistant",
      "data": {
        "summary": "A C11 work permit requires...",
        "keyPoints": ["Point 1", "Point 2"],
        "confidence": "medium"
      }
    }
  ],
  "additionalNotes": "I have specific questions about my business plan."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| contactEmail | string | Yes | Email for lawyer to contact |
| contactPhone | string | Yes | Phone for lawyer to contact |
| **feeAcknowledged** | boolean | **Yes** | Must be `true` to confirm user acknowledges fees may apply |
| originalQuery | string | No | The initial question asked |
| chatHistory | array | Yes | Array of chat messages |
| additionalNotes | string | No | Extra context from user |

#### Success Response (200)
```json
{
  "success": true,
  "message": "Your consultation request has been submitted. Our legal team will contact you within 1-2 business days.",
  "consultationId": 1,
  "feeNotice": "Please note that professional legal consultation may incur fees. Our team will discuss pricing before any chargeable work begins."
}
```

#### Fee Acknowledgment Required Response (400)
If `feeAcknowledged` is not `true`:
```json
{
  "error": "Fee acknowledgment required",
  "requiresAcknowledgment": true,
  "feeDisclosure": "Professional legal consultation may incur fees...",
  "action": "Please set feeAcknowledged to true to confirm you understand fees may apply."
}
```

#### Error Responses
| Status | Error | Description |
|--------|-------|-------------|
| 400 | Fee acknowledgment required | User must acknowledge fees |
| 400 | Contact email and phone are required | Missing contact info |
| 400 | Chat history is required | Missing chat history |
| 401 | Unauthorized | Missing/invalid token |
| 500 | Failed to submit consultation request | Server error |

---

## Code Examples

### JavaScript/React Native

```javascript
const API_BASE = 'https://legal-immi-doc.netlify.app/.netlify/functions';

// Store token after login
let authToken = null;

// Register
async function register(email, password, name) {
  const response = await fetch(`${API_BASE}/auth-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name })
  });
  const data = await response.json();
  if (response.ok) {
    authToken = data.token;
    return data;
  }
  throw new Error(data.error);
}

// Login
async function login(email, password) {
  const response = await fetch(`${API_BASE}/auth-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await response.json();
  if (response.ok) {
    authToken = data.token;
    return data;
  }
  throw new Error(data.error);
}

// Chat Query
async function askQuestion(query) {
  const response = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`
    },
    body: JSON.stringify({ query })
  });
  const data = await response.json();
  if (response.ok && data.success) {
    return data;
  }
  throw new Error(data.error || 'Request failed');
}

// Usage Example
async function main() {
  try {
    // Login first
    await login('demo@test.com', 'demo123');
    
    // Ask a legal question
    const result = await askQuestion('What is a C11 work permit?');
    
    console.log('Summary:', result.data.summary);
    console.log('Key Points:', result.data.keyPoints);
    console.log('Sources:', result.sources.length, 'documents');
    console.log('Response Time:', result.metadata.responseTimeMs, 'ms');
  } catch (error) {
    console.error('Error:', error.message);
  }
}
```

### Swift (iOS)

```swift
import Foundation

struct AuthResponse: Codable {
    let token: String
    let user: User
}

struct User: Codable {
    let id: Int
    let email: String
    let name: String?
    let createdAt: String
}

struct ChatResponse: Codable {
    let success: Bool
    let data: ChatData
    let sources: [Source]
    let metadata: Metadata
}

struct ChatData: Codable {
    let summary: String
    let keyPoints: [String]
    let legalReferences: [String]
    let details: String
    let recommendation: String
    let confidence: String
}

struct Source: Codable {
    let id: Int
    let filename: String
    let section: String
    let similarity: String
    let type: String
}

struct Metadata: Codable {
    let query: String
    let model: String
    let responseTimeMs: Int
    let documentsFound: Int
}

class LegalAPI {
    static let baseURL = "https://legal-immi-doc.netlify.app/.netlify/functions"
    var token: String?
    
    func login(email: String, password: String) async throws -> AuthResponse {
        let url = URL(string: "\(Self.baseURL)/auth-login")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["email": email, "password": password])
        
        let (data, _) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(AuthResponse.self, from: data)
        self.token = response.token
        return response
    }
    
    func askQuestion(query: String) async throws -> ChatResponse {
        guard let token = token else { throw NSError(domain: "", code: 401) }
        
        let url = URL(string: "\(Self.baseURL)/chat")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(["query": query])
        
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(ChatResponse.self, from: data)
    }
}
```

### Kotlin (Android)

```kotlin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.HttpURLConnection
import java.net.URL

@Serializable
data class AuthResponse(val token: String, val user: User)

@Serializable
data class User(val id: Int, val email: String, val name: String?, val createdAt: String)

@Serializable
data class ChatResponse(
    val success: Boolean,
    val data: ChatData,
    val sources: List<Source>,
    val metadata: Metadata
)

@Serializable
data class ChatData(
    val summary: String,
    val keyPoints: List<String>,
    val legalReferences: List<String>,
    val details: String,
    val recommendation: String,
    val confidence: String
)

@Serializable
data class Source(
    val id: Int,
    val filename: String,
    val section: String,
    val similarity: String,
    val type: String
)

@Serializable
data class Metadata(
    val query: String,
    val model: String,
    val responseTimeMs: Int,
    val documentsFound: Int
)

class LegalAPI {
    private val baseUrl = "https://legal-immi-doc.netlify.app/.netlify/functions"
    var token: String? = null
    
    suspend fun login(email: String, password: String): AuthResponse = withContext(Dispatchers.IO) {
        val json = """{"email":"$email","password":"$password"}"""
        val response = post("$baseUrl/auth-login", json)
        Json.decodeFromString<AuthResponse>(response).also { token = it.token }
    }
    
    suspend fun askQuestion(query: String): ChatResponse = withContext(Dispatchers.IO) {
        val json = """{"query":"$query"}"""
        val response = post("$baseUrl/chat", json, token)
        Json.decodeFromString<ChatResponse>(response)
    }
    
    private fun post(url: String, body: String, authToken: String? = null): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.setRequestProperty("Content-Type", "application/json")
        authToken?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
        connection.doOutput = true
        connection.outputStream.write(body.toByteArray())
        return connection.inputStream.bufferedReader().readText()
    }
}
```

---

## Rate Limits

Currently no rate limits applied. For production use, consider implementing rate limiting on the client side.

## Token Expiry

JWT tokens are valid for **7 days**. After expiry, users must login again to get a new token.
