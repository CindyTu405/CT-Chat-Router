# CT-Chat-Router: Multi-Model AI Chat Platform

## 🚀 Overview
CT-Chat-Router is a full-stack, responsive AI chat application designed to aggregate multiple Large Language Models (LLMs) into a single, unified interface. It goes beyond simple sequential chatting by introducing **Tree-based Conversation Branching**, allowing users to edit previous prompts and explore alternative conversation paths without losing their original history.

## ✨ Key Features
* **Multi-Model Routing:** Seamlessly switch between Google Gemini natively and virtually any other LLM (GPT-4o, Claude 3.5, Llama, DeepSeek) via OpenRouter API integration.
* **Tree-Based Branching (Time Travel):** Every message stores a `parent_id`. Users can edit past messages to create new branches. The system dynamically retrieves the active linear path while preserving all alternate realities in the database.
* **Real-Time Streaming:** Implements Server-Sent Events (SSE) for typewriter-like text generation, ensuring a smooth and responsive UX.
* **Chat History Management (CRUD):** Fully functional sidebar to create, read, rename (title), and delete chat sessions.
* **Custom Model Injection:** A flexible UI that allows users to manually input any valid OpenRouter Model ID on the fly.

## 🛠 Tech Stack
* **Frontend:** React, Vite, Tailwind CSS, Lucide React (Icons).
* **Backend:** Python, FastAPI, SQLModel (SQLAlchemy), PostgreSQL/SQLite.
* **Infrastructure:** Docker & Docker Compose (Containerization), Render (Deployment).

## 📁 Project Structure
```text
.
├── backend/
│   ├── main.py              # FastAPI application & API endpoints
│   ├── models.py            # SQLModel database schemas (Message, ChatRequest)
│   ├── database.py          # Database connection & engine setup
│   ├── gemini_llm.py        # Google Gemini SDK integration
│   ├── openrouter_llm.py    # OpenRouter API (OpenAI SDK) integration
│   ├── migrate.py           # Database migration scripts
│   ├── Dockerfile           # Backend container setup
│   └── requirements.txt     # Python dependencies
├── frontend/
│   ├── src/
│   │   ├── App.jsx          # Main React component & UI logic
│   │   ├── index.css        # Tailwind directives
│   │   └── main.jsx         # React DOM entry
│   ├── package.json         # Node dependencies
│   ├── tailwind.config.js   # Tailwind configuration
│   └── vite.config.js       # Vite configuration
└── docker-compose.yml       # Multi-container orchestration
🧠 Core Architecture & Logic Notes for Developers
1. The Branching Logic (Recursive CTE)
The database does not store chats as simple arrays. It stores them as a Linked List / Tree using a parent_id foreign key.

Writing: When a user replies or branches, the frontend explicitly sends the parent_id of the message they are responding to. To prevent synchronization issues, the backend creates an empty "placeholder" AI message in the DB before starting the stream, returning the X-Message-Id in the headers so the frontend knows the ID immediately.

Reading (/chats/{root_id}/history): The backend uses a Recursive CTE (Common Table Expression) to fetch the history. It first finds the latest leaf node of the given root, then traverses upwards to the root, returning a clean, linear array to the frontend.

Deleting: Deletion relies on Depth-First Deletion (ordering by level DESC) to avoid Foreign Key Constraint violations.

2. The Model Router
The backend acts as a traffic cop (main.py -> chat_endpoint).

If request.model starts with "gemini", it routes the stream to gemini_llm.py.

For all other strings, it forwards the request and conversation history to openrouter_llm.py.

⚙️ Setup & Local Development
Clone the repository:

Bash
git clone <your-repo-url>
cd <your-repo-name>
Environment Variables:
Create a .env file in the root directory:

Ini, TOML
GOOGLE_API_KEY=your_gemini_api_key
OPENROUTER_API_KEY=your_openrouter_api_key
Run with Docker Compose:

Bash
docker-compose up -d --build
Frontend will be available at http://localhost:5173

Backend API will be available at http://localhost:8000

🚀 Deployment (Render)
Backend: Deployed as a Web Service. Ensure DATABASE_URL is set in the Render environment variables (must start with postgresql://). Set PYTHONUNBUFFERED=1 to view real-time logs.

Frontend: Deployed as a Static Site using npm run build. Ensure API_URL in App.jsx points to the deployed backend URL.