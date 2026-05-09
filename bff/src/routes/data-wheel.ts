import { Router } from 'express';
import fetch from 'node-fetch';
import { pool } from '../db.js';

const router = Router();

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const JAVA_BACKEND = process.env.JAVA_BACKEND_URL || 'http://localhost:8080';
const STREAM_MODEL = 'deepseek-chat';

function checkAI(): boolean {
  return !!DEEPSEEK_API_KEY && DEEPSEEK_API_KEY !== 'null';
}

// ── Fetch current ontology from MySQL ────────────────────────────────────────

async function fetchCurrentOntology(): Promise<{
  objectTypes: any[];
  linkTypes: any[];
  instances: Record<string, any[]>;
  linkInstances: any[];
}> {
  const connection = await pool.getConnection();
  try {
    // 1. Object types
    const [otRows] = await connection.execute(
      'SELECT id, name, description, backing_dataset, parent_object_type FROM object_types ORDER BY name'
    );
    const objectTypes = otRows as any[];

    // 2. Link types
    const [ltRows] = await connection.execute(
      'SELECT id, name, source_object_id, target_object_id, cardinality, description FROM link_types ORDER BY name'
    );
    const linkTypes = ltRows as any[];

    // 3. Instances per object type (top 20 each)
    const instances: Record<string, any[]> = {};
    for (const ot of objectTypes) {
      const tableName = ot.backing_dataset;
      if (!tableName) continue;
      try {
        const [instRows] = await connection.execute(
          `SELECT * FROM \`${tableName}\` LIMIT 20`
        );
        instances[ot.name] = instRows as any[];
      } catch (e) {
        // Table may not exist yet
        instances[ot.name] = [];
      }
    }

    // 4. Link instance data (top 50)
    const [liRows] = await connection.execute(
      'SELECT link_type_id, source_instance_id, target_instance_id FROM link_instance_data ORDER BY id DESC LIMIT 50'
    );
    const linkInstances = liRows as any[];

    return { objectTypes, linkTypes, instances, linkInstances };
  } finally {
    connection.release();
  }
}

// ── Build current ontology context for DeepSeek ──────────────────────────────

function buildOntologyContext(ontology: {
  objectTypes: any[];
  linkTypes: any[];
  instances: Record<string, any[]>;
  linkInstances: any[];
}): string {
  const otSummary = ontology.objectTypes.map(ot => {
    const inst = ontology.instances[ot.name];
    const instNames = inst?.length > 0
      ? inst.map((i: any) => i.name || i.unique_id || JSON.stringify(i)).filter(Boolean).slice(0, 10)
      : [];
    return {
      id: ot.id,
      name: ot.name,
      description: ot.description,
      parent_object_type: ot.parent_object_type,
      existingInstances: instNames,
    };
  });

  const ltSummary = ontology.linkTypes.map(lt => {
    const relatedInstances = ontology.linkInstances
      .filter(li => li.link_type_id === lt.id)
      .slice(0, 10)
      .map(li => `${li.source_instance_id} → ${li.target_instance_id}`);
    return {
      id: lt.id,
      name: lt.name,
      source: lt.source_object_id,
      target: lt.target_object_id,
      cardinality: lt.cardinality,
      description: lt.description,
      existingInstances: relatedInstances,
    };
  });

  return JSON.stringify({ objectTypes: otSummary, linkTypes: ltSummary }, null, 2);
}

// System prompt for ontology extraction WITH context
const ONTOLOGY_EXTRACTION_PROMPT = `你是一个本体建模专家。你的任务是从给定的标题和文本内容中抽取本体信息，并基于已有的本体图谱进行增量补充或修改。

## 已有本体图谱

系统会提供当前已有的对象类型、链接类型以及它们的实例数据。你需要在此基础上分析：
- 哪些对象类型是已有的（不需要重复添加）
- 哪些对象类型需要新增
- 哪些链接类型是已有的（不需要重复添加）
- 哪些链接类型需要新增
- 哪些实例数据是已有的（不需要重复添加）
- 哪些实例数据需要新增

## 抽取规则

1. **对象类型 (objectType)**: 从文本中识别出所有的业务实体类型。
   - name_cn: 中文名称
   - name_en: 英文名称（使用小写下划线格式）
   - parentObjectTypeName: 父对象类型的中文名称，如果没有则为 null
   - description: 简要描述，可为空字符串
   - action: 操作类型，可选值："add"（新增）、"modify"（修改已有）、"keep"（已存在无需变更）

2. **链接类型及实例 (linkTypeAndInstance)**: 识别实体之间的关系及具体实例。
   - name: 链接类型的中文名称
   - sourceObjectType: 源对象类型的中文名称
   - targetObjectType: 目标对象类型的中文名称
   - linkTypeCategory: 关系类别，如"生产"、"组成"、"属于"等
   - description: 简要描述，可为空字符串
   - action: 操作类型，可选值："add"（新增）、"modify"（修改已有）、"keep"（已存在无需变更）
   - instanceList: 具体的实例列表
     - sourceInstance: 源对象实例名称
     - targetInstance: 目标对象实例名称
     - instanceAction: 实例操作类型，可选值："add"（新增）、"keep"（已存在无需变更）

## 输出格式要求

你必须只输出合法的 JSON，不要输出任何其他解释性文字。JSON 必须严格符合以下模板结构：

{
    "objectType": [
        {
            "name_cn": "...",
            "name_en": "...",
            "parentObjectTypeName": "..." 或 null,
            "description": "",
            "action": "add" 或 "modify" 或 "keep"
        }
    ],
    "linkTypeAndInstance": [
        {
            "name": "...",
            "sourceObjectType": "...",
            "targetObjectType": "...",
            "linkTypeCategory": "...",
            "description": "",
            "action": "add" 或 "modify" 或 "keep",
            "instanceList": [
                {
                    "sourceInstance": "...",
                    "targetInstance": "...",
                    "instanceAction": "add" 或 "keep"
                }
            ]
        }
    ]
}

## 注意事项

- 对比已有图谱，标注每个对象类型和链接类型的 action 字段
- 已存在的对象类型/链接类型，action 设为 "keep"，但仍要在输出中列出
- 需要新增的对象类型/链接类型，action 设为 "add"
- 需要修改描述等属性的对象类型/链接类型，action 设为 "modify"
- 已存在的实例，instanceAction 设为 "keep"；新实例设为 "add"
- 确保 sourceObjectType 和 targetObjectType 在 objectType 中有对应的对象类型
- 实例数据必须来源于文本，不要编造
- 如果文本中没有足够的信息，可以返回空的数组
- 必须严格输出 JSON 格式，不要添加 markdown 代码块标记`;

// ── Stream ontology extraction ───────────────────────────────────────────────

router.post('/extract', async (req, res) => {
  if (!checkAI()) {
    return res.status(503).json({ error: 'DEEPSEEK_API_KEY not configured' });
  }

  try {
    const { title, content } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }

    // Fetch current ontology from database
    let contextStr = '';
    try {
      const currentOntology = await fetchCurrentOntology();
      contextStr = buildOntologyContext(currentOntology);
    } catch (e: any) {
      console.warn('[DataWheel] Failed to fetch current ontology:', e.message);
      contextStr = '{}';
    }

    const userMessage = `## 标题\n${title}\n\n## 内容\n${content}\n\n## 当前已有的本体图谱数据\n\`\`\`json\n${contextStr}\n\`\`\`\n\n请基于以上已有图谱，从标题和内容中抽取本体信息，标注每个元素的 action（add/modify/keep）。`;

    const messages = [
      { role: 'system', content: ONTOLOGY_EXTRACTION_PROMPT },
      { role: 'user', content: userMessage },
    ];

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180000);

    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: STREAM_MODEL,
        messages,
        temperature: 0.3,
        max_tokens: 8192,
        stream: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.text();
      res.write(`data: ${JSON.stringify({ error: `DeepSeek API error: ${error}` }) }\n\n`);
      res.end();
      return;
    }

    const reader = response.body;
    if (!reader) {
      res.write(`data: ${JSON.stringify({ error: 'No response body' }) }\n\n`);
      res.end();
      return;
    }

    let fullContent = '';
    const decoder = new TextDecoder();

    reader.on('data', (chunk: Buffer) => {
      const text = decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            // Try to parse as JSON and validate
            let parsedJson: any = null;
            let parseError: string | null = null;
            try {
              const jsonMatch = fullContent.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                parsedJson = JSON.parse(jsonMatch[0]);
              }
            } catch (e: any) {
              parseError = e.message;
            }

            res.write(`data: ${JSON.stringify({ done: true, json: parsedJson, parseError, fullContent }) }\n\n`);
            res.end();
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            if (content) {
              fullContent += content;
              res.write(`data: ${JSON.stringify({ content }) }\n\n`);
            }
          } catch (e) {
            // Ignore parse errors for incomplete chunks
          }
        }
      }
    });

    reader.on('error', (err: any) => {
      console.error('[DataWheel Stream] Error:', err);
      res.write(`data: ${JSON.stringify({ error: err.message }) }\n\n`);
      res.end();
    });
  } catch (err: any) {
    console.error('[DataWheel Stream] Error:', err);
    res.write(`data: ${JSON.stringify({ error: err.message }) }\n\n`);
    res.end();
  }
});

// ── Analyze: server-side comparison ──────────────────────────────────────────

router.post('/analyze', async (req, res) => {
  try {
    const { extracted } = req.body;
    if (!extracted) {
      return res.status(400).json({ error: 'Extracted data is required' });
    }

    const currentOntology = await fetchCurrentOntology();

    // Build lookup maps
    const existingOtMap = new Map<string, any>();
    for (const ot of currentOntology.objectTypes) {
      existingOtMap.set(ot.name, ot);
    }

    const existingLtMap = new Map<string, any>();
    for (const lt of currentOntology.linkTypes) {
      existingLtMap.set(lt.name, lt);
    }

    // Build instance lookup per object type
    const existingInstMap = new Map<string, Set<string>>();
    for (const ot of currentOntology.objectTypes) {
      const insts = currentOntology.instances[ot.name] || [];
      const names = new Set(insts.map((i: any) => (i.name || i.unique_id || '').toString().toLowerCase()));
      existingInstMap.set(ot.name, names);
    }

    // Build link instance lookup
    const existingLinkInstMap = new Map<string, Set<string>>();
    for (const li of currentOntology.linkInstances) {
      const key = li.link_type_id;
      if (!existingLinkInstMap.has(key)) existingLinkInstMap.set(key, new Set());
      const val = `${(li.source_instance_id || '').toLowerCase()}→${(li.target_instance_id || '').toLowerCase()}`;
      existingLinkInstMap.get(key)!.add(val);
    }

    // Analyze object types
    const objectTypeAnalysis = (extracted.objectType || []).map((ot: any) => {
      const existing = existingOtMap.get(ot.name_cn);
      return {
        name_cn: ot.name_cn,
        name_en: ot.name_en,
        parentObjectTypeName: ot.parentObjectTypeName,
        description: ot.description,
        action: ot.action || (existing ? 'keep' : 'add'),
        existing: !!existing,
        existingId: existing?.id || null,
      };
    });

    // Analyze link types
    const linkTypeAnalysis = (extracted.linkTypeAndInstance || []).map((lt: any) => {
      const existing = existingLtMap.get(lt.name);
      const sourceOt = existingOtMap.get(lt.sourceObjectType) ||
        objectTypeAnalysis.find((o: any) => o.name_cn === lt.sourceObjectType);
      const targetOt = existingOtMap.get(lt.targetObjectType) ||
        objectTypeAnalysis.find((o: any) => o.name_cn === lt.targetObjectType);

      // Analyze instances
      const instanceAnalysis = (lt.instanceList || []).map((inst: any) => {
        // Check source instance
        const sourceInsts = existingInstMap.get(lt.sourceObjectType);
        const targetInsts = existingInstMap.get(lt.targetObjectType);
        const sourceExists = sourceInsts?.has((inst.sourceInstance || '').toLowerCase()) || false;
        const targetExists = targetInsts?.has((inst.targetInstance || '').toLowerCase()) || false;

        return {
          sourceInstance: inst.sourceInstance,
          targetInstance: inst.targetInstance,
          instanceAction: inst.instanceAction || (sourceExists && targetExists ? 'keep' : 'add'),
          sourceExists,
          targetExists,
        };
      });

      return {
        name: lt.name,
        sourceObjectType: lt.sourceObjectType,
        targetObjectType: lt.targetObjectType,
        linkTypeCategory: lt.linkTypeCategory,
        description: lt.description,
        action: lt.action || (existing ? 'keep' : 'add'),
        existing: !!existing,
        existingId: existing?.id || null,
        sourceExists: !!sourceOt,
        targetExists: !!targetOt,
        sourceId: sourceOt?.id || sourceOt?.existingId || null,
        targetId: targetOt?.id || targetOt?.existingId || null,
        instanceAnalysis,
      };
    });

    res.json({
      success: true,
      analysis: {
        objectTypeAnalysis,
        linkTypeAnalysis,
        summary: {
          totalObjectTypes: objectTypeAnalysis.length,
          addObjectTypes: objectTypeAnalysis.filter((o: any) => o.action === 'add').length,
          modifyObjectTypes: objectTypeAnalysis.filter((o: any) => o.action === 'modify').length,
          keepObjectTypes: objectTypeAnalysis.filter((o: any) => o.action === 'keep').length,
          totalLinkTypes: linkTypeAnalysis.length,
          addLinkTypes: linkTypeAnalysis.filter((l: any) => l.action === 'add').length,
          modifyLinkTypes: linkTypeAnalysis.filter((l: any) => l.action === 'modify').length,
          keepLinkTypes: linkTypeAnalysis.filter((l: any) => l.action === 'keep').length,
          totalInstances: linkTypeAnalysis.reduce((sum: number, l: any) => sum + l.instanceAnalysis.length, 0),
          addInstances: linkTypeAnalysis.reduce((sum: number, l: any) => sum + l.instanceAnalysis.filter((i: any) => i.instanceAction === 'add').length, 0),
          keepInstances: linkTypeAnalysis.reduce((sum: number, l: any) => sum + l.instanceAnalysis.filter((i: any) => i.instanceAction === 'keep').length, 0),
        },
      },
    });
  } catch (err: any) {
    console.error('[DataWheel Analyze] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Execute SQL ──────────────────────────────────────────────────────────────

router.post('/execute', async (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql || typeof sql !== 'string') {
      return res.status(400).json({ error: 'SQL script is required' });
    }

    // Split multiple statements
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    const results: any[] = [];
    const connection = await pool.getConnection();

    try {
      for (const stmt of statements) {
        try {
          const [rows] = await connection.execute(stmt);
          results.push({
            statement: stmt.substring(0, 200) + (stmt.length > 200 ? '...' : ''),
            success: true,
            affectedRows: (rows as any).affectedRows,
            insertId: (rows as any).insertId,
            rowCount: Array.isArray(rows) ? rows.length : 0,
          });
        } catch (err: any) {
          results.push({
            statement: stmt.substring(0, 200) + (stmt.length > 200 ? '...' : ''),
            success: false,
            error: err.message,
          });
        }
      }
    } finally {
      connection.release();
    }

    const hasError = results.some(r => !r.success);
    res.json({
      success: !hasError,
      results,
      executedCount: results.length,
      successCount: results.filter(r => r.success).length,
      errorCount: results.filter(r => !r.success).length,
    });
  } catch (err: any) {
    console.error('[DataWheel Execute] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
