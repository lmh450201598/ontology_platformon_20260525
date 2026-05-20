import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@/src/components/ui/button';
import { Send, Loader2, Bot, User, Sparkles, AlertCircle } from 'lucide-react';
import { cn } from '@/src/lib/utils';

// ── Types ───────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  error?: boolean;
}

interface ChatResponse {
  session_id: string;
  response: string;
}

// ── API Call ────────────────────────────────────────────────────────────────────

async function sendChatMessage(
  message: string,
  sessionId?: string
): Promise<ChatResponse> {
  const response = await fetch('/api/knowledge-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, session_id: sessionId }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(err || '请求失败');
  }
  return response.json();
}

// ── Simple Markdown Renderer ────────────────────────────────────────────────────

function MarkdownRender({ content }: { content: string }) {
  // Bold
  let html = content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="bg-slate-900 text-green-400 p-3 rounded-lg my-2 text-sm overflow-x-auto"><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="bg-slate-100 text-blue-700 px-1.5 py-0.5 rounded text-sm font-mono">$1</code>');
  // Lists
  html = html.replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-slate-700">$1</li>');
  // Line breaks
  html = html.replace(/\n\n/g, '</p><p class="text-slate-700 mb-2">');
  html = html.replace(/\n/g, '<br/>');

  return (
    <div className="text-sm leading-relaxed">
      <p className="text-slate-700 mb-2">{html}</p>
    </div>
  );
}

// ── AiChat Page ─────────────────────────────────────────────────────────────────

export default function AiChat() {
  const [messages, setMessages] = useState<Message[]>([{
    id: 'welcome',
    role: 'assistant',
    content: '你好！我是本体图谱智能助手。我可以帮助你查询本体概念图谱和实例图谱数据。\n\n**你可以这样问我：**\n- "有哪些对象类型？"\n- "查询名为xxx的对象类型的属性"\n- "有哪些链接关系？"\n- "查询xxx对象的实例数据"\n- "搜索xxx相关的所有实例关系"',
    timestamp: new Date(),
  }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const result = await sendChatMessage(text, sessionId);
      // Update session ID for subsequent messages
      if (!sessionId) {
        setSessionId(result.session_id);
      }
      const assistantMsg: Message = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: result.response,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err: any) {
      const errorMsg: Message = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: `抱歉，请求出错了：${err.message || '请稍后重试'}`,
        timestamp: new Date(),
        error: true,
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewChat = () => {
    setMessages([{
      id: 'welcome',
      role: 'assistant',
      content: '你好！我是本体图谱智能助手。我可以帮助你查询本体概念图谱和实例图谱数据。\n\n**你可以这样问我：**\n- "有哪些对象类型？"\n- "查询名为xxx的对象类型的属性"\n- "有哪些链接关系？"\n- "查询xxx对象的实例数据"\n- "搜索xxx相关的所有实例关系"',
      timestamp: new Date(),
    }]);
    setSessionId(undefined);
  };

  return (
    <div className="flex flex-col h-full max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 pb-4 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-sm">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">智能对话</h1>
            <p className="text-xs text-slate-500">基于本体图谱的智能问答</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={handleNewChat} className="gap-2">
          <Sparkles className="w-4 h-4" />
          新对话
        </Button>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-2 mb-4 scroll-smooth">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300",
              msg.role === 'user' ? 'justify-end' : 'justify-start'
            )}
          >
            {/* Assistant Avatar */}
            {msg.role === 'assistant' && (
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shrink-0 mt-0.5 shadow-sm">
                <Bot className="w-4 h-4 text-white" />
              </div>
            )}

            {/* Message Bubble */}
            <div
              className={cn(
                "max-w-[80%] rounded-2xl px-4 py-3 shadow-sm",
                msg.role === 'user'
                  ? 'bg-blue-600 text-white rounded-br-md'
                  : msg.error
                    ? 'bg-red-50 border border-red-200 text-red-800 rounded-bl-md'
                    : 'bg-white border border-slate-200 text-slate-900 rounded-bl-md'
              )}
            >
              {msg.role === 'assistant' ? (
                <MarkdownRender content={msg.content} />
              ) : (
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              )}
              <div
                className={cn(
                  "text-[10px] mt-2",
                  msg.role === 'user' ? 'text-blue-200 text-right' : 'text-slate-400'
                )}
              >
                {msg.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>

            {/* User Avatar */}
            {msg.role === 'user' && (
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-slate-600 to-slate-700 flex items-center justify-center shrink-0 mt-0.5 shadow-sm">
                <User className="w-4 h-4 text-white" />
              </div>
            )}
          </div>
        ))}

        {/* Loading Indicator */}
        {loading && (
          <div className="flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shrink-0 shadow-sm">
              <Bot className="w-4 h-4 text-white" />
            </div>
            <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
              <div className="flex items-center gap-2 text-slate-500 text-sm">
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                <span>思考中...</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="请输入您的问题..."
            rows={1}
            className="flex-1 resize-none outline-none px-3 py-2 text-sm text-slate-900 placeholder-slate-400 max-h-32 scrollbar-thin"
            disabled={loading}
          />
          <Button
            size="sm"
            className="h-9 px-4 rounded-xl gap-2 shrink-0"
            onClick={handleSend}
            disabled={!input.trim() || loading}
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            发送
          </Button>
        </div>
        <div className="px-3 pb-1 text-[10px] text-slate-400 flex items-center gap-2">
          <AlertCircle className="w-3 h-3" />
          支持自然语言查询，按 Enter 发送，Shift+Enter 换行
        </div>
      </div>
    </div>
  );
}
