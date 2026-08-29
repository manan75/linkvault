# LinkVault

## Product

LinkVault is an intelligent bookmark manager designed to solve one core problem:

"I know I saved that link somewhere, but I don't remember where."

Users paste URLs into LinkVault. The system extracts useful metadata, generates a short summary and tags, creates an embedding, and stores the bookmark.

Users can later search their saved links using natural language and semantic search.

The core product is NOT a generic RAG chatbot. The primary experience is:

Save → Forget → Describe → Find

RAG may be added later as an optional feature called "Ask my LinkVault".

---

## Core User Flow

1. User authenticates.
2. User pastes a URL.
3. API validates and stores the bookmark.
4. API immediately responds without waiting for expensive processing.
5. A `link.created` event is published to Kafka.
6. Background workers process the URL asynchronously.
7. Metadata is extracted.
8. A short summary and useful tags are generated.
9. An embedding is generated using Sentence Transformers.
10. The embedding and enriched metadata are stored.
11. User can perform keyword, semantic, or hybrid searches.
12. Search results return the most relevant saved bookmarks.

---

## MVP Features

### Authentication
- Register
- Login
- Logout
- Protected routes

### Bookmarks
- Save URL
- Delete URL
- Update bookmark
- Favorite bookmark
- Mark as read/unread
- View bookmark details

### Organization
- Tags
- Collections
- Favorites
- Read/unread

### Search
- Keyword search
- Semantic search
- Hybrid search
- Filters by tag, collection, date, domain, read status, favorite status

### URL Processing
- Extract title
- Extract description
- Extract author when available
- Extract domain
- Extract favicon
- Extract thumbnail/Open Graph image when available
- Generate short summary
- Generate useful tags
- Generate embedding

---

## Future Features

These should NOT be implemented until the core product is working.

- Ask my LinkVault (RAG)
- Dead-link detection
- Advanced recommendations
- Trending resources
- Browser extension
- Mobile application
- Public collections
- Sharing

---

# Architecture

## High-Level Architecture

React frontend
        |
        v
Node.js + Express API
        |
        +-------------------+
        |                   |
        v                   v
    MongoDB              Redis
        |
        v
      Kafka
        |
        +-----------------------+
        |           |           |
        v           v           v
    Metadata    Enrichment   Embedding
     Worker       Worker       Worker
                              |
                              v
                     Sentence Transformer
                              |
                              v
                    MongoDB Vector Search

---

## Technology Stack

### Frontend
- React
- Vite
- Tailwind CSS
- React Router

### Backend
- Node.js
- Express
- MongoDB
- Mongoose
- JWT authentication

### Infrastructure
- Redis
- Apache Kafka
- Docker
- Docker Compose for local development

### ML / Search
- Python
- FastAPI where appropriate
- Sentence Transformers
- MongoDB Atlas Vector Search

### Deployment
Choose deployment providers based on cost, simplicity, and reliability.
Do not introduce Kubernetes unless there is a real requirement.

---

# Architecture Principles

## 1. Start simple

Do not introduce infrastructure before it has a purpose.

The initial MVP can begin as:

React → Express → MongoDB

Then progressively introduce:

Kafka → workers → embeddings → Redis → hybrid search

Do not prematurely implement every component.

## 2. API must remain responsive

Saving a URL must not wait for metadata extraction, summarization, or embedding generation.

The API should create the bookmark and return quickly.

Expensive processing happens asynchronously.

## 3. Event-driven processing

Kafka is used for asynchronous processing and decoupling.

Important events may include:

- link.created
- metadata.extracted
- link.enriched
- embedding.created
- link.processing.failed

Workers should be independently scalable.

## 4. Idempotency

Workers must safely process the same event more than once.

Duplicate Kafka delivery must not create duplicate bookmarks or corrupt state.

## 5. Retries and failure handling

External webpage fetching can fail.

Workers must handle:

- timeouts
- HTTP errors
- invalid URLs
- inaccessible pages
- malformed metadata
- temporary failures

Do not crash the entire consumer because one URL failed.

## 6. Redis

Redis should be used only where it provides real value.

Potential uses:

- search result caching
- API rate limiting
- URL processing deduplication
- temporary coordination/state
- frequently accessed data

Do not use Redis merely for the sake of having Redis.

## 7. Security

- Never store plaintext passwords.
- Validate all user input.
- Protect authenticated endpoints.
- Users must only access their own bookmarks.
- Rate-limit expensive endpoints.
- Never trust fetched webpage content.
- Never execute arbitrary JavaScript from fetched pages.
- Keep secrets in environment variables.
- Never commit `.env` files.

## 8. Privacy

Bookmarks are private by default.

A user's bookmarks, searches, tags, summaries, and embeddings must never be exposed to another user unless an explicit sharing feature is implemented.

---

# Database Models

Initial collections:

## User

- _id
- name
- email
- passwordHash
- createdAt
- updatedAt

## Link

- _id
- userId
- url
- canonicalUrl
- title
- description
- summary
- domain
- favicon
- thumbnail
- tags[]
- embedding
- collectionId
- isFavorite
- isRead
- processingStatus
- savedAt
- updatedAt

## Collection

- _id
- userId
- name
- createdAt
- updatedAt

The embedding may initially live in the Link document.

If vector storage requirements make this undesirable later, introduce a separate LinkEmbedding or LinkChunk model.

Do not over-engineer the schema prematurely.

---

# Semantic Search

The embedding should represent useful bookmark information rather than the entire webpage.

Embedding input should primarily contain:

- title
- description
- generated summary
- tags
- other useful metadata when appropriate

The goal is to retrieve bookmarks based on what the user remembers.

Example:

User query:

"that article about making APIs faster using caching"

should retrieve:

"Redis Caching Strategies"

even if the exact query words are not present in the title.

---

# Search Strategy

Eventually support:

1. Keyword search
2. Semantic/vector search
3. Hybrid search

Hybrid search should combine semantic relevance with keyword relevance and metadata filters.

Do not assume semantic search is always superior.

---

# RAG

RAG is NOT part of the initial MVP.

Later, "Ask my LinkVault" may:

1. Embed the user's question.
2. Retrieve relevant bookmark metadata/content.
3. Pass retrieved context to an LLM.
4. Generate an answer.
5. Cite the relevant saved bookmarks.

Do not build this until semantic search itself is working well.

---

# Development Philosophy

- Build incrementally.
- Keep commits small and meaningful.
- Prefer simple solutions.
- Do not add dependencies without a reason.
- Do not introduce microservices unnecessarily.
- Do not introduce Kubernetes unnecessarily.
- Write production-quality code even during MVP development.
- Handle errors explicitly.
- Add validation at API boundaries.
- Keep business logic separate from route handlers.
- Use clear naming.
- Avoid duplicated logic.
- Add tests for important backend behavior.

---

# Git

Use meaningful commits.

Examples:

feat: add user authentication
feat: add bookmark CRUD
feat: add URL metadata extraction
feat: add Kafka link processing
feat: add semantic search
feat: add Redis search caching

Do not make giant commits containing unrelated changes.

---

# Current Development Priority

Build in this order:

Phase 1:
- Project setup
- React frontend
- Express backend
- MongoDB connection
- Authentication

Phase 2:
- Link CRUD
- Collections
- Tags
- Favorites
- Read/unread
- Dashboard

Phase 3:
- URL metadata extraction
- Processing status
- Error handling

Phase 4:
- Kafka
- Background workers
- Event-driven processing

Phase 5:
- Summary generation
- Tag generation

Phase 6:
- Sentence Transformer embeddings
- MongoDB Vector Search
- Semantic search

Phase 7:
- Redis caching
- Rate limiting
- Processing deduplication

Phase 8:
- Hybrid search
- Search filters
- Production hardening

Phase 9:
- Deployment
- Monitoring
- Analytics
- Real users

Phase 10:
- Optional RAG / Ask my LinkVault

---

# Important Rule

Before implementing a major architectural change, explain:

1. What problem it solves.
2. Why the current architecture is insufficient.
3. What alternatives were considered.
4. Why the chosen solution is appropriate.

Do not blindly add technology because it appears in the architecture diagram.