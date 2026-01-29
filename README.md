# Legal Immigration Knowledge Base API

An AI-powered legal knowledge system for Canadian immigration law using **RAG (Retrieval-Augmented Generation)** with reasoning capabilities.

## 🏗️ Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed system design.

```
Mobile App → Netlify Functions → Neon pgvector + Grok LLM + Resend Email
```

### Key Components
- **RAG Pipeline**: 54 legal PDFs → 1,989 vector embeddings → semantic search
- **LLM with Reasoning**: Grok 4.1-fast with explicit reasoning chain
- **Conversation Memory**: Sliding window (10 messages) with query rewriting
- **Professional Handoff**: LLM-generated case summaries for lawyers

## 🚀 Quick Start

```bash
# Install dependencies
npm install
pip install -r requirements.txt

# Set up environment
cp .env.example .env
# Edit .env with your API keys

# Ingest documents
python ingest.py

# Run locally
npm run dev
```

## 📚 API Documentation

See [API_SPEC.md](./API_SPEC.md) for complete endpoint documentation.

### Endpoints
| Endpoint | Description |
|----------|-------------|
| `POST /auth-register` | Create account |
| `POST /auth-login` | Get JWT token |
| `POST /chat` | Legal Q&A with RAG |
| `GET /chat-history` | Grouped conversations |
| `GET /conversation` | Load conversation messages |
| `POST /request-consultation` | Professional handoff |

## 🔧 Tech Stack

| Component | Technology |
|-----------|------------|
| **API** | Netlify Functions (Node.js) |
| **Database** | Neon PostgreSQL + pgvector |
| **LLM** | Grok 4.1-fast via OpenRouter |
| **Embeddings** | text-embedding-3-small |
| **Email** | Resend API |
| **Auth** | JWT + bcryptjs |

## 📁 Project Structure

```
├── netlify/functions/     # Serverless API endpoints
│   ├── chat.js           # RAG + LLM reasoning
│   ├── chat-history.js   # Grouped conversations
│   ├── conversation.js   # Load messages
│   └── request-consultation.js
├── ingest.py             # Document ingestion script
├── schema.sql            # Database schema
├── ARCHITECTURE.md       # System design
└── API_SPEC.md          # API documentation
```

## 🚀 Deployment

1. Push to GitHub
2. Connect to Netlify
3. Set environment variables in Netlify UI
4. Deploy!

**Live Demo**: https://legal-immi-doc.netlify.app

## 📄 License

MIT
