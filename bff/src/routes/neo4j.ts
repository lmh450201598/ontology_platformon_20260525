import { Router } from 'express';
import { pool } from '../db.js';
import { getSession } from '../neo4j.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Internal sync functions (reusable, no HTTP self-call)
// ─────────────────────────────────────────────────────────────────────────────

/** 1. 同步对象类型 -> Neo4j 节点 (Label: ObjectType)
 *  并同步父子继承关系 (-[:SUBTYPE_OF]->) */
async function syncObjectTypesInternal(): Promise<{ created: number; subtypes: number }> {
  const connection = await pool.getConnection();
  let objectTypes: any[] = [];
  try {
    const [rows]: any = await connection.execute(
      'SELECT id, name, description, backing_dataset, data_source, database_name, parent_object_type, icon, industry_id FROM object_types ORDER BY created_at'
    );
    objectTypes = rows;
  } finally {
    connection.release();
  }

  const session = getSession();
  let created = 0;
  let subtypes = 0;

  try {
    for (const ot of objectTypes) {
      // 拉取属性
      const propConn = await pool.getConnection();
      let properties: any[] = [];
      try {
        const [props]: any = await propConn.execute(
          'SELECT id, name, type, base_column, is_primary_key, sort_order FROM properties WHERE object_type_id = ? ORDER BY sort_order',
          [ot.id]
        );
        properties = props;
      } finally {
        propConn.release();
      }

      const propsData = (properties || []).map((p: any) => ({
        name: p.name,
        baseColumn: p.base_column,
        type: p.type,
        isPrimaryKey: !!p.is_primary_key,
      }));

      const cypher = `
        MERGE (ot:ObjectType {id: $id})
        SET ot.name = $name,
            ot.description = $description,
            ot.dataSource = $dataSource,
            ot.databaseName = $databaseName,
            ot.backingDataset = $backingDataset,
            ot.icon = $icon,
            ot.industryId = $industryId,
            ot.properties = $properties,
            ot.updatedAt = datetime()
        SET ot.createdAt = coalesce(ot.createdAt, datetime())
        RETURN ot
      `;

      await session.run(cypher, {
        id: ot.id,
        name: ot.name,
        description: ot.description || '',
        dataSource: ot.data_source || '',
        databaseName: ot.database_name || '',
        backingDataset: ot.backing_dataset || '',
        icon: ot.icon || '',
        industryId: ot.industry_id || '',
        properties: JSON.stringify(propsData),
      });
      created++;
    }

    // 父子继承关系：(child)-[:SUBTYPE_OF]->(parent)
    for (const ot of objectTypes) {
      if (ot.parent_object_type) {
        const cy = `
          MATCH (child:ObjectType {id: $childId})
          MATCH (parent:ObjectType {id: $parentId})
          MERGE (child)-[r:SUBTYPE_OF]->(parent)
          SET r.updatedAt = datetime()
          RETURN r
        `;
        await session.run(cy, {
          childId: ot.id,
          parentId: ot.parent_object_type,
        });
        subtypes++;
      }
    }
  } finally {
    await session.close();
  }

  return { created, subtypes };
}

/** 2. 同步链接类型 -> Neo4j 节点 (Label: LinkType) + ObjectType 间 LINKS_TO 关系 */
async function syncLinkTypesInternal(): Promise<{ created: number }> {
  const connection = await pool.getConnection();
  let linkTypes: any[] = [];
  try {
    const [rows]: any = await connection.execute(
      'SELECT id, name, description, source_object_id, target_object_id, source_column, target_column, cardinality, industry_id FROM link_types ORDER BY created_at'
    );
    linkTypes = rows;
  } finally {
    connection.release();
  }

  const session = getSession();
  let created = 0;

  try {
    for (const lt of linkTypes) {
      const cypher = `
        MERGE (linkType:LinkType {id: $id})
        SET linkType.name = $name,
            linkType.description = $description,
            linkType.sourceColumn = $sourceColumn,
            linkType.targetColumn = $targetColumn,
            linkType.cardinality = $cardinality,
            linkType.industryId = $industryId,
            linkType.updatedAt = datetime()
        SET linkType.createdAt = coalesce(linkType.createdAt, datetime())
        WITH linkType
        OPTIONAL MATCH (source:ObjectType {id: $sourceObjectId})
        OPTIONAL MATCH (target:ObjectType {id: $targetObjectId})
        FOREACH (_ IN CASE WHEN source IS NOT NULL AND target IS NOT NULL THEN [1] ELSE [] END |
          MERGE (source)-[r:LINKS_TO {linkTypeId: $id}]->(target)
          SET r.name = $name,
              r.cardinality = $cardinality,
              r.updatedAt = datetime()
        )
        RETURN linkType
      `;

      await session.run(cypher, {
        id: lt.id,
        name: lt.name,
        description: lt.description || '',
        sourceColumn: lt.source_column || '',
        targetColumn: lt.target_column || '',
        cardinality: lt.cardinality || 'N:M',
        industryId: lt.industry_id || '',
        sourceObjectId: lt.source_object_id,
        targetObjectId: lt.target_object_id,
      });
      created++;
    }
  } finally {
    await session.close();
  }

  return { created };
}

/** 3. 同步指定对象类型的实例 -> Neo4j Instance 节点
 *  使用 unique_id 作为节点主键，与 link_instance_data 表对齐 */
async function syncInstancesForObjectType(objectTypeId: string): Promise<{ created: number; tableName: string | null }> {
  const connection = await pool.getConnection();
  let objectType: any = null;
  let properties: any[] = [];

  try {
    const [otRows]: any = await connection.execute(
      'SELECT id, name, backing_dataset FROM object_types WHERE id = ?',
      [objectTypeId]
    );
    if (otRows.length === 0) {
      throw new Error(`ObjectType not found: ${objectTypeId}`);
    }
    objectType = otRows[0];
    const [propRows]: any = await connection.execute(
      'SELECT name, base_column, type, is_primary_key FROM properties WHERE object_type_id = ?',
      [objectTypeId]
    );
    properties = propRows;
  } finally {
    connection.release();
  }

  const tableName: string | null = objectType.backing_dataset || null;
  if (!tableName) {
    return { created: 0, tableName: null };
  }

  // 查询实例数据
  let instances: any[] = [];
  const dataConn = await pool.getConnection();
  try {
    const [rows]: any = await dataConn.execute(`SELECT * FROM \`${tableName}\` LIMIT 5000`);
    instances = rows;
  } catch (e: any) {
    // 表可能不存在
    return { created: 0, tableName };
  } finally {
    dataConn.release();
  }

  const session = getSession();
  let created = 0;

  try {
    for (const instance of instances) {
      // 优先使用 unique_id 作为节点ID，因为 link_instance_data 中 source_instance_id 引用的就是 unique_id
      const nodeId = instance.unique_id ? String(instance.unique_id) : String(instance.id);
      if (!nodeId) continue;

      // 构建 Neo4j 友好的属性对象（仅基本类型）
      const nodeProps: Record<string, any> = {
        id: nodeId,
        _objectTypeId: objectTypeId,
      };

      // 复制业务属性（按 properties 元数据映射 base_column -> name）
      for (const prop of properties) {
        const colName = prop.base_column;
        if (colName && instance[colName] !== undefined && instance[colName] !== null) {
          const val = instance[colName];
          // Neo4j 不接受 Date / Object，转字符串
          if (val instanceof Date) {
            nodeProps[prop.name] = val.toISOString();
          } else if (typeof val === 'object') {
            nodeProps[prop.name] = JSON.stringify(val);
          } else {
            nodeProps[prop.name] = val;
          }
        }
      }

      // 同时把通用字段 name / description 复制过来，方便查看
      if (instance.name && !nodeProps.name) nodeProps.name = instance.name;
      if (instance.description && !nodeProps.description) nodeProps.description = instance.description;

      const cypher = `
        MATCH (ot:ObjectType {id: $objectTypeId})
        MERGE (n:Instance {id: $nodeId})
        SET n += $props,
            n._objectTypeId = $objectTypeId,
            n.updatedAt = datetime()
        SET n.createdAt = coalesce(n.createdAt, datetime())
        MERGE (ot)-[:HAS_INSTANCE]->(n)
        RETURN n
      `;

      await session.run(cypher, {
        objectTypeId,
        nodeId,
        props: nodeProps,
      });
      created++;
    }
  } finally {
    await session.close();
  }

  return { created, tableName };
}

/** 4. 同步指定链接类型下的所有链接实例 -> Neo4j Instance 间 LINK 关系 */
async function syncLinkInstancesForLinkType(linkTypeId: string): Promise<{ created: number; missing: number }> {
  const connection = await pool.getConnection();
  let linkType: any = null;
  let linkInstances: any[] = [];

  try {
    const [ltRows]: any = await connection.execute(
      'SELECT id, name, source_object_id, target_object_id, source_column, target_column FROM link_types WHERE id = ?',
      [linkTypeId]
    );
    if (ltRows.length === 0) {
      throw new Error(`LinkType not found: ${linkTypeId}`);
    }
    linkType = ltRows[0];

    const [liRows]: any = await connection.execute(
      'SELECT source_instance_id, target_instance_id FROM link_instance_data WHERE link_type_id = ?',
      [linkTypeId]
    );
    linkInstances = liRows;
  } finally {
    connection.release();
  }

  const session = getSession();
  let created = 0;
  let missing = 0;

  try {
    for (const li of linkInstances) {
      const sourceId = String(li.source_instance_id);
      const targetId = String(li.target_instance_id);

      const cypher = `
        OPTIONAL MATCH (source:Instance {id: $sourceId})
        OPTIONAL MATCH (target:Instance {id: $targetId})
        FOREACH (_ IN CASE WHEN source IS NOT NULL AND target IS NOT NULL THEN [1] ELSE [] END |
          MERGE (source)-[r:LINK {linkTypeId: $linkTypeId}]->(target)
          SET r.linkTypeName = $linkTypeName,
              r.sourceColumn = $sourceColumn,
              r.targetColumn = $targetColumn,
              r.updatedAt = datetime()
        )
        RETURN source, target
      `;

      const result = await session.run(cypher, {
        sourceId,
        targetId,
        linkTypeId,
        linkTypeName: linkType.name,
        sourceColumn: linkType.source_column || '',
        targetColumn: linkType.target_column || '',
      });

      const rec = result.records[0];
      if (rec && rec.get('source') && rec.get('target')) {
        created++;
      } else {
        missing++;
      }
    }
  } finally {
    await session.close();
  }

  return { created, missing };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Routes
// ─────────────────────────────────────────────────────────────────────────────

router.post('/sync/object-types', async (_req, res) => {
  try {
    const stats = await syncObjectTypesInternal();
    res.json({
      success: true,
      message: `同步完成: ${stats.created} 个对象类型, ${stats.subtypes} 条父子继承关系`,
      stats,
    });
  } catch (error: any) {
    console.error('同步对象类型失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sync/link-types', async (_req, res) => {
  try {
    const stats = await syncLinkTypesInternal();
    res.json({
      success: true,
      message: `同步完成: ${stats.created} 个链接类型`,
      stats,
    });
  } catch (error: any) {
    console.error('同步链接类型失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sync/instances/:objectTypeId', async (req, res) => {
  const { objectTypeId } = req.params;
  try {
    const stats = await syncInstancesForObjectType(objectTypeId);
    res.json({
      success: true,
      message: `同步完成: ${stats.created} 个实例 (来源表: ${stats.tableName || 'N/A'})`,
      stats,
    });
  } catch (error: any) {
    console.error('同步实例数据失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sync/link-instances/:linkTypeId', async (req, res) => {
  const { linkTypeId } = req.params;
  try {
    const stats = await syncLinkInstancesForLinkType(linkTypeId);
    res.json({
      success: true,
      message: `同步完成: ${stats.created} 条链接关系 (跳过 ${stats.missing} 条因实例缺失)`,
      stats,
    });
  } catch (error: any) {
    console.error('同步链接实例失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/** 全量同步：直接函数调用，不再走 HTTP 自调用 */
router.post('/sync/all', async (req, res) => {
  const { clearFirst } = req.body || {};

  try {
    const summary: any = {
      cleared: false,
      objectTypes: { created: 0, subtypes: 0 },
      linkTypes: { created: 0 },
      instances: { totalCreated: 0, byObjectType: [] as any[] },
      linkInstances: { totalCreated: 0, totalMissing: 0, byLinkType: [] as any[] },
    };

    // 0. 可选：先清空 Neo4j
    if (clearFirst) {
      const session = getSession();
      try {
        await session.run('MATCH (n) DETACH DELETE n');
        summary.cleared = true;
      } finally {
        await session.close();
      }
    }

    // 1. 对象类型
    summary.objectTypes = await syncObjectTypesInternal();

    // 2. 链接类型 (依赖 ObjectType 节点已存在)
    summary.linkTypes = await syncLinkTypesInternal();

    // 3. 所有对象类型的实例 (依赖 ObjectType 节点已存在)
    const conn1 = await pool.getConnection();
    let objectTypeIds: string[] = [];
    try {
      const [rows]: any = await conn1.execute('SELECT id FROM object_types');
      objectTypeIds = rows.map((r: any) => r.id);
    } finally {
      conn1.release();
    }

    for (const otId of objectTypeIds) {
      try {
        const r = await syncInstancesForObjectType(otId);
        summary.instances.totalCreated += r.created;
        if (r.created > 0) {
          summary.instances.byObjectType.push({ objectTypeId: otId, count: r.created, table: r.tableName });
        }
      } catch (e: any) {
        console.error(`[Neo4j Sync] instances failed for ${otId}:`, e.message);
      }
    }

    // 4. 所有链接实例 (依赖 Instance 节点已存在)
    const conn2 = await pool.getConnection();
    let linkTypeIds: string[] = [];
    try {
      const [rows]: any = await conn2.execute('SELECT id FROM link_types');
      linkTypeIds = rows.map((r: any) => r.id);
    } finally {
      conn2.release();
    }

    for (const ltId of linkTypeIds) {
      try {
        const r = await syncLinkInstancesForLinkType(ltId);
        summary.linkInstances.totalCreated += r.created;
        summary.linkInstances.totalMissing += r.missing;
        if (r.created > 0 || r.missing > 0) {
          summary.linkInstances.byLinkType.push({ linkTypeId: ltId, created: r.created, missing: r.missing });
        }
      } catch (e: any) {
        console.error(`[Neo4j Sync] link-instances failed for ${ltId}:`, e.message);
      }
    }

    res.json({
      success: true,
      message: '全量同步完成',
      summary,
    });
  } catch (error: any) {
    console.error('全量同步失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/** 概览：查询 Neo4j 中节点和关系数量 */
router.get('/overview', async (_req, res) => {
  const session = getSession();
  try {
    const nodeCount = await session.run('MATCH (n) RETURN count(n) as count');
    const instanceCount = await session.run('MATCH (n:Instance) RETURN count(n) as count');
    const objectTypeCount = await session.run('MATCH (n:ObjectType) RETURN count(n) as count');
    const linkTypeCount = await session.run('MATCH (n:LinkType) RETURN count(n) as count');

    const relCount = await session.run('MATCH ()-[r]->() RETURN count(r) as count');
    const linkRelCount = await session.run('MATCH ()-[r:LINK]->() RETURN count(r) as count');
    const linksToCount = await session.run('MATCH ()-[r:LINKS_TO]->() RETURN count(r) as count');
    const subtypeCount = await session.run('MATCH ()-[r:SUBTYPE_OF]->() RETURN count(r) as count');
    const hasInstanceCount = await session.run('MATCH ()-[r:HAS_INSTANCE]->() RETURN count(r) as count');

    res.json({
      success: true,
      data: {
        nodes: {
          total: nodeCount.records[0].get('count').toNumber(),
          objectTypes: objectTypeCount.records[0].get('count').toNumber(),
          linkTypes: linkTypeCount.records[0].get('count').toNumber(),
          instances: instanceCount.records[0].get('count').toNumber(),
        },
        relationships: {
          total: relCount.records[0].get('count').toNumber(),
          link: linkRelCount.records[0].get('count').toNumber(),
          linksTo: linksToCount.records[0].get('count').toNumber(),
          subtypeOf: subtypeCount.records[0].get('count').toNumber(),
          hasInstance: hasInstanceCount.records[0].get('count').toNumber(),
        },
      },
    });
  } catch (error: any) {
    console.error('查询概览失败:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    await session.close();
  }
});

/** 清空 Neo4j 数据 */
router.delete('/clear', async (_req, res) => {
  const session = getSession();
  try {
    await session.run('MATCH (n) DETACH DELETE n');
    res.json({ success: true, message: 'Neo4j 数据已清空' });
  } catch (error: any) {
    console.error('清空数据失败:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    await session.close();
  }
});

export default router;
