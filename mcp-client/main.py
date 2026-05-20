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
from pydantic import BaseModel

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
MCP_SERVER_URL = os.getenv("MCP_SERVER_URL", "http://localhost:8081/mcp/message")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8001"))

# ── MCP Client ──────────────────────────────────────────────────────────────────

class MCPClient:
    """Manages a long-lived MCP SSE connection to the Spring AI MCP Server."""

    def __init__(self):
        self.session: Optional[ClientSession] = None
        self._transport_ctx = None
        self._session_ctx = None
        self.tools_meta = []

    @classmethod
    async def create(cls, url: str):
        """Factory method: creates and initializes the MCP client."""
        client = cls()
        client._transport_ctx = sse_client(url)
        transport = await client._transport_ctx.__aenter__()
        client._session_ctx = ClientSession(transport[0], transport[1])
        client.session = await client._session_ctx.__aenter__()
        await client.session.initialize()
        # Fetch available tools
        tools_result = await client.session.list_tools()
        client.tools_meta = tools_result.tools
        logger.info(f"MCP Client connected to {url}")
        logger.info(f"Available tools: {[t.name for t in client.tools_meta]}")
        return client

    async def close(self):
        if self._session_ctx:
            await self._session_ctx.__aexit__(None, None, None)
        if self._transport_ctx:
            await self._transport_ctx.__aexit__(None, None, None)
        logger.info("MCP Client disconnected")

    async def call_tool(self, name: str, arguments: dict) -> str:
        """Call an MCP tool and return the text result."""
        if not self.session:
            raise RuntimeError("MCP session not initialized")
        result = await self.session.call_tool(name, arguments)
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

    # ── Define LangChain tools wrapping MCP tools ───────────────────────────

    async def _query_concept_graph(keyword: str = "", projectId: str = "project_public") -> str:
        """查询本体概念图谱（Concept Graph），根据关键词搜索对象类型（Object Type）、属性（Property）和链接类型（Link Type）的定义信息。
        关键词为空时返回所有概念。返回的数据包括对象类型列表、属性详情和链接关系定义。"""
        return await client.call_tool("query_concept_graph", {
            "keyword": keyword,
            "projectId": projectId,
        })

    async def _query_instance_graph(
        objectTypeName: str = "",
        keyword: str = "",
        projectId: str = "project_public",
        maxDepth: int = 2,
    ) -> str:
        """查询实例图谱（Instance Graph），搜索某个对象类型下的实例数据及其关联关系。
        支持关键词搜索实例内容，并支持指定遍历深度（maxDepth）来探索关联的上下游实例。
        返回包含实例节点（nodes）和关系边（edges）的图谱数据。"""
        return await client.call_tool("query_instance_graph", {
            "objectTypeName": objectTypeName,
            "keyword": keyword,
            "projectId": projectId,
            "maxDepth": maxDepth,
        })

    tools = [
        StructuredTool.from_function(
            coroutine=_query_concept_graph,
            name="query_concept_graph",
            description="查询本体概念图谱（Concept Graph），根据关键词搜索对象类型、属性和链接类型的定义信息。关键词为空时返回所有概念。",
        ),
        StructuredTool.from_function(
            coroutine=_query_instance_graph,
            name="query_instance_graph",
            description="查询实例图谱（Instance Graph），搜索某个对象类型下的实例数据及其关联关系。支持关键词搜索和遍历深度控制。",
        ),
    ]

    # ── System prompt ───────────────────────────────────────────────────────

    system_prompt = """你是一个本体图谱专家助手。
你有两个强大的工具可以帮助用户查询和探索本体图谱数据：

1. query_concept_graph - 查询本体概念图谱（元数据）
   - 用于搜索对象类型（如：公司、产品、订单等业务实体）
   - 搜索属性定义（如：名称、价格、状态等字段）
   - 搜索链接类型（实体之间的关联关系定义）
   - 可以传入关键词进行模糊搜索

2. query_instance_graph - 查询实例图谱（实际数据）
   - 用于搜索某个对象类型下的具体实例数据
   - 可以搜索实例之间的关联关系网络
   - 支持控制遍历深度来探索更多关联数据

请根据用户的问题，选择合适的工具来回答。
- 如果用户问的是关于"有什么对象类型"、"有什么属性"、"实体之间有什么关系"等结构性问题，使用 query_concept_graph
- 如果用户问的是关于"具体数据"、"某家公司"、"某个产品的实例"、"数据之间的关系"等数据性问题，使用 query_instance_graph
- 用户可以先用 query_concept_graph 了解数据结构，再用 query_instance_graph 查询具体数据

请用中文回答，并尽量详细地展示查询到的数据。对于 JSON 格式的返回结果，请整理成易于阅读的格式展示给用户。"""

    agent = create_agent(
        model=llm,
        tools=tools,
        system_prompt=system_prompt,
        debug=True,
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
        logger.error(f"Agent error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=True)
