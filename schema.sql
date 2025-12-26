-- Legal Knowledge Base Database Schema
-- Run this in Neon SQL Editor

-- 1. Enable vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Documents table for legal knowledge base
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  filename TEXT,
  section TEXT,
  content TEXT,
  embedding vector(1536),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 3. Vector search index for fast similarity search
CREATE INDEX IF NOT EXISTS documents_embedding_idx ON documents USING hnsw (embedding vector_cosine_ops);

-- 4. Users table for JWT authentication
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 5. Index for faster email lookups
CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);

-- 6. Interactions table for tracking user-LLM conversations
CREATE TABLE IF NOT EXISTS interactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  query TEXT NOT NULL,
  answer TEXT,
  sources JSONB,
  model TEXT,
  response_time_ms INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 7. Indexes for analytics queries
CREATE INDEX IF NOT EXISTS interactions_user_idx ON interactions (user_id);
CREATE INDEX IF NOT EXISTS interactions_created_idx ON interactions (created_at);

-- 8. Consultations table for professional consultation requests
CREATE TABLE IF NOT EXISTS consultations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  contact_email TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  original_query TEXT,
  chat_history JSONB,
  additional_notes TEXT,
  status TEXT DEFAULT 'pending',
  email_sent BOOLEAN DEFAULT false,
  email_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 9. Indexes for consultations
CREATE INDEX IF NOT EXISTS consultations_user_idx ON consultations (user_id);
CREATE INDEX IF NOT EXISTS consultations_status_idx ON consultations (status);
