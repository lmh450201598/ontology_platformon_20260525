import { Router } from 'express';
import fetch from 'node-fetch';

const router = Router();

const MCP_CLIENT_URL = process.env.MCP_CLIENT_URL || 'http://localhost:8001';

router.post('/', async (req, res) => {
  try {
    const { message, session_id } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const response = await fetch(`${MCP_CLIENT_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, session_id }),
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).json({ error: error || 'MCP Client error' });
    }

    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    console.error('[KnowledgeChat] Error:', err.message);
    res.status(502).json({ error: `MCP Client unavailable: ${err.message}` });
  }
});

// Health check for the MCP client
router.get('/health', async (_req, res) => {
  try {
    const response = await fetch(`${MCP_CLIENT_URL}/health`);
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(502).json({ error: `MCP Client unavailable: ${err.message}` });
  }
});

export default router;
