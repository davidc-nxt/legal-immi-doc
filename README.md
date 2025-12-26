# Legal Immigration POC - Knowledge Base API

A RAG-based legal Q&A API for Canadian immigration law using:
- **Netlify Functions** - Serverless API endpoints
- **Neon PostgreSQL** - Vector database with pgvector
- **OpenRouter** - LLM (Gemini) and embeddings
- **LlamaCloud** - Document parsing

## Setup

### 1. Database Setup

Run the SQL in `schema.sql` in your Neon SQL Editor to create:
- `documents` table with vector embeddings
- `users` table for JWT authentication

### 2. Environment Variables

Copy `.env.example` to `.env` and fill in:
- `DATABASE_URL` - Neon connection string
- `LLAMA_CLOUD_API_KEY` - LlamaCloud API key
- `OPENROUTER_API_KEY` - OpenRouter API key
- `JWT_SECRET` - Secret for JWT signing

### 3. Install Dependencies

```bash
# Node.js (for Netlify Functions)
npm install

# Python (for ingestion script)
pip install -r requirements.txt
```

### 4. Ingest Documents

```bash
python ingest.py
```

### 5. Local Development

```bash
npm run dev
# API available at http://localhost:8888
```

## API Endpoints

### Authentication

#### POST /api/auth/register
```json
{
  "email": "user@example.com",
  "password": "password123",
  "name": "John Doe"
}
```

#### POST /api/auth/login
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

### Chat (Protected)

#### POST /api/chat
Headers: `Authorization: Bearer <token>`
```json
{
  "query": "What is a C11 work permit?"
}
```

Response:
```json
{
  "answer": "A C11 work permit is...",
  "sources": [
    {"filename": "...", "section": "...", "similarity": "0.85"}
  ],
  "query": "..."
}
```

## Deployment

Push to GitHub and connect to Netlify. Set environment variables in Netlify UI.
