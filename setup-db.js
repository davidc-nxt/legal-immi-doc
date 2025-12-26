/**
 * Database Setup Script
 * Run this to create tables in Neon PostgreSQL
 */

require("dotenv").config();
const { neon } = require("@neondatabase/serverless");

async function setupDatabase() {
    console.log("🔧 Setting up database...\n");

    const sql = neon(process.env.DATABASE_URL);

    try {
        // 1. Enable vector extension
        console.log("1️⃣ Enabling vector extension...");
        await sql`CREATE EXTENSION IF NOT EXISTS vector`;
        console.log("   ✅ Vector extension enabled\n");

        // 2. Create documents table
        console.log("2️⃣ Creating documents table...");
        await sql`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        filename TEXT,
        section TEXT,
        content TEXT,
        embedding vector(1536),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
        console.log("   ✅ Documents table created\n");

        // 3. Create vector index
        console.log("3️⃣ Creating vector search index...");
        try {
            await sql`CREATE INDEX IF NOT EXISTS documents_embedding_idx ON documents USING hnsw (embedding vector_cosine_ops)`;
            console.log("   ✅ Vector index created\n");
        } catch (e) {
            console.log("   ⚠️ Index may already exist or not enough data yet\n");
        }

        // 4. Create users table
        console.log("4️⃣ Creating users table...");
        await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
        console.log("   ✅ Users table created\n");

        // 5. Create email index
        console.log("5️⃣ Creating email index...");
        await sql`CREATE INDEX IF NOT EXISTS users_email_idx ON users (email)`;
        console.log("   ✅ Email index created\n");

        // Verify tables
        console.log("📊 Verifying tables...");
        const tables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    `;
        console.log("   Tables:", tables.map((t) => t.table_name).join(", "));

        console.log("\n🎉 Database setup complete!");
    } catch (error) {
        console.error("❌ Error:", error.message);
        process.exit(1);
    }
}

setupDatabase();
