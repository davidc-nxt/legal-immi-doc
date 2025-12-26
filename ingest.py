"""
Legal Knowledge Base Ingestion Script

Parses PDFs using LlamaParse, generates embeddings via OpenRouter,
and stores in Neon PostgreSQL with vector support.
"""

import os
import glob
import requests
import psycopg2
from dotenv import load_dotenv
from openai import OpenAI
import time

load_dotenv()

# Configuration
EMBEDDING_MODEL = "openai/text-embedding-3-small"
FILES_DIR = "./C11 WP Knowledge Base"
LLAMA_CLOUD_BASE_URL = "https://api.cloud.llamaindex.ai/api/v1"

# Initialize clients
openrouter_client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.getenv("OPENROUTER_API_KEY"),
)

def get_embedding(text: str) -> list:
    """Generate embedding vector using OpenRouter."""
    text = text.replace("\n", " ")[:8000]  # Truncate if too long
    try:
        response = openrouter_client.embeddings.create(
            input=[text],
            model=EMBEDDING_MODEL
        )
        return response.data[0].embedding
    except Exception as e:
        print(f"   ⚠️ Embedding error: {e}")
        return None

def chunk_text(text: str, chunk_size: int = 1000, overlap: int = 200) -> list:
    """Split text into overlapping chunks."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk)
        start = end - overlap
    return chunks

def parse_pdf_with_llamacloud(file_path: str) -> str:
    """Upload and parse a PDF using LlamaParse API."""
    headers = {
        "Authorization": f"Bearer {os.getenv('LLAMA_CLOUD_API_KEY')}"
    }
    
    # Upload file for parsing
    with open(file_path, "rb") as f:
        files = {"file": (os.path.basename(file_path), f, "application/pdf")}
        response = requests.post(
            f"{LLAMA_CLOUD_BASE_URL}/parsing/upload",
            headers=headers,
            files=files,
            data={"result_type": "markdown"}
        )
    
    if response.status_code != 200:
        print(f"   ⚠️ Upload failed: {response.status_code}")
        print(f"   {response.text[:200]}")
        return None
    
    job_data = response.json()
    job_id = job_data.get("id")
    
    if not job_id:
        print(f"   ⚠️ No job ID returned")
        return None
    
    print(f"   📤 Parsing job: {job_id}")
    
    # Wait for parsing to complete
    max_attempts = 60
    for attempt in range(max_attempts):
        status_response = requests.get(
            f"{LLAMA_CLOUD_BASE_URL}/parsing/job/{job_id}",
            headers=headers
        )
        
        if status_response.status_code == 200:
            status_data = status_response.json()
            status = status_data.get("status")
            
            if status == "SUCCESS":
                # Get the parsed result
                result_response = requests.get(
                    f"{LLAMA_CLOUD_BASE_URL}/parsing/job/{job_id}/result/markdown",
                    headers=headers
                )
                if result_response.status_code == 200:
                    result_data = result_response.json()
                    return result_data.get("markdown", "")
                else:
                    print(f"   ⚠️ Failed to get result: {result_response.status_code}")
                    return None
            elif status in ["ERROR", "FAILED"]:
                print(f"   ⚠️ Parsing failed: {status}")
                return None
            else:
                # Still processing
                if attempt % 5 == 0:
                    print(f"   ⏳ Status: {status}...")
                time.sleep(2)
        else:
            print(f"   ⚠️ Status check failed: {status_response.status_code}")
            time.sleep(2)
    
    print(f"   ⚠️ Timeout waiting for parsing")
    return None

def get_all_pdf_files():
    """Get all PDF files from the knowledge base directory."""
    all_files = []
    for root, dirs, files in os.walk(FILES_DIR):
        for file in files:
            if file.lower().endswith(".pdf"):
                all_files.append(os.path.join(root, file))
    return all_files

def process_and_upload():
    """Main ingestion function."""
    print("🚀 Starting Legal Knowledge Base Ingestion\n")
    
    # Connect to Neon
    print("📡 Connecting to Neon database...")
    conn = psycopg2.connect(os.getenv("DATABASE_URL"))
    cursor = conn.cursor()
    
    # Check current document count
    cursor.execute("SELECT COUNT(*) FROM documents")
    initial_count = cursor.fetchone()[0]
    print(f"   Current documents in DB: {initial_count}")
    
    # Get all PDF files
    print(f"\n📁 Scanning {FILES_DIR}...")
    pdf_files = get_all_pdf_files()
    
    if not pdf_files:
        print(f"❌ No PDF files found in {FILES_DIR}")
        cursor.close()
        conn.close()
        return
    
    print(f"   Found {len(pdf_files)} PDF files\n")
    
    total_chunks = 0
    processed_files = 0
    
    for idx, file_path in enumerate(pdf_files, 1):
        filename = os.path.basename(file_path)
        rel_path = os.path.relpath(os.path.dirname(file_path), FILES_DIR)
        category = rel_path if rel_path != "." else "General"
        
        print(f"[{idx}/{len(pdf_files)}] 📄 {filename}")
        print(f"   Category: {category}")
        
        # Check if already ingested
        cursor.execute(
            "SELECT COUNT(*) FROM documents WHERE filename = %s",
            (filename,)
        )
        if cursor.fetchone()[0] > 0:
            print("   ⏭️ Already ingested, skipping...")
            continue
        
        # Parse PDF with LlamaCloud
        markdown_content = parse_pdf_with_llamacloud(file_path)
        
        if not markdown_content:
            print("   ⚠️ No content extracted, skipping...")
            continue
        
        # Chunk the content
        chunks = chunk_text(markdown_content)
        print(f"   ✂️ {len(chunks)} chunks")
        
        # Generate embeddings and store
        for chunk_idx, chunk_text_content in enumerate(chunks):
            # Generate embedding
            embedding = get_embedding(chunk_text_content)
            if embedding is None:
                continue
            
            # Determine section based on content
            section = category
            
            # Insert into database
            cursor.execute(
                """
                INSERT INTO documents (filename, section, content, embedding)
                VALUES (%s, %s, %s, %s)
                """,
                (filename, section, chunk_text_content, embedding)
            )
            total_chunks += 1
        
        conn.commit()
        processed_files += 1
        print(f"   ✅ Saved ({len(chunks)} chunks)")
    
    # Final count
    cursor.execute("SELECT COUNT(*) FROM documents")
    final_count = cursor.fetchone()[0]
    
    cursor.close()
    conn.close()
    
    print(f"\n🎉 Ingestion Complete!")
    print(f"   Files processed: {processed_files}")
    print(f"   Chunks added: {total_chunks}")
    print(f"   Total documents in DB: {final_count}")

if __name__ == "__main__":
    process_and_upload()
