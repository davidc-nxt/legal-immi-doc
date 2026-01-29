# AI System Architecture

## Overview

This is a **Retrieval-Augmented Generation (RAG)** legal knowledge system designed to help users navigate Canadian immigration law, specifically C11 work permits and IRCC applications.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Mobile/Web Client                           │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Netlify Edge Functions                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │   Auth      │  │    Chat     │  │  History    │  │ Consultation│ │
│  │  (JWT)      │  │   (RAG)     │  │  (Grouped)  │  │  (Email)    │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
┌───────────────────┐   ┌───────────────────┐   ┌───────────────────┐
│   Neon PostgreSQL │   │    OpenRouter     │   │    Resend API     │
│   + pgvector      │   │   (LLM Gateway)   │   │   (Email)         │
│                   │   │                   │   │                   │
│ • Users           │   │ • Grok 4.1-fast   │   │ • Consultation    │
│ • Documents       │   │   + Reasoning     │   │   notifications   │
│ • Embeddings      │   │ • text-embed-3    │   │                   │
│ • Conversations   │   │   -small          │   │                   │
│ • Messages        │   │                   │   │                   │
└───────────────────┘   └───────────────────┘   └───────────────────┘
```

## Core Components

### 1. RAG Pipeline
- **Document Ingestion**: 54 legal PDFs → 1,989 segments via LlamaCloud
- **Vector Storage**: Neon pgvector with HNSW indexing (cosine similarity)
- **Semantic Search**: Top 8 documents retrieved per query (threshold: 0.4)

### 2. LLM with Reasoning
- **Model**: `x-ai/grok-4.1-fast` with reasoning enabled
- **Purpose**: Solution-focused legal guidance for IRCC applicants
- **Features**: Explicit reasoning chain, legal disclaimers, actionable steps

### 3. Conversation Management
- **Sliding Window**: Last 10 messages (5 Q&A pairs) sent to LLM
- **Query Rewriting**: Vague follow-ups auto-rewritten for context
- **Session Persistence**: Full history stored, grouped by conversationId

### 4. Professional Handoff
- **Fee Acknowledgment**: Required before consultation request
- **LLM Summary**: Auto-generated case brief for lawyers
- **Email Delivery**: Full conversation history via Resend API

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Grok + Reasoning | Better step-by-step legal guidance vs. Gemini |
| Sliding Window (10) | Balance context quality vs. token cost |
| Grouped Conversations | Mobile-friendly chat history loading |
| Source Citation Stripping | Clean UI while preserving audit trail in DB |
| UTC Timestamps | Client-side timezone conversion |

## Data Flow

1. **Query** → Embed with `text-embedding-3-small`
2. **Search** → pgvector finds relevant legal documents
3. **Context** → Top 8 docs + last 10 messages
4. **Reasoning** → Grok analyzes with explicit reasoning chain
5. **Response** → Structured JSON with sources stripped for UI
6. **Storage** → Full response (with citations) saved to DB

## Security

- JWT authentication for all endpoints
- Passwords hashed with bcryptjs
- Environment variables for all secrets
- Conversation isolation by user_id
