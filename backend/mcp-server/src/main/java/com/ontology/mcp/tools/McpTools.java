package com.ontology.mcp.tools;

import com.ontology.mcp.service.OntologyQueryService;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

@Component
public class McpTools {

    @Autowired
    private OntologyQueryService queryService;

    @Tool(description = "查询本体概念图谱（Concept Graph），根据关键词搜索对象类型（Object Type）、属性（Property）和链接类型（Link Type）的定义信息。" +
            "关键词为空时返回所有概念，支持按名称、描述模糊搜索。返回的数据包括对象类型的属性列表、主键等详细信息。")
    public String queryConceptGraph(String keyword, String projectId) {
        return queryService.queryConceptGraph(keyword, projectId);
    }

    @Tool(description = "查询实例图谱（Instance Graph），搜索某个对象类型下的实例数据及其关联关系。" +
            "支持关键词搜索实例内容，并支持指定遍历深度（maxDepth）来探索关联的上下游实例。" +
            "返回包含实例节点（nodes）和关系边（edges）的图谱数据。")
    public String queryInstanceGraph(String objectTypeName, String keyword, String projectId, int maxDepth) {
        return queryService.queryInstanceGraph(objectTypeName, keyword, projectId, maxDepth);
    }
}
