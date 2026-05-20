import React, { useMemo, useCallback, useEffect, useState, useRef } from 'react';
import { OntologyData, ObjectType, LinkType } from '@/src/store/ontologyStore';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  NodeProps,
  Edge,
  Panel,
  Node,
  NodeResizer,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Database, Link as LinkIcon, Key, X, ArrowRight, ChevronRight, Sparkles, Filter } from 'lucide-react';
import { Badge } from '@/src/components/ui/badge';
import { Button } from '@/src/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/src/components/ui/sheet';
import { AiStudio } from './AiStudio';
import { cn } from '@/src/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/src/components/ui/select';
import { api } from '@/src/api/client';

// ── Layer definitions ─────────────────────────────────────────────────────────
type LayerId = 'company' | 'finance' | 'industry' | 'relation';

const LAYER_COLORS: Record<LayerId, string> = {
  company: '#3b82f6',  // 蓝色
  finance: '#f59e0b',  // 橙色
  industry: '#10b981', // 绿色
  relation: '#8b5cf6', // 紫色
};

const LAYER_LABELS: Record<LayerId, string> = {
  company: '公司层',
  finance: '经营财务指标层',
  industry: '产业链层',
  relation: '关系对象层',
};

// Layer order from top to bottom
const LAYER_ORDER: LayerId[] = ['company', 'finance', 'industry', 'relation'];

function classifyToLayer(ot: ObjectType): LayerId {
  if (ot.objectTypeCategory === 'relation') return 'relation';
  if (ot.id === 'company_entity') return 'company';
  if (['business_perspective', 'financial_perspective'].includes(ot.id)) return 'finance';
  return 'industry';
}

function getLayerColor(layer: LayerId): string {
  return LAYER_COLORS[layer];
}

// ── Layout Constants ──────────────────────────────────────────────────────────

const NODE_WIDTH = 240;
const NODE_HEIGHT_BASE = 90;
const NODE_HEIGHT_PER_PROP = 18;
const LAYER_Y_GAP = 280;    // vertical gap between layers
const INDUSTRY_X_GAP = 340; // horizontal gap in industry chain
const SAME_RANK_Y_GAP = 160; // vertical gap for same-rank nodes
const MARGIN_LEFT = 100;
const MARGIN_TOP = 80;

const GROUP_MIN_WIDTH = 280;
const GROUP_TITLE_HEIGHT = 32;
const GROUP_PADDING = 16;
const GROUP_CHILD_GAP = 16;

function getNodeHeight(ot: ObjectType): number {
  return NODE_HEIGHT_BASE + Math.min(ot.properties.length, 5) * NODE_HEIGHT_PER_PROP;
}

function calculateGroupSize(
  parentId: string,
  objectTypes: ObjectType[],
  visibleSet: Set<string>,
  nodeHeightMap: Map<string, number>
): { width: number; height: number } {
  const children = objectTypes.filter(ot => ot.parentObjectType === parentId && visibleSet.has(ot.id));
  let totalHeight = GROUP_TITLE_HEIGHT + GROUP_PADDING;
  let maxWidth = GROUP_MIN_WIDTH;

  children.forEach(child => {
    const isParent = objectTypes.some(ot => ot.parentObjectType === child.id && visibleSet.has(ot.id));
    if (isParent) {
      const childSize = calculateGroupSize(child.id, objectTypes, visibleSet, nodeHeightMap);
      totalHeight += childSize.height + GROUP_CHILD_GAP;
      maxWidth = Math.max(maxWidth, childSize.width + GROUP_PADDING * 2);
    } else {
      totalHeight += (nodeHeightMap.get(child.id) || NODE_HEIGHT_BASE) + GROUP_CHILD_GAP;
    }
  });

  totalHeight += GROUP_PADDING;
  return { width: maxWidth, height: totalHeight };
}

// ── Custom Nodes ──────────────────────────────────────────────────────────────

const GroupNode = ({ id, data, selected }: NodeProps) => {
  const color = data.color as string || '#3b82f6';
  const isOperationMode = data.isOperationMode as boolean ?? true;
  const onResizeEnd = data.onResizeEnd as ((nodeId: string, w: number, h: number) => void) | undefined;
  return (
    <div
      className="rounded-lg border-2"
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: color + '08',
        borderColor: color + '40',
      }}
    >
      <NodeResizer
        minWidth={GROUP_MIN_WIDTH}
        minHeight={120}
        isVisible={selected && isOperationMode}
        lineStyle={{ borderColor: color + '80' }}
        handleStyle={{ backgroundColor: color, borderColor: 'white' }}
        onResizeEnd={(_event, params) => {
          if (onResizeEnd) {
            onResizeEnd(id, params.width, params.height);
          }
        }}
      />
      <Handle type="target" position={Position.Top} id="top" className="w-2 h-2" style={{ background: color }} />
      <Handle type="target" position={Position.Left} id="left" className="w-2 h-2" style={{ background: color }} />
      <div
        className="px-3 py-1.5 text-xs font-bold rounded-t-lg truncate"
        style={{
          backgroundColor: color + '20',
          color: color,
          borderBottom: `1px solid ${color}30`,
        }}
      >
        {data.label as string}
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" className="w-2 h-2" style={{ background: color }} />
      <Handle type="source" position={Position.Right} id="right" className="w-2 h-2" style={{ background: color }} />
    </div>
  );
};

const ObjectTypeNode = ({ data }: NodeProps) => {
  const color = data.color as string || '#3b82f6';
  const properties = data.properties as any[] || [];
  const selected = data.selected as boolean;
  const status = data.status as string;
  const isPending = status === 'pending';

  return (
    <div
      className="shadow-lg rounded-xl min-w-[220px] max-w-[260px] transition-all relative"
      style={{
        borderWidth: 2,
        borderStyle: isPending ? 'dashed' : 'solid',
        borderColor: isPending ? '#9ca3af' : (selected ? color : '#e2e8f0'),
        boxShadow: selected ? `0 0 0 3px ${color}33` : undefined,
        backgroundColor: isPending ? '#f9fafb' : 'white',
      }}
    >
      {isPending && (
        <div className="absolute -top-2 -right-2 bg-amber-100 text-amber-700 text-[9px] px-1.5 py-0.5 rounded-full border border-amber-200 font-medium">
          待审核
        </div>
      )}
      <Handle type="target" position={Position.Top} id="top" className="w-2 h-2" style={{ background: color }} />
      <Handle type="target" position={Position.Left} id="left" className="w-2 h-2" style={{ background: color }} />

      {/* Header */}
      <div className="px-3 py-2.5 flex items-center gap-2 cursor-pointer" style={{ borderBottom: '1px solid #f1f5f9' }}>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: color + '15' }}>
          <Database className="w-4 h-4" style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm text-slate-900 truncate">{data.label as string}</div>
          <div className="text-[10px] text-slate-400 font-mono truncate">{data.id as string}</div>
        </div>
      </div>

      {/* Properties */}
      <div className="px-3 py-2">
        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
          属性 ({properties.length})
        </div>
        <div className="space-y-0.5">
          {properties.slice(0, 5).map((p: any) => (
            <div key={p.id} className="flex items-center gap-1.5 text-[11px] py-0.5">
              {!!p.isPrimaryKey && <Key className="w-2.5 h-2.5 text-amber-500 shrink-0" />}
              <span className="text-slate-700 truncate flex-1">{p.name}</span>
              <span className="text-slate-400 font-mono text-[9px] shrink-0 bg-slate-50 px-1 rounded">{p.type}</span>
            </div>
          ))}
          {properties.length > 5 && (
            <div className="text-[10px] text-slate-400 italic pt-0.5">+{properties.length - 5} 更多</div>
          )}
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} id="bottom" className="w-2 h-2" style={{ background: color }} />
      <Handle type="source" position={Position.Right} id="right" className="w-2 h-2" style={{ background: color }} />
    </div>
  );
};

const nodeTypes = { objectType: ObjectTypeNode, group: GroupNode };

// ── Topological Sort ──────────────────────────────────────────────────────────

function computeIndustryRanks(
  industryIds: string[],
  linkTypes: LinkType[]
): Map<string, number> {
  const industrySet = new Set(industryIds);
  const ranks = new Map<string, number>();

  const inDegree = new Map<string, number>();
  const outEdges = new Map<string, string[]>();

  industryIds.forEach(id => {
    inDegree.set(id, 0);
    outEdges.set(id, []);
  });

  linkTypes.forEach(lt => {
    if (!industrySet.has(lt.sourceObjectId) || !industrySet.has(lt.targetObjectId)) return;
    const cat = lt.linkCategory || '';
    if (cat !== '是...原材料' && cat !== '组成') return;
    // Reverse direction: raw material (target) -> finished product (source)
    outEdges.get(lt.targetObjectId)?.push(lt.sourceObjectId);
    inDegree.set(lt.sourceObjectId, (inDegree.get(lt.sourceObjectId) || 0) + 1);
  });

  const queue: string[] = [];
  industryIds.forEach(id => {
    if ((inDegree.get(id) || 0) === 0) queue.push(id);
  });

  let currentRank = 0;
  while (queue.length > 0) {
    const levelSize = queue.length;
    for (let i = 0; i < levelSize; i++) {
      const node = queue.shift()!;
      if (ranks.has(node)) continue;
      ranks.set(node, currentRank);
      (outEdges.get(node) || []).forEach(target => {
        const d = (inDegree.get(target) || 1) - 1;
        inDegree.set(target, d);
        if (d === 0) queue.push(target);
      });
    }
    currentRank++;
  }

  industryIds.forEach(id => {
    if (!ranks.has(id)) ranks.set(id, currentRank++);
  });

  return ranks;
}

// ── Layered Layout ────────────────────────────────────────────────────────────

interface SavedLayout {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

function layoutGraph(
  allObjectTypes: ObjectType[],
  visibleObjectTypes: ObjectType[],
  linkTypes: LinkType[],
  savedLayouts: Map<string, SavedLayout>,
  isOperationMode: boolean,
  onGroupResizeEnd?: (nodeId: string, width: number, height: number) => void
) {
  const visibleSet = new Set(visibleObjectTypes.map(ot => ot.id));
  const nodeHeightMap = new Map<string, number>();
  visibleObjectTypes.forEach(ot => nodeHeightMap.set(ot.id, getNodeHeight(ot)));

  const hasChildren = (id: string) =>
    allObjectTypes.some(ot => ot.parentObjectType === id && visibleSet.has(ot.id));

  const layerMap = new Map<string, LayerId>();
  visibleObjectTypes.forEach(ot => layerMap.set(ot.id, classifyToLayer(ot)));

  const rootObjectTypes = visibleObjectTypes.filter(ot => !ot.parentObjectType);

  const layerGroups = new Map<LayerId, ObjectType[]>();
  LAYER_ORDER.forEach(l => layerGroups.set(l, []));
  rootObjectTypes.forEach(ot => {
    const layer = layerMap.get(ot.id) || 'industry';
    layerGroups.get(layer)?.push(ot);
  });

  const positions = new Map<string, { x: number; y: number }>();
  let currentY = MARGIN_TOP;

  LAYER_ORDER.forEach(layerId => {
    const items = layerGroups.get(layerId) || [];
    if (items.length === 0) return;

    if (layerId === 'industry') {
      const industryIds = items.map(ot => ot.id);
      const ranks = computeIndustryRanks(industryIds, linkTypes);

      const rankGroups = new Map<number, ObjectType[]>();
      items.forEach(ot => {
        const r = ranks.get(ot.id) || 0;
        if (!rankGroups.has(r)) rankGroups.set(r, []);
        rankGroups.get(r)?.push(ot);
      });

      const maxRank = Math.max(...Array.from(rankGroups.keys()), 0);
      for (let r = 0; r <= maxRank; r++) {
        const group = rankGroups.get(r) || [];
        group.forEach((ot, idx) => {
          const x = MARGIN_LEFT + r * INDUSTRY_X_GAP;
          const y = currentY + idx * SAME_RANK_Y_GAP;
          positions.set(ot.id, { x, y });
        });
      }
      currentY += Math.max(items.length * SAME_RANK_Y_GAP, 300) + LAYER_Y_GAP;
    } else {
      items.forEach((ot, idx) => {
        const x = MARGIN_LEFT + idx * (NODE_WIDTH + 60);
        const y = currentY;
        positions.set(ot.id, { x, y });
      });
      currentY += LAYER_Y_GAP;
    }
  });

  // Calculate child positions inside groups
  const childPositions = new Map<string, { x: number; y: number }>();
  visibleObjectTypes.filter(ot => hasChildren(ot.id)).forEach(parent => {
    const children = visibleObjectTypes.filter(ot => ot.parentObjectType === parent.id);
    let cy = GROUP_TITLE_HEIGHT + GROUP_PADDING;
    children.forEach(child => {
      childPositions.set(child.id, { x: GROUP_PADDING, y: cy });
      if (hasChildren(child.id)) {
        const childSize = calculateGroupSize(child.id, allObjectTypes, visibleSet, nodeHeightMap);
        cy += childSize.height + GROUP_CHILD_GAP;
      } else {
        cy += (nodeHeightMap.get(child.id) || NODE_HEIGHT_BASE) + GROUP_CHILD_GAP;
      }
    });
  });

  // Build node array
  const nodes: any[] = [];

  // Group nodes
  visibleObjectTypes.filter(ot => hasChildren(ot.id)).forEach(ot => {
    const saved = savedLayouts.get(ot.id);
    const autoPos = ot.parentObjectType ? childPositions.get(ot.id) : positions.get(ot.id);
    const pos = saved || autoPos || { x: 0, y: 0 };
    const autoSize = calculateGroupSize(ot.id, allObjectTypes, visibleSet, nodeHeightMap);
    const layer = layerMap.get(ot.id) || 'industry';
    nodes.push({
      id: ot.id,
      type: 'group',
      position: pos,
      parentNode: ot.parentObjectType || undefined,
      style: {
        width: saved?.width ?? autoSize.width,
        height: saved?.height ?? autoSize.height,
        backgroundColor: getLayerColor(layer) + '08',
        borderColor: getLayerColor(layer) + '40',
      },
      data: {
        label: ot.name,
        color: getLayerColor(layer),
        isOperationMode: isOperationMode,
        onResizeEnd: onGroupResizeEnd,
      },
    });
  });

  // Normal nodes
  visibleObjectTypes.filter(ot => !hasChildren(ot.id)).forEach(ot => {
    const saved = savedLayouts.get(ot.id);
    const autoPos = ot.parentObjectType ? childPositions.get(ot.id) : positions.get(ot.id);
    const pos = saved || autoPos || { x: 0, y: 0 };
    const layer = layerMap.get(ot.id) || 'industry';
    nodes.push({
      id: ot.id,
      type: 'objectType',
      position: pos,
      parentNode: ot.parentObjectType || undefined,
      data: {
        label: ot.name,
        id: ot.id,
        properties: ot.properties,
        color: getLayerColor(layer),
        selected: false,
        status: ot.status,
      },
    });
  });

  return nodes;
}

// ── Side Panel ───────────────────────────────────────────────────────────────

function DetailPanel({
  objectType,
  relatedLinks,
  allObjects,
  onClose,
  onNavigate,
}: {
  objectType: ObjectType;
  relatedLinks: LinkType[];
  allObjects: ObjectType[];
  onClose: () => void;
  onNavigate: (id: string) => void;
}) {
  const inbound = relatedLinks.filter(lt => lt.targetObjectId === objectType.id);
  const outbound = relatedLinks.filter(lt => lt.sourceObjectId === objectType.id);
  const getName = (id: string) => allObjects.find(o => o.id === id)?.name || id;

  return (
    <div className="w-[360px] bg-white border-l border-slate-200 flex flex-col shrink-0 shadow-lg overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-slate-200 flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
          <Database className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="font-bold text-lg text-slate-900 truncate">{objectType.name}</h2>
          <p className="text-xs text-slate-400 font-mono truncate">{objectType.id}</p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Description */}
        {objectType.description && (
          <div className="px-4 py-3 border-b border-slate-100">
            <p className="text-sm text-slate-600">{objectType.description}</p>
          </div>
        )}

        {/* Properties */}
        <div className="px-4 py-3 border-b border-slate-100">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            属性 ({objectType.properties.length})
          </h3>
          <div className="space-y-1">
            {objectType.properties.map(p => (
              <div key={p.id} className="flex items-center gap-2 text-sm py-1.5 px-2 rounded-lg hover:bg-slate-50">
                {!!p.isPrimaryKey && <Key className="w-3 h-3 text-amber-500 shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-800 text-xs truncate">{p.name}</div>
                  {p.description && <div className="text-[10px] text-slate-400 truncate">{p.description}</div>}
                </div>
                <Badge variant="secondary" className="font-mono text-[9px] h-4 px-1.5 shrink-0">{p.type}</Badge>
              </div>
            ))}
          </div>
        </div>

        {/* Outbound Links */}
        {outbound.length > 0 && (
          <div className="px-4 py-3 border-b border-slate-100">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              出站链接 ({outbound.length})
            </h3>
            <div className="space-y-1.5">
              {outbound.map(lt => (
                <button key={lt.id} className="w-full text-left p-2 rounded-lg hover:bg-emerald-50 transition-colors flex items-center gap-2 group"
                  onClick={() => onNavigate(lt.targetObjectId)}>
                  <LinkIcon className="w-3 h-3 text-emerald-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-slate-700 flex items-center gap-1">
                      {lt.name}
                      <ArrowRight className="w-3 h-3 text-slate-400" />
                      <span className="text-blue-600">{getName(lt.targetObjectId)}</span>
                    </div>
                    <div className="text-[10px] text-slate-400">{lt.description}</div>
                  </div>
                  <Badge variant="outline" className="font-mono text-[9px] h-4 shrink-0">{lt.cardinality}</Badge>
                  <ChevronRight className="w-3 h-3 text-slate-300 group-hover:text-blue-500 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Inbound Links */}
        {inbound.length > 0 && (
          <div className="px-4 py-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              入站链接 ({inbound.length})
            </h3>
            <div className="space-y-1.5">
              {inbound.map(lt => (
                <button key={lt.id} className="w-full text-left p-2 rounded-lg hover:bg-blue-50 transition-colors flex items-center gap-2 group"
                  onClick={() => onNavigate(lt.sourceObjectId)}>
                  <LinkIcon className="w-3 h-3 text-blue-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-slate-700 flex items-center gap-1">
                      <span className="text-blue-600">{getName(lt.sourceObjectId)}</span>
                      <ArrowRight className="w-3 h-3 text-slate-400" />
                      {lt.name}
                    </div>
                    <div className="text-[10px] text-slate-400">{lt.description}</div>
                  </div>
                  <Badge variant="outline" className="font-mono text-[9px] h-4 shrink-0">{lt.cardinality}</Badge>
                  <ChevronRight className="w-3 h-3 text-slate-300 group-hover:text-blue-500 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Backing Dataset */}
        {objectType.backingDataset && (
          <div className="px-4 py-3 border-t border-slate-100">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Dataset</h3>
            <div className="flex items-center gap-2 p-2 bg-slate-50 rounded-lg">
              <Database className="w-3 h-3 text-slate-400" />
              <span className="font-mono text-[10px] text-slate-500 truncate">{objectType.backingDataset}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export function GraphView({ data, onUpdate }: { data: OntologyData; onUpdate?: (data: OntologyData) => void }) {
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [aiSheetOpen, setAiSheetOpen] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'entity'>('all');
  const [savedLayouts, setSavedLayouts] = useState<Map<string, SavedLayout>>(new Map());

  // Load saved layouts from backend
  useEffect(() => {
    api.getObjectTypeLayouts().then(res => {
      if (res.success && res.data) {
        const map = new Map<string, SavedLayout>();
        res.data.forEach(item => {
          map.set(item.objectTypeId, { x: item.x, y: item.y, width: item.width, height: item.height });
        });
        setSavedLayouts(map);
      }
    }).catch(console.error);
  }, []);

  // All object types are visible by default (no expand/collapse)
  const visibleObjectTypes = useMemo(() =>
    data.objectTypes.filter(ot => {
      if (categoryFilter === 'entity' && ot.objectTypeCategory === 'relation') return false;
      return true;
    }),
  [data.objectTypes, categoryFilter]);

  const [isOperationMode, setIsOperationMode] = useState(false);

  // Auto-save layouts (position + size) on drag/resize
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSavesRef = useRef<Map<string, SavedLayout>>(new Map());

  const flushSaves = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      const layouts = Array.from(pendingSavesRef.current.entries()).map(([objectTypeId, layout]) => ({
        objectTypeId,
        x: layout.x,
        y: layout.y,
        width: layout.width,
        height: layout.height,
      }));
      api.saveObjectTypeLayouts(layouts).catch(console.error);
      pendingSavesRef.current.clear();
    }, 500);
  }, []);

  // Group node resize end handler — writes to ref only (no state update = no flicker)
  const handleGroupResizeEnd = useCallback((nodeId: string, width: number, height: number) => {
    const existing = pendingSavesRef.current.get(nodeId) || {} as SavedLayout;
    pendingSavesRef.current.set(nodeId, { ...existing, width, height });
    flushSaves();
  }, [flushSaves]);

  const initialNodes = useMemo(() => {
    return layoutGraph(data.objectTypes, visibleObjectTypes, data.linkTypes, savedLayouts, isOperationMode, handleGroupResizeEnd);
  }, [data.objectTypes, visibleObjectTypes, data.linkTypes, savedLayouts, isOperationMode, handleGroupResizeEnd]);

  const initialEdges: Edge[] = useMemo(() => {
    const edges: Edge[] = [];

    const getLayer = (id: string): LayerId => {
      const ot = data.objectTypes.find(o => o.id === id);
      return ot ? classifyToLayer(ot) : 'industry';
    };

    const isHiddenByCategory = (id: string) => {
      if (categoryFilter !== 'entity') return false;
      const ot = data.objectTypes.find(o => o.id === id);
      return ot?.objectTypeCategory === 'relation';
    };

    data.linkTypes.forEach(lt => {
      if (isHiddenByCategory(lt.sourceObjectId) || isHiddenByCategory(lt.targetObjectId)) return;
      const src = lt.sourceObjectId;
      const tgt = lt.targetObjectId;
      if (src && tgt && src !== tgt) {
        const isPending = lt.status === 'pending';
        const cat = lt.linkCategory || '';
        const srcLayer = getLayer(lt.sourceObjectId);
        const tgtLayer = getLayer(lt.targetObjectId);

        let edgeColor: string;
        let sourceHandle: string | undefined;
        let targetHandle: string | undefined;

        if (cat === '是...原材料' || cat === '组成') {
          edgeColor = getLayerColor('industry');
          sourceHandle = 'right';
          targetHandle = 'left';
        } else if (cat === '组成项') {
          edgeColor = getLayerColor('relation');
          sourceHandle = 'bottom';
          targetHandle = 'top';
        } else if (cat === '描述') {
          edgeColor = getLayerColor('finance');
          sourceHandle = 'bottom';
          targetHandle = 'top';
        } else if (srcLayer !== tgtLayer) {
          edgeColor = '#94a3b8';
          sourceHandle = 'bottom';
          targetHandle = 'top';
        } else {
          edgeColor = getLayerColor(srcLayer);
        }

        if (isPending) edgeColor = '#9ca3af';

        edges.push({
          id: lt.id,
          source: src,
          target: tgt,
          sourceHandle,
          targetHandle,
          label: `${lt.name} (${lt.cardinality})${isPending ? ' [待审核]' : ''}`,
          animated: false,
          style: {
            stroke: edgeColor,
            strokeWidth: 2,
            opacity: 0.7,
            strokeDasharray: isPending ? '5,5' : undefined,
          },
          labelStyle: { fill: isPending ? '#9ca3af' : '#475569', fontWeight: 500, fontSize: 11 },
          labelBgStyle: { fill: '#ffffff', fillOpacity: 0.95 },
          labelBgPadding: [6, 3] as [number, number],
          labelBgBorderRadius: 4,
        });
      }
    });

    return edges;
  }, [data.linkTypes, data.objectTypes, categoryFilter]);

  const [nodes, setNodes, _onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // Highlight selected node
  useEffect(() => {
    setNodes(nds =>
      nds.map(n => ({
        ...n,
        data: { ...n.data, selected: n.id === selectedObjectId },
      }))
    );
    setEdges(eds =>
      eds.map(e => {
        const connected = selectedObjectId && (e.source === selectedObjectId || e.target === selectedObjectId);
        return {
          ...e,
          style: {
            ...e.style,
            strokeWidth: connected ? 3 : 2,
            opacity: selectedObjectId ? (connected ? 1 : 0.3) : 0.7,
          },
        };
      })
    );
  }, [selectedObjectId, setNodes, setEdges]);

  const onNodeClick = useCallback((_event: any, node: any) => {
    setSelectedObjectId(prev => prev === node.id ? null : node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedObjectId(null);
  }, []);

  const onNodeDragStop = useCallback((_event: any, node: Node) => {
    const update: SavedLayout = { x: node.position.x, y: node.position.y };
    // Immediately update local state so layoutGraph sees the latest values
    setSavedLayouts(prev => {
      const next = new Map(prev);
      const existing = next.get(node.id) || { x: 0, y: 0 };
      next.set(node.id, { ...existing, ...update });
      return next;
    });
    const existing = pendingSavesRef.current.get(node.id) || {} as SavedLayout;
    pendingSavesRef.current.set(node.id, { ...existing, ...update });
    flushSaves();
  }, [flushSaves]);

  const onNodesChange = useCallback((changes: any[]) => {
    _onNodesChange(changes);
  }, [_onNodesChange]);

  const selectedObject = data.objectTypes.find(o => o.id === selectedObjectId) || null;
  const relatedLinks = selectedObjectId
    ? data.linkTypes.filter(lt => lt.sourceObjectId === selectedObjectId || lt.targetObjectId === selectedObjectId)
    : [];

  return (
    <div className="h-full w-full flex flex-col -m-6">
      <div className="flex items-center justify-between px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">本体图谱</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            点击任意实体查看其详情和关系。通过链接导航探索图谱。
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <div className="flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <Select value={categoryFilter} onValueChange={(v: any) => setCategoryFilter(v)}>
              <SelectTrigger className="h-7 text-xs w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部对象类型</SelectItem>
                <SelectItem value="entity">仅实体对象类型</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <button
            onClick={() => setIsOperationMode(prev => !prev)}
            className={cn(
              "h-7 px-3 rounded-md text-xs font-medium transition-colors border",
              isOperationMode
                ? "bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100"
                : "bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100"
            )}
            title={isOperationMode ? '当前为编辑态，可拖动节点和调整区域框大小' : '当前为只读态，仅可缩放和移动画布'}
          >
            {isOperationMode ? '编辑态' : '只读态'}
          </button>
          <div className="flex items-center gap-1.5 text-slate-500">
            <Database className="w-3.5 h-3.5 text-blue-500" />
            <span>{visibleObjectTypes.length} 个实体</span>
            {visibleObjectTypes.length !== data.objectTypes.length && (
              <span className="text-xs text-slate-400">(共 {data.objectTypes.length})</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-slate-500">
            <LinkIcon className="w-3.5 h-3.5 text-emerald-500" />
            <span>{data.linkTypes.length} 个关系</span>
          </div>
          {/* Legend */}
          <div className="flex items-center gap-4 ml-4 pl-4 border-l border-slate-200">
            {LAYER_ORDER.map(layerId => {
              const items = visibleObjectTypes.filter(ot => classifyToLayer(ot) === layerId);
              if (items.length === 0) return null;
              return (
                <div key={layerId} className="flex items-center gap-1.5 text-xs text-slate-500">
                  <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: getLayerColor(layerId) }}></div>
                  <span>{LAYER_LABELS[layerId]}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Graph */}
        <div className="flex-1 bg-slate-50">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onNodeDragStop={onNodeDragStop}
            nodeTypes={nodeTypes}
            nodesDraggable={isOperationMode}
            fitView
            attributionPosition="bottom-right"
            minZoom={0.2}
            maxZoom={2}
          >
            {/* Controls in top-left */}
            <Panel position="top-left" className="!m-2">
              <Controls className="bg-white border-slate-200 shadow-sm !static" showInteractive={false} />
            </Panel>

            {/* MiniMap in bottom-left */}
            <Panel position="bottom-left" className="!m-2">
              <MiniMap
                nodeColor={node => {
                  const ot = data.objectTypes.find(o => o.id === node.id);
                  const layer = ot ? classifyToLayer(ot) : 'industry';
                  return getLayerColor(layer);
                }}
                maskColor="rgba(248, 250, 252, 0.7)"
                className="bg-white border border-slate-200 rounded-lg shadow-sm"
              />
            </Panel>

            {/* AI Floating Ball in bottom-right */}
            <Panel position="bottom-right" className="!m-4">
              <Sheet open={aiSheetOpen} onOpenChange={setAiSheetOpen}>
                <SheetTrigger asChild>
                  <button
                    className={cn(
                      "w-12 h-12 rounded-full bg-gradient-to-br from-purple-500 to-blue-600",
                      "flex items-center justify-center gap-1",
                      "text-white text-xs font-medium",
                      "shadow-lg hover:shadow-xl hover:scale-105",
                      "transition-all duration-300",
                      "group relative"
                    )}
                  >
                    <Sparkles className="w-5 h-5" />
                    <span className="text-[10px]">AI</span>
                    {/* Tooltip */}
                    <div className={cn(
                      "absolute right-full mr-3 top-1/2 -translate-y-1/2",
                      "bg-slate-800 text-white text-xs px-2 py-1 rounded whitespace-nowrap",
                      "opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                    )}>
                      AI本体建模
                    </div>
                  </button>
                </SheetTrigger>
                <SheetContent
                  side="right"
                  className="w-[600px] sm:max-w-[600px] p-0 bg-slate-50/95 backdrop-blur-sm"
                  style={{ '--sheet-overlay-opacity': '0.3' } as React.CSSProperties}
                >
                  <AiStudio data={data} onUpdate={onUpdate || (() => {})} embedded />
                </SheetContent>
              </Sheet>
            </Panel>

            <Background color="#cbd5e1" gap={20} />

            {/* Layer labels */}
            <Panel position="top-left" className="!ml-4 !mt-2" style={{ pointerEvents: 'none' }}>
              <div className="flex flex-col gap-0" style={{ marginTop: 30 }}>
                {(() => {
                  const layerPositions = new Map<LayerId, number>();
                  nodes.forEach(n => {
                    const ot = data.objectTypes.find(o => o.id === n.id);
                    if (!ot) return;
                    const layer = classifyToLayer(ot);
                    const existing = layerPositions.get(layer);
                    if (existing === undefined || n.position.y < existing) {
                      layerPositions.set(layer, n.position.y);
                    }
                  });
                  return LAYER_ORDER
                    .filter(lid => layerPositions.has(lid))
                    .map(lid => (
                      <div
                        key={lid}
                        className="text-xs font-semibold px-3 py-1.5 rounded-md mb-1 whitespace-nowrap"
                        style={{
                          color: getLayerColor(lid),
                          backgroundColor: getLayerColor(lid) + '15',
                          border: `1px solid ${getLayerColor(lid)}40`,
                          position: 'absolute',
                          top: (layerPositions.get(lid) || 0) - 30,
                          left: -20,
                        }}
                      >
                        {LAYER_LABELS[lid]}
                      </div>
                    ));
                })()}
              </div>
            </Panel>
          </ReactFlow>
        </div>

        {/* Detail Panel */}
        {selectedObject && (
          <DetailPanel
            objectType={selectedObject}
            relatedLinks={relatedLinks}
            allObjects={data.objectTypes}
            onClose={() => setSelectedObjectId(null)}
            onNavigate={id => setSelectedObjectId(id)}
          />
        )}
      </div>
    </div>
  );
}
