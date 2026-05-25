"""Ontology MCP Client - LangChain Agent Service

Connects to Spring AI MCP Server for ontology graph queries
and exposes a chat API via FastAPI.
"""

import os
import json
import uuid
import logging
from contextlib import asynccontextmanager
from typing import Optional

import dotenv
dotenv.load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, create_model, Field

from mcp import ClientSession
from mcp.client.sse import sse_client

from langchain_openai import ChatOpenAI
from langchain.agents import create_agent
from langchain_core.tools import StructuredTool
from langchain_core.messages import HumanMessage, AIMessage

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("mcp-client")

# ── Configuration ───────────────────────────────────────────────────────────────

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
MCP_SERVER_URL = os.getenv("MCP_SERVER_URL", "http://localhost:8081/sse")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8001"))

# ── MCP Client ──────────────────────────────────────────────────────────────────

class MCPClient:
    """Manages an MCP SSE connection to the Spring AI MCP Server with auto-reconnect."""

    def __init__(self, url: str):
        self.url = url
        self.session: Optional[ClientSession] = None
        self._transport_ctx = None
        self._session_ctx = None
        self.tools_meta = []

    async def connect(self):
        """Connect (or reconnect) to the MCP server."""
        # Try to create a new connection; don't touch self.session until success
        transport_ctx = sse_client(self.url)
        transport = await transport_ctx.__aenter__()
        session_ctx = ClientSession(transport[0], transport[1])
        session = await session_ctx.__aenter__()
        await session.initialize()
        tools_result = await session.list_tools()
        # Only update instance state on success
        # Discard old session references (don't await __aexit__ — it fails in a different task context)
        self._transport_ctx = transport_ctx
        self._session_ctx = session_ctx
        self.session = session
        self.tools_meta = tools_result.tools
        logger.info(f"MCP Client connected to {self.url}")
        logger.info(f"Available tools: {[t.name for t in self.tools_meta]}")

    @classmethod
    async def create(cls, url: str):
        """Factory method: creates and initializes the MCP client."""
        client = cls(url)
        await client.connect()
        return client

    async def close(self):
        if self._session_ctx:
            await self._session_ctx.__aexit__(None, None, None)
        if self._transport_ctx:
            await self._transport_ctx.__aexit__(None, None, None)
        logger.info("MCP Client disconnected")

    async def call_tool(self, name: str, arguments: dict) -> str:
        """Call an MCP tool and return the text result. Auto-reconnects on connection error."""
        if not self.session:
            self.session = None  # ensure clean state
            logger.info("No active MCP session, attempting connection...")
            await self.connect()
            if not self.session:
                raise RuntimeError("MCP session not initialized")

        try:
            result = await self.session.call_tool(name, arguments)
        except Exception as e:
            if "ClosedResourceError" in type(e).__name__ or "closed" in str(e).lower():
                logger.warning(f"MCP connection lost, reconnecting... ({e})")
                try:
                    await self.connect()
                    result = await self.session.call_tool(name, arguments)
                except Exception as re:
                    logger.error(f"Reconnection failed: {re}")
                    raise RuntimeError(
                        f"MCP server is unavailable. Please try again later."
                    ) from re
            else:
                raise

        if result.content and len(result.content) > 0:
            # Extract text from TextContent objects
            texts = []
            for c in result.content:
                if hasattr(c, "text"):
                    texts.append(c.text)
                elif isinstance(c, dict):
                    texts.append(json.dumps(c, ensure_ascii=False))
                else:
                    texts.append(str(c))
            return "\n".join(texts)
        return ""

# ── Global state ────────────────────────────────────────────────────────────────

mcp_client: Optional[MCPClient] = None
agent_executor = None
sessions: dict = {}

# ── Chat Models ─────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None

class ChatResponse(BaseModel):
    session_id: str
    response: str

# ── Agent Setup ─────────────────────────────────────────────────────────────────

def build_agent(client: MCPClient):
    """Create a LangChain agent with MCP tools."""

    if not DEEPSEEK_API_KEY:
        raise ValueError("DEEPSEEK_API_KEY is not configured")

    llm = ChatOpenAI(
        model="deepseek-chat",
        api_key=DEEPSEEK_API_KEY,
        base_url="https://api.deepseek.com",
        temperature=0.3,
        streaming=False,
    )

    # ── Dynamically create tools from MCP server metadata ───────────────

    type_map = {"string": str, "integer": int, "number": float, "boolean": bool}

    tools = []
    for meta in client.tools_meta:
        field_defs = {}
        input_schema = meta.inputSchema or {}
        for prop_name, prop_schema in input_schema.get("properties", {}).items():
            py_type = type_map.get(prop_schema.get("type", "string"), str)
            if "default" in prop_schema:
                field_defs[prop_name] = (py_type, Field(default=prop_schema["default"]))
            else:
                field_defs[prop_name] = (Optional[py_type], Field(default=None))

        DynamicModel = create_model(f"{meta.name}_input", **field_defs)

        async def _dynamic_call(tool_name=meta.name, **kwargs) -> str:
            # Filter out None values so the server uses its defaults
            filtered = {k: v for k, v in kwargs.items() if v is not None}
            return await client.call_tool(tool_name, filtered)

        tool = StructuredTool(
            name=meta.name,
            description=meta.description or "",
            args_schema=DynamicModel,
            coroutine=_dynamic_call,
        )
        tools.append(tool)

    # ── System prompt ───────────────────────────────────────────────────────

    tool_descriptions = "\n".join(
        f"{i+1}. {t.name} - {t.description}"
        for i, t in enumerate(client.tools_meta)
    )

    system_prompt = f"""你是一个本体图谱专家助手。
你有以下工具可以帮助用户查询和探索本体图谱数据：

{tool_descriptions}

请根据用户的问题，选择合适的工具来回答。
请用中文回答，并尽量详细地展示查询到的数据。对于 JSON 格式的返回结果，请整理成易于阅读的格式展示给用户。"""

    agent = create_agent(
        model=llm,
        tools=tools,
        system_prompt=system_prompt,
        debug=False,
    )
    return agent

# ── FastAPI App ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global mcp_client, agent_executor
    try:
        mcp_client = await MCPClient.create(MCP_SERVER_URL)
        agent_executor = build_agent(mcp_client)
        logger.info("MCP Client Agent ready")
    except Exception as e:
        logger.error(f"Failed to initialize MCP client: {e}")
        logger.warning("Server starting without MCP connection. Configure MCP_SERVER_URL.")
    yield
    if mcp_client:
        await mcp_client.close()

app = FastAPI(title="Ontology MCP Client", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "mcp_connected": mcp_client is not None and mcp_client.session is not None,
        "tools": [t.name for t in mcp_client.tools_meta] if mcp_client else [],
    }

@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    if not agent_executor:
        raise HTTPException(status_code=503, detail="Agent not ready. MCP server may be unavailable.")

    session_id = request.session_id or str(uuid.uuid4())

    # Get or create session history
    if session_id not in sessions:
        sessions[session_id] = {
            "id": session_id,
            "history": [],
        }
    session = sessions[session_id]

    # Build chat history from stored messages
    chat_history = []
    for msg in session["history"]:
        if msg["role"] == "user":
            chat_history.append(HumanMessage(content=msg["content"]))
        else:
            chat_history.append(AIMessage(content=msg["content"]))

    try:
        result = await agent_executor.ainvoke({
            "messages": chat_history + [HumanMessage(content=request.message)],
        })

        response_text = result["messages"][-1].content

        # Store in session history
        session["history"].append({"role": "user", "content": request.message})
        session["history"].append({"role": "assistant", "content": response_text})

        # Trim history to prevent unbounded growth
        if len(session["history"]) > 20:
            session["history"] = session["history"][-20:]

        return ChatResponse(session_id=session_id, response=response_text)

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        logger.error(f"Agent error: {e}\n{tb}")
        raise HTTPException(status_code=500, detail=str(e) or repr(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=True)
