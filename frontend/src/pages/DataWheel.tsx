import React, { useState, useRef, useCallback, useEffect } from 'react';
import { OntologyData } from '@/src/store/ontologyStore';
import { Button } from '@/src/components/ui/button';
import { Badge } from '@/src/components/ui/badge';
import {
  Sparkles, Loader2, Database, Link as LinkIcon, Play, FileText,
  ChevronRight, ChevronDown, CheckCircle2, AlertCircle,
  Plus, Trash2, Terminal, Square, RefreshCw, Edit3, Eye,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/src/api/client';
import { streamOntologyExtraction } from '@/src/api/streamClient';
import { cn } from '@/src/lib/utils';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExtractedObjectType {
  name_cn: string;
  name_en: string;
  parentObjectTypeName: string | null;
  description: string;
  action?: 'add' | 'modify' | 'keep';
}

interface ExtractedInstance {
  sourceInstance: string;
  targetInstance: string;
  instanceAction?: 'add' | 'keep';
}

interface ExtractedLinkType {
  name: string;
  sourceObjectType: string;
  targetObjectType: string;
  linkTypeCategory: string;
  description: string;
  action?: 'add' | 'modify' | 'keep';
  instanceList: ExtractedInstance[];
}

interface ExtractedOntology {
  objectType: ExtractedObjectType[];
  linkTypeAndInstance: ExtractedLinkType[];
}

// Server-side analysis result
interface ObjectTypeAnalysis {
  name_cn: string;
  name_en: string;
  parentObjectTypeName: string | null;
  description: string;
  action: 'add' | 'modify' | 'keep';
  existing: boolean;
  existingId: string | null;
}

interface InstanceAnalysis {
  sourceInstance: string;
  targetInstance: string;
  instanceAction: 'add' | 'keep';
  sourceExists: boolean;
  targetExists: boolean;
}

interface LinkTypeAnalysis {
  name: string;
  sourceObjectType: string;
  targetObjectType: string;
  linkTypeCategory: string;
  description: string;
  action: 'add' | 'modify' | 'keep';
  existing: boolean;
  existingId: string | null;
  sourceExists: boolean;
  targetExists: boolean;
  sourceId: string | null;
  targetId: string | null;
  instanceAnalysis: InstanceAnalysis[];
}

interface AnalysisSummary {
  totalObjectTypes: number;
  addObjectTypes: number;
  modifyObjectTypes: number;
  keepObjectTypes: number;
  totalLinkTypes: number;
  addLinkTypes: number;
  modifyLinkTypes: number;
  keepLinkTypes: number;
  totalInstances: number;
  addInstances: number;
  keepInstances: number;
}

interface ServerAnalysisResult {
  objectTypeAnalysis: ObjectTypeAnalysis[];
  linkTypeAnalysis: LinkTypeAnalysis[];
  summary: AnalysisSummary;
}

// ── SQL Generation ────────────────────────────────────────────────────────────

function generateSql(
  extracted: ExtractedOntology,
  analysis: ServerAnalysisResult,
  existing: OntologyData
): string {
  const lines: string[] = [];
  lines.push('-- 数据飞轮自动生成的 SQL 脚本');
  lines.push(`-- 生成时间: ${new Date().toLocaleString('zh-CN')}`);
  lines.push('');

  // 1. Insert new object types
  const addObjectTypes = analysis.objectTypeAnalysis.filter(ot => ot.action === 'add');
  if (addObjectTypes.length > 0) {
    lines.push('-- 1. 新增对象类型');
    for (const ot of addObjectTypes) {
      const id = ot.name_en.toLowerCase().replace(/\s+/g, '_');
      const parentClause = ot.parentObjectTypeName
        ? `, parent_object_type`
        : '';
      const parentValue = ot.parentObjectTypeName
        ? `, '${ot.parentObjectTypeName}'`
        : '';
      lines.push(`INSERT INTO object_types (id, name, description, icon, backing_dataset, data_source, database_name, created_at, updated_at${parentClause})`);
      lines.push(`VALUES ('${id}', '${ot.name_cn}', '${ot.description || ''}', 'Database', '${id}', 'mysql', 'ontology', NOW(), NOW()${parentValue});`);
      lines.push('');
    }
  }

  // 2. Modify existing object types
  const modifyObjectTypes = analysis.objectTypeAnalysis.filter(ot => ot.action === 'modify');
  if (modifyObjectTypes.length > 0) {
    lines.push('-- 2. 修改对象类型');
    for (const ot of modifyObjectTypes) {
      if (ot.existingId) {
        lines.push(`UPDATE object_types SET description = '${ot.description || ''}', updated_at = NOW()`);
        if (ot.parentObjectTypeName) {
          lines.push(`  , parent_object_type = '${ot.parentObjectTypeName}'`);
        }
        lines.push(`WHERE id = '${ot.existingId}';`);
        lines.push('');
      }
    }
  }

  // 3. Create dataset tables for new object types
  if (addObjectTypes.length > 0) {
    lines.push('-- 3. 创建新对象类型对应的数据集表');
    for (const ot of addObjectTypes) {
      const tableName = ot.name_en.toLowerCase().replace(/\s+/g, '_');
      lines.push(`CREATE TABLE IF NOT EXISTS ${tableName} (`);
      lines.push(`  id BIGINT NOT NULL AUTO_INCREMENT COMMENT '自增主键ID',`);
      lines.push(`  unique_id VARCHAR(100) NOT NULL COMMENT '唯一标识符',`);
      lines.push(`  name VARCHAR(255) DEFAULT NULL COMMENT '名称',`);
      lines.push(`  description TEXT DEFAULT NULL COMMENT '描述',`);
      lines.push(`  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',`);
      lines.push(`  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',`);
      lines.push(`  PRIMARY KEY (id),`);
      lines.push(`  UNIQUE KEY unique_id (unique_id)`);
      lines.push(`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='${ot.name_cn}信息表';`);
      lines.push('');
    }
  }

  // 4. Insert new link types
  const addLinkTypes = analysis.linkTypeAnalysis.filter(lt => lt.action === 'add' && lt.sourceExists && lt.targetExists);
  if (addLinkTypes.length > 0) {
    lines.push('-- 4. 新增链接类型');
    for (const lt of addLinkTypes) {
      const sourceId = lt.sourceId || lt.sourceObjectType.toLowerCase().replace(/\s+/g, '_');
      const targetId = lt.targetId || lt.targetObjectType.toLowerCase().replace(/\s+/g, '_');
      if (!sourceId || !targetId) continue;

      const linkId = `lt_${sourceId}_${targetId}_${Date.now()}`;
      lines.push(`INSERT INTO link_types (id, name, source_object_id, target_object_id, cardinality, description, created_at, updated_at)`);
      lines.push(`VALUES ('${linkId}', '${lt.name}', '${sourceId}', '${targetId}', 'N:M', '${lt.description || ''}', NOW(), NOW());`);
      lines.push('');
    }
  }

  // 5. Modify existing link types
  const modifyLinkTypes = analysis.linkTypeAnalysis.filter(lt => lt.action === 'modify');
  if (modifyLinkTypes.length > 0) {
    lines.push('-- 5. 修改链接类型');
    for (const lt of modifyLinkTypes) {
      if (lt.existingId) {
        lines.push(`UPDATE link_types SET description = '${lt.description || ''}', updated_at = NOW()`);
        lines.push(`WHERE id = '${lt.existingId}';`);
        lines.push('');
      }
    }
  }

  // 6. Insert instances into dataset tables (only add instances)
  const instancesByObjectType = new Map<string, Set<string>>();
  for (const lt of analysis.linkTypeAnalysis) {
    for (const inst of lt.instanceAnalysis) {
      if (inst.instanceAction === 'add') {
        if (!instancesByObjectType.has(lt.sourceObjectType)) {
          instancesByObjectType.set(lt.sourceObjectType, new Set());
        }
        instancesByObjectType.get(lt.sourceObjectType)!.add(inst.sourceInstance);

        if (!instancesByObjectType.has(lt.targetObjectType)) {
          instancesByObjectType.set(lt.targetObjectType, new Set());
        }
        instancesByObjectType.get(lt.targetObjectType)!.add(inst.targetInstance);
      }
    }
  }

  if (instancesByObjectType.size > 0) {
    lines.push('-- 6. 插入对象类型实例');
    for (const [objTypeName, instances] of instancesByObjectType) {
      const existingOt = existing.objectTypes.find(ot => ot.name === objTypeName);
      let tableName = existingOt?.backingDataset;

      if (!tableName) {
        const extractedOt = extracted.objectType?.find(ot => ot.name_cn === objTypeName);
        if (extractedOt) {
          tableName = extractedOt.name_en.toLowerCase().replace(/\s+/g, '_');
        }
      }

      if (!tableName) continue;

      for (const instanceName of instances) {
        const uid = instanceName.replace(/\s+/g, '_').replace(/[^\w\u4e00-\u9fa5]/g, '_').substring(0, 50) + '_' + Math.floor(Math.random() * 10000);
        lines.push(`INSERT INTO ${tableName} (unique_id, name, description, created_at, updated_at)`);
        lines.push(`VALUES ('${uid}', '${instanceName}', '', NOW(), NOW())`);
        lines.push(`ON DUPLICATE KEY UPDATE updated_at = NOW();`);
        lines.push('');
      }
    }
  }

  // 7. Insert link instance data (only for add link types with add instances)
  if (addLinkTypes.length > 0) {
    const addLinkInstances: Array<{ lt: LinkTypeAnalysis; inst: InstanceAnalysis }> = [];
    for (const lt of analysis.linkTypeAnalysis) {
      if (lt.action === 'add') {
        for (const inst of lt.instanceAnalysis) {
          if (inst.instanceAction === 'add') {
            addLinkInstances.push({ lt, inst });
          }
        }
      }
    }

    if (addLinkInstances.length > 0) {
      lines.push('-- 7. 插入链接实例数据');
      for (const { lt, inst } of addLinkInstances) {
        const sourceId = lt.sourceId || lt.sourceObjectType.toLowerCase().replace(/\s+/g, '_');
        const targetId = lt.targetId || lt.targetObjectType.toLowerCase().replace(/\s+/g, '_');
        if (!sourceId || !targetId) continue;

        const linkId = `lt_${sourceId}_${targetId}_${Date.now()}`;
        const srcUid = inst.sourceInstance.replace(/\s+/g, '_').replace(/[^\w\u4e00-\u9fa5]/g, '_').substring(0, 50) + '_' + Math.floor(Math.random() * 10000);
        const tgtUid = inst.targetInstance.replace(/\s+/g, '_').replace(/[^\w\u4e00-\u9fa5]/g, '_').substring(0, 50) + '_' + Math.floor(Math.random() * 10000);
        lines.push(`INSERT INTO link_instance_data (link_type_id, source_instance_id, target_instance_id, created_at)`);
        lines.push(`VALUES ('${linkId}', '${srcUid}', '${tgtUid}', NOW());`);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ── Action Badge Component ───────────────────────────────────────────────────

function ActionBadge({ action }: { action: 'add' | 'modify' | 'keep' }) {
  if (action === 'add') {
    return (
      <Badge className="text-[10px] h-4 px-1 bg-blue-600">
        <Plus className="w-2.5 h-2.5 mr-0.5" /> 新增
      </Badge>
    );
  }
  if (action === 'modify') {
    return (
      <Badge className="text-[10px] h-4 px-1 bg-amber-500">
        <Edit3 className="w-2.5 h-2.5 mr-0.5" /> 修改
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] h-4 px-1 text-slate-500">
      <Eye className="w-2.5 h-2.5 mr-0.5" /> 已存在
    </Badge>
  );
}

function InstanceActionBadge({ action }: { action: 'add' | 'keep' }) {
  if (action === 'add') {
    return (
      <Badge className="text-[10px] h-4 px-1 bg-purple-600">
        <Plus className="w-2.5 h-2.5 mr-0.5" /> 新增
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] h-4 px-1 text-slate-500">
      <Eye className="w-2.5 h-2.5 mr-0.5" /> 已存在
    </Badge>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function DataWheel({ data }: { data: OntologyData }) {
  // Region 1: Text Input
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  // Region 2: Ontology Extraction
  const [extracting, setExtracting] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [extractedJson, setExtractedJson] = useState<ExtractedOntology | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Region 3: Analysis
  const [analysis, setAnalysis] = useState<ServerAnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  // Region 4: SQL Script
  const [sqlScript, setSqlScript] = useState('');
  const [executing, setExecuting] = useState(false);
  const [execResults, setExecResults] = useState<any[] | null>(null);

  // Expand states
  const [expandObjects, setExpandObjects] = useState(true);
  const [expandLinks, setExpandLinks] = useState(true);
  const [expandInstances, setExpandInstances] = useState(true);

  // Auto-run analysis when extractedJson changes
  useEffect(() => {
    if (extractedJson) {
      runAnalysis(extractedJson);
    }
  }, [extractedJson]);

  const runAnalysis = async (extracted: ExtractedOntology) => {
    setAnalyzing(true);
    try {
      const result = await api.analyzeOntology(extracted, data);
      if (result.analysis) {
        const serverAnalysis = result.analysis as ServerAnalysisResult;
        setAnalysis(serverAnalysis);
        const sql = generateSql(extracted, serverAnalysis, data);
        setSqlScript(sql);
      }
    } catch (err: any) {
      console.error('Analysis error:', err);
      toast.error('分析失败: ' + (err.message || '未知错误'));
    } finally {
      setAnalyzing(false);
    }
  };

  const handleExtract = async () => {
    if (!title.trim() || !content.trim()) {
      toast.error('请填写标题和内容');
      return;
    }

    setExtracting(true);
    setStreamText('');
    setExtractedJson(null);
    setExtractError(null);
    setAnalysis(null);
    setSqlScript('');
    setExecResults(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      let fullText = '';
      for await (const chunk of streamOntologyExtraction(title.trim(), content.trim())) {
        if (abortController.signal.aborted) break;

        if (chunk.error) {
          throw new Error(chunk.error);
        }

        if (chunk.content) {
          fullText += chunk.content;
          setStreamText(fullText);
        }

        if (chunk.done) {
          if (chunk.json) {
            setExtractedJson(chunk.json);
          } else if (chunk.parseError) {
            setExtractError(`JSON 解析失败: ${chunk.parseError}`);
            if (chunk.fullContent) {
              setStreamText(chunk.fullContent);
            }
          }
          break;
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setExtractError(err.message || '抽取失败');
        toast.error(err.message || '抽取失败');
      }
    } finally {
      abortControllerRef.current = null;
      setExtracting(false);
    }
  };

  const handleStop = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setExtracting(false);
  };

  const handleExecute = async () => {
    if (!sqlScript.trim()) return;
    setExecuting(true);
    setExecResults(null);
    try {
      const result = await api.executeSql(sqlScript);
      setExecResults(result.results);
      if (result.success) {
        toast.success(`执行成功: ${result.successCount}/${result.executedCount} 条语句`);
      } else {
        toast.error(`部分语句执行失败: ${result.errorCount} 条错误`);
      }
    } catch (err: any) {
      toast.error(err.message || '执行失败');
    } finally {
      setExecuting(false);
    }
  };

  const toggleExpand = (setter: React.Dispatch<React.SetStateAction<boolean>>) => {
    setter(prev => !prev);
  };

  return (
    <div className="flex h-[calc(100vh-80px)] gap-4 -m-6 p-6">
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* Region 1: Text Input */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div className="w-1/5 min-w-[240px] flex flex-col gap-3">
        <div className="flex items-center gap-2 text-slate-800">
          <FileText className="w-4 h-4 text-blue-600" />
          <h2 className="font-semibold text-sm">文本录入</h2>
        </div>

        <div className="flex-1 flex flex-col gap-3 bg-white rounded-lg border border-slate-200 p-4">
          <div>
            <label className="text-xs font-medium text-slate-500 mb-1.5 block">标题</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="请输入标题..."
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
            />
          </div>

          <div className="flex-1 flex flex-col">
            <label className="text-xs font-medium text-slate-500 mb-1.5 block">内容</label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="请输入需要分析的文本内容..."
              className="flex-1 w-full px-3 py-2 text-sm border border-slate-200 rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400 min-h-[200px]"
            />
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* Region 2: Ontology Extraction */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div className="w-1/4 min-w-[300px] flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-slate-800">
            <Sparkles className="w-4 h-4 text-purple-600" />
            <h2 className="font-semibold text-sm">本体抽取</h2>
          </div>
          <Button
            size="sm"
            className="gap-1 h-7 text-xs bg-purple-600 hover:bg-purple-700"
            onClick={extracting ? handleStop : handleExtract}
            disabled={!title.trim() || !content.trim()}
          >
            {extracting ? (
              <><Square className="w-3 h-3" /> 停止</>
            ) : (
              <><Sparkles className="w-3 h-3" /> 本体抽取</>
            )}
          </Button>
        </div>

        <div className="flex-1 bg-white rounded-lg border border-slate-200 flex flex-col overflow-hidden">
          {extracting && !streamText && (
            <div className="flex-1 flex items-center justify-center text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              <span className="text-sm">正在加载已有图谱并抽取本体...</span>
            </div>
          )}

          {(streamText || extractedJson) && (
            <div className="flex-1 overflow-auto p-4">
              {extractError && (
                <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700">
                  <div className="flex items-center gap-1.5 mb-1">
                    <AlertCircle className="w-3.5 h-3.5" />
                    <span className="font-medium">{extractError}</span>
                  </div>
                  <p className="text-red-500/80">已显示原始输出内容，您可以手动修正 JSON。</p>
                </div>
              )}

              {extractedJson && !extractError && (
                <div className="mb-3 p-2 bg-green-50 border border-green-200 rounded-md">
                  <div className="flex items-center gap-1.5 text-xs text-green-700">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span className="font-medium">
                      抽取完成：{extractedJson.objectType?.length || 0} 个对象类型，
                      {extractedJson.linkTypeAndInstance?.length || 0} 个链接类型
                    </span>
                  </div>
                </div>
              )}

              <pre className="text-xs font-mono text-slate-700 whitespace-pre-wrap break-all">
                {streamText}
              </pre>
            </div>
          )}

          {!streamText && !extracting && (
            <div className="flex-1 flex items-center justify-center text-slate-400">
              <div className="text-center">
                <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-xs">点击"本体抽取"按钮</p>
                <p className="text-[10px] mt-1">将基于已有图谱进行增量分析</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* Region 3: Ontology Analysis */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div className="w-1/4 min-w-[300px] flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-slate-800">
            <Database className="w-4 h-4 text-emerald-600" />
            <h2 className="font-semibold text-sm">本体分析</h2>
          </div>
          {analyzing && (
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              分析中...
            </div>
          )}
        </div>

        <div className="flex-1 bg-white rounded-lg border border-slate-200 flex flex-col overflow-hidden">
          {!analysis && !analyzing && (
            <div className="flex-1 flex items-center justify-center text-slate-400">
              <div className="text-center">
                <Database className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-xs">等待本体抽取结果</p>
                <p className="text-[10px] mt-1">抽取完成后将自动与已有图谱比对</p>
              </div>
            </div>
          )}

          {analyzing && !analysis && (
            <div className="flex-1 flex items-center justify-center text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              <span className="text-sm">正在与已有图谱比对分析...</span>
            </div>
          )}

          {analysis && (
            <div className="flex-1 overflow-auto p-4 space-y-4">
              {/* Summary */}
              <div className="p-3 bg-gradient-to-r from-slate-50 to-blue-50/30 rounded-lg border border-slate-200">
                <div className="text-xs font-medium text-slate-600 mb-2">变更摘要</div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="text-center">
                    <div className="text-lg font-bold text-blue-600">{analysis.summary.addObjectTypes + analysis.summary.addLinkTypes}</div>
                    <div className="text-[10px] text-slate-500">新增</div>
                  </div>
                  <div className="text-center">
                    <div className="text-lg font-bold text-amber-500">{analysis.summary.modifyObjectTypes + analysis.summary.modifyLinkTypes}</div>
                    <div className="text-[10px] text-slate-500">修改</div>
                  </div>
                  <div className="text-center">
                    <div className="text-lg font-bold text-slate-400">{analysis.summary.keepObjectTypes + analysis.summary.keepLinkTypes}</div>
                    <div className="text-[10px] text-slate-500">已存在</div>
                  </div>
                </div>
                <div className="mt-2 pt-2 border-t border-slate-200 flex justify-between text-[10px] text-slate-500">
                  <span>对象类型: {analysis.summary.addObjectTypes}增 / {analysis.summary.modifyObjectTypes}改 / {analysis.summary.keepObjectTypes}留</span>
                  <span>实例: {analysis.summary.addInstances}增 / {analysis.summary.keepInstances}留</span>
                </div>
              </div>

              {/* Object Types */}
              <div>
                <button
                  onClick={() => toggleExpand(setExpandObjects)}
                  className="flex items-center gap-2 text-xs font-medium text-slate-700 mb-2 w-full text-left"
                >
                  {expandObjects ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <Database className="w-3.5 h-3.5 text-blue-500" />
                  对象类型 ({analysis.objectTypeAnalysis.length})
                </button>
                {expandObjects && (
                  <div className="space-y-2 ml-5">
                    {analysis.objectTypeAnalysis.length === 0 && (
                      <p className="text-xs text-slate-400">未识别到对象类型</p>
                    )}
                    {analysis.objectTypeAnalysis.map((ot, i) => (
                      <div key={i} className={cn(
                        "p-2.5 rounded-md border text-xs",
                        ot.action === 'add'
                          ? "bg-blue-50 border-blue-200 text-slate-700"
                          : ot.action === 'modify'
                            ? "bg-amber-50 border-amber-200 text-slate-700"
                            : "bg-slate-50 border-slate-200 text-slate-500"
                      )}>
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{ot.name_cn}</span>
                          <ActionBadge action={ot.action} />
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1">
                          {ot.name_en}
                          {ot.parentObjectTypeName && (
                            <span> · 父类型: {ot.parentObjectTypeName}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Link Types */}
              <div>
                <button
                  onClick={() => toggleExpand(setExpandLinks)}
                  className="flex items-center gap-2 text-xs font-medium text-slate-700 mb-2 w-full text-left"
                >
                  {expandLinks ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <LinkIcon className="w-3.5 h-3.5 text-emerald-500" />
                  链接类型 ({analysis.linkTypeAnalysis.length})
                </button>
                {expandLinks && (
                  <div className="space-y-2 ml-5">
                    {analysis.linkTypeAnalysis.length === 0 && (
                      <p className="text-xs text-slate-400">未识别到链接类型</p>
                    )}
                    {analysis.linkTypeAnalysis.map((lt, i) => (
                      <div key={i} className={cn(
                        "p-2.5 rounded-md border text-xs",
                        lt.action === 'add'
                          ? !lt.sourceExists || !lt.targetExists
                            ? "bg-amber-50 border-amber-200 text-slate-700"
                            : "bg-emerald-50 border-emerald-200 text-slate-700"
                          : lt.action === 'modify'
                            ? "bg-amber-50 border-amber-200 text-slate-700"
                            : "bg-slate-50 border-slate-200 text-slate-500"
                      )}>
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{lt.name}</span>
                          <ActionBadge action={lt.action} />
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1">
                          {lt.sourceObjectType} → {lt.targetObjectType}
                          {!lt.sourceExists && <span className="text-amber-600 ml-1">(源不存在)</span>}
                          {!lt.targetExists && <span className="text-amber-600 ml-1">(目标不存在)</span>}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          类别: {lt.linkTypeCategory} · 实例: {lt.instanceAnalysis.length}
                          {lt.instanceAnalysis.length > 0 && (
                            <span className="ml-1">
                              (增{lt.instanceAnalysis.filter(i => i.instanceAction === 'add').length}
                              /留{lt.instanceAnalysis.filter(i => i.instanceAction === 'keep').length})
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Instances */}
              <div>
                <button
                  onClick={() => toggleExpand(setExpandInstances)}
                  className="flex items-center gap-2 text-xs font-medium text-slate-700 mb-2 w-full text-left"
                >
                  {expandInstances ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <Plus className="w-3.5 h-3.5 text-purple-500" />
                  实例数据 ({analysis.summary.totalInstances})
                </button>
                {expandInstances && (
                  <div className="space-y-2 ml-5">
                    {analysis.summary.totalInstances === 0 && (
                      <p className="text-xs text-slate-400">未识别到实例数据</p>
                    )}
                    {analysis.linkTypeAnalysis.map((lt, ltIdx) =>
                      lt.instanceAnalysis.map((inst, instIdx) => (
                        <div key={`${ltIdx}-${instIdx}`} className={cn(
                          "p-2.5 rounded-md border text-xs",
                          inst.instanceAction === 'add'
                            ? "border-purple-100 bg-purple-50/50"
                            : "border-slate-100 bg-slate-50/50"
                        )}>
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-purple-800">{lt.name}</span>
                            <InstanceActionBadge action={inst.instanceAction} />
                          </div>
                          <div className="text-[10px] text-slate-500 mt-1">
                            <span className={cn("text-slate-700", !inst.sourceExists && "text-amber-600")}>
                              {inst.sourceInstance}
                            </span>
                            <span className="mx-1 text-slate-400">→</span>
                            <span className={cn("text-slate-700", !inst.targetExists && "text-amber-600")}>
                              {inst.targetInstance}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* Region 4: SQL Script */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div className="w-[30%] min-w-[320px] flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-slate-800">
            <Terminal className="w-4 h-4 text-slate-600" />
            <h2 className="font-semibold text-sm">数据脚本</h2>
          </div>
          {sqlScript && (
            <Button
              size="sm"
              className="gap-1 h-7 text-xs bg-green-600 hover:bg-green-700"
              onClick={handleExecute}
              disabled={executing}
            >
              {executing ? (
                <><Loader2 className="w-3 h-3 animate-spin" /> 执行中</>
              ) : (
                <><Play className="w-3 h-3" /> 执行脚本</>
              )}
            </Button>
          )}
        </div>

        <div className="flex-1 bg-white rounded-lg border border-slate-200 flex flex-col overflow-hidden">
          {!sqlScript && (
            <div className="flex-1 flex items-center justify-center text-slate-400">
              <div className="text-center">
                <Terminal className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-xs">等待分析结果</p>
                <p className="text-[10px] mt-1">分析完成后将自动生成增量 SQL</p>
              </div>
            </div>
          )}

          {sqlScript && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-auto p-4">
                <pre className="text-xs font-mono text-slate-700 whitespace-pre-wrap">
                  {sqlScript}
                </pre>
              </div>

              {execResults && (
                <div className="border-t border-slate-200 p-3 bg-slate-50 max-h-48 overflow-auto">
                  <h4 className="text-xs font-medium text-slate-600 mb-2">执行结果</h4>
                  <div className="space-y-1.5">
                    {execResults.map((r, i) => (
                      <div key={i} className={cn(
                        "text-[10px] p-1.5 rounded border",
                        r.success
                          ? "bg-green-50 border-green-200 text-green-700"
                          : "bg-red-50 border-red-200 text-red-700"
                      )}>
                        <div className="flex items-center gap-1">
                          {r.success ? (
                            <CheckCircle2 className="w-3 h-3" />
                          ) : (
                            <AlertCircle className="w-3 h-3" />
                          )}
                          <span className="font-medium truncate">{r.statement}</span>
                        </div>
                        {r.success && r.affectedRows !== undefined && (
                          <span className="ml-4 text-green-600/80">影响 {r.affectedRows} 行</span>
                        )}
                        {r.error && (
                          <div className="ml-4 text-red-600 mt-0.5">{r.error}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
