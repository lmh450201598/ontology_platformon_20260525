import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { toast } from 'sonner';
import { api } from '@/src/api/client';
import { Database, RefreshCw, Loader2, Trash2 } from 'lucide-react';

export function Settings() {
  const [isSaving, setIsSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [clearFirst, setClearFirst] = useState(false);
  const [overview, setOverview] = useState<any>(null);
  const [syncSummary, setSyncSummary] = useState<any>(null);

  const handleSave = () => {
    setIsSaving(true);
    setTimeout(() => {
      setIsSaving(false);
      toast.success('设置保存成功。');
    }, 1000);
  };

  const loadOverview = async () => {
    try {
      const res = await api.neo4jOverview();
      if (res.success) setOverview(res.data);
    } catch (e: any) {
      // 静默失败，Neo4j 可能未连接
      console.warn('Neo4j overview failed:', e.message);
    }
  };

  useEffect(() => {
    loadOverview();
  }, []);

  const handleSyncAll = async () => {
    setSyncing(true);
    setSyncSummary(null);
    try {
      const res = await api.syncNeo4jAll(clearFirst);
      if (res.success) {
        setSyncSummary(res.summary);
        toast.success(res.message || 'Neo4j 同步完成');
        loadOverview();
      } else {
        toast.error('同步失败');
      }
    } catch (e: any) {
      toast.error('同步失败: ' + (e.message || '未知错误'));
    } finally {
      setSyncing(false);
    }
  };

  const handleClear = async () => {
    if (!confirm('确认清空 Neo4j 中的所有节点和关系吗？此操作不可恢复。')) return;
    try {
      const res = await api.clearNeo4j();
      if (res.success) {
        toast.success(res.message || 'Neo4j 已清空');
        setSyncSummary(null);
        loadOverview();
      }
    } catch (e: any) {
      toast.error('清空失败: ' + (e.message || '未知错误'));
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">设置</h1>
        <p className="text-slate-500 text-sm mt-1">管理您的本体环境和权限。</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>环境设置</CardTitle>
          <CardDescription>配置当前本体环境。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">环境名称</label>
            <Input defaultValue="Production" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">描述</label>
            <Input defaultValue="Main production environment for enterprise data." />
          </div>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? '保存中...' : '保存变更'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="w-5 h-5 text-emerald-600" />
            Neo4j 图谱同步
          </CardTitle>
          <CardDescription>将 MySQL 中的对象类型、实例、链接类型及链接实例同步到 Neo4j。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 当前 Neo4j 概览 */}
          {overview && (
            <div className="grid grid-cols-2 gap-4 p-4 bg-slate-50 rounded-md border border-slate-200">
              <div>
                <div className="text-xs font-medium text-slate-500 mb-2">节点</div>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-slate-600">ObjectType</span><span className="font-mono font-medium">{overview.nodes?.objectTypes ?? 0}</span></div>
                  <div className="flex justify-between"><span className="text-slate-600">LinkType</span><span className="font-mono font-medium">{overview.nodes?.linkTypes ?? 0}</span></div>
                  <div className="flex justify-between"><span className="text-slate-600">Instance</span><span className="font-mono font-medium">{overview.nodes?.instances ?? 0}</span></div>
                  <div className="flex justify-between border-t pt-1 mt-1"><span className="text-slate-700 font-medium">总计</span><span className="font-mono font-bold">{overview.nodes?.total ?? 0}</span></div>
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500 mb-2">关系</div>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-slate-600">LINK</span><span className="font-mono font-medium">{overview.relationships?.link ?? 0}</span></div>
                  <div className="flex justify-between"><span className="text-slate-600">LINKS_TO</span><span className="font-mono font-medium">{overview.relationships?.linksTo ?? 0}</span></div>
                  <div className="flex justify-between"><span className="text-slate-600">SUBTYPE_OF</span><span className="font-mono font-medium">{overview.relationships?.subtypeOf ?? 0}</span></div>
                  <div className="flex justify-between"><span className="text-slate-600">HAS_INSTANCE</span><span className="font-mono font-medium">{overview.relationships?.hasInstance ?? 0}</span></div>
                  <div className="flex justify-between border-t pt-1 mt-1"><span className="text-slate-700 font-medium">总计</span><span className="font-mono font-bold">{overview.relationships?.total ?? 0}</span></div>
                </div>
              </div>
            </div>
          )}

          {/* 同步控制 */}
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={clearFirst}
                onChange={e => setClearFirst(e.target.checked)}
                className="rounded border-slate-300"
              />
              同步前先清空 Neo4j
            </label>
            <Button onClick={handleSyncAll} disabled={syncing} className="gap-2 bg-emerald-600 hover:bg-emerald-700">
              {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {syncing ? '同步中...' : '一键全量同步'}
            </Button>
            <Button variant="outline" onClick={loadOverview} disabled={syncing} className="gap-2">
              <RefreshCw className="w-4 h-4" />
              刷新概览
            </Button>
            <Button variant="outline" onClick={handleClear} disabled={syncing} className="gap-2 text-red-600 hover:text-red-700 hover:bg-red-50">
              <Trash2 className="w-4 h-4" />
              清空 Neo4j
            </Button>
          </div>

          {/* 同步结果详情 */}
          {syncSummary && (
            <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-md text-sm space-y-2">
              <div className="font-medium text-emerald-800">同步结果</div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-700">
                {syncSummary.cleared && <div className="col-span-2 text-amber-700">✓ 同步前已清空 Neo4j</div>}
                <div>对象类型：<span className="font-mono">{syncSummary.objectTypes?.created ?? 0}</span> 个</div>
                <div>父子继承：<span className="font-mono">{syncSummary.objectTypes?.subtypes ?? 0}</span> 条</div>
                <div>链接类型：<span className="font-mono">{syncSummary.linkTypes?.created ?? 0}</span> 个</div>
                <div>实例节点：<span className="font-mono">{syncSummary.instances?.totalCreated ?? 0}</span> 个</div>
                <div className="col-span-2">链接实例：<span className="font-mono text-emerald-700">{syncSummary.linkInstances?.totalCreated ?? 0}</span> 成功 / <span className="font-mono text-amber-600">{syncSummary.linkInstances?.totalMissing ?? 0}</span> 跳过（实例缺失）</div>
              </div>
            </div>
          )}

          <p className="text-xs text-slate-500 leading-relaxed">
            同步顺序：
            <span className="font-medium">对象类型</span> →
            <span className="font-medium">父子继承关系</span> →
            <span className="font-medium">链接类型</span> →
            <span className="font-medium">对象实例</span> →
            <span className="font-medium">链接实例</span>。
            节点使用 <code className="bg-slate-100 px-1 py-0.5 rounded">unique_id</code> 作为主键，与 <code className="bg-slate-100 px-1 py-0.5 rounded">link_instance_data</code> 表对齐。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>访问控制</CardTitle>
          <CardDescription>管理谁可以查看和编辑本体。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-slate-200 divide-y divide-slate-200">
            <div className="flex items-center justify-between p-4 bg-slate-50">
              <div>
                <p className="text-sm font-medium text-slate-900">本体管理员</p>
                <p className="text-xs text-slate-500">拥有创建、编辑和删除对象类型的完整权限。</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => toast.info('打开管理管理员对话框。')}>管理</Button>
            </div>
            <div className="flex items-center justify-between p-4 bg-slate-50">
              <div>
                <p className="text-sm font-medium text-slate-900">数据工程师</p>
                <p className="text-xs text-slate-500">可以将后台数据集映射到对象类型。</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => toast.info('打开管理数据工程师对话框。')}>管理</Button>
            </div>
            <div className="flex items-center justify-between p-4 bg-slate-50">
              <div>
                <p className="text-sm font-medium text-slate-900">查看者</p>
                <p className="text-xs text-slate-500">对本体图谱和定义具有只读访问权限。</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => toast.info('打开管理查看者对话框。')}>管理</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
