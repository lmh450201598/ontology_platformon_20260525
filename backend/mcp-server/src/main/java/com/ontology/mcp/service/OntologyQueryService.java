package com.ontology.mcp.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import org.neo4j.driver.Driver;
import org.neo4j.driver.Session;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.stream.Collectors;

@Service
public class OntologyQueryService {

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private Driver neo4jDriver;

    /**
     * Query concept (ontology) graph - search object types, properties, link types
     */
    public String queryConceptGraph(String keyword, String projectId) {
        if (projectId == null || projectId.isBlank()) {
            projectId = "project_public";
        }

        JSONObject result = new JSONObject();
        try {
            // 1. Query object types
            String otSql = "SELECT id, name, description, icon, backing_dataset, parent_object_type, object_type_category " +
                    "FROM object_types WHERE project_id = ? AND status = 'active'";
            List<Map<String, Object>> otRows;
            if (keyword != null && !keyword.isBlank()) {
                otSql += " AND (name LIKE ? OR description LIKE ?)";
                String like = "%" + keyword + "%";
                otRows = jdbc.queryForList(otSql, projectId, like, like);
            } else {
                otRows = jdbc.queryForList(otSql, projectId);
            }

            JSONArray objectTypes = new JSONArray();
            for (Map<String, Object> row : otRows) {
                JSONObject ot = new JSONObject();
                ot.put("id", row.get("id"));
                ot.put("name", row.get("name"));
                ot.put("description", row.get("description"));
                ot.put("icon", row.get("icon"));
                ot.put("backingDataset", row.get("backing_dataset"));
                ot.put("parentObjectType", row.get("parent_object_type"));
                ot.put("objectTypeCategory", row.get("object_type_category"));

                // Get properties for this object type
                String propSql = "SELECT id, name, type, is_primary_key, base_column, description " +
                        "FROM properties WHERE object_type_id = ? AND (project_id = ? OR project_id IS NULL)";
                List<Map<String, Object>> propRows = jdbc.queryForList(propSql, row.get("id"), projectId);
                JSONArray properties = new JSONArray();
                for (Map<String, Object> prop : propRows) {
                    JSONObject p = new JSONObject();
                    p.put("id", prop.get("id"));
                    p.put("name", prop.get("name"));
                    p.put("type", prop.get("type"));
                    p.put("isPrimaryKey", prop.get("is_primary_key"));
                    p.put("baseColumn", prop.get("base_column"));
                    p.put("description", prop.get("description"));
                    properties.add(p);
                }
                ot.put("properties", properties);
                objectTypes.add(ot);
            }
            result.put("objectTypes", objectTypes);

            // 2. Query link types
            String ltSql = "SELECT lt.id, lt.name, lt.source_object_id, lt.target_object_id, " +
                    "lt.source_column, lt.target_column, lt.cardinality, lt.description, " +
                    "sot.name as source_name, tot.name as target_name " +
                    "FROM link_types lt " +
                    "LEFT JOIN object_types sot ON lt.source_object_id = sot.id " +
                    "LEFT JOIN object_types tot ON lt.target_object_id = tot.id " +
                    "WHERE lt.project_id = ?";
            List<Map<String, Object>> ltRows;
            if (keyword != null && !keyword.isBlank()) {
                ltSql += " AND (lt.name LIKE ? OR lt.description LIKE ? OR sot.name LIKE ? OR tot.name LIKE ?)";
                String like = "%" + keyword + "%";
                ltRows = jdbc.queryForList(ltSql, projectId, like, like, like, like);
            } else {
                ltRows = jdbc.queryForList(ltSql, projectId);
            }

            JSONArray linkTypes = new JSONArray();
            for (Map<String, Object> row : ltRows) {
                JSONObject lt = new JSONObject();
                lt.put("id", row.get("id"));
                lt.put("name", row.get("name"));
                lt.put("sourceObjectId", row.get("source_object_id"));
                lt.put("sourceObjectName", row.get("source_name"));
                lt.put("targetObjectId", row.get("target_object_id"));
                lt.put("targetObjectName", row.get("target_name"));
                lt.put("sourceColumn", row.get("source_column"));
                lt.put("targetColumn", row.get("target_column"));
                lt.put("cardinality", row.get("cardinality"));
                lt.put("description", row.get("description"));
                linkTypes.add(lt);
            }
            result.put("linkTypes", linkTypes);

            // 3. Try to query Neo4j for graph overview
            try (Session session = neo4jDriver.session()) {
                var neoResult = session.run(
                        "MATCH (n) WHERE n.projectId = $projectId RETURN labels(n) as labels, count(n) as cnt LIMIT 20",
                        org.neo4j.driver.Values.parameters("projectId", projectId)
                );
                JSONObject neoSummary = new JSONObject();
                while (neoResult.hasNext()) {
                    var record = neoResult.next();
                    neoSummary.put(record.get("labels").toString(), record.get("cnt").asInt());
                }
                result.put("neo4jSummary", neoSummary);
            } catch (Exception e) {
                result.put("neo4jStatus", "unavailable: " + e.getMessage());
            }

            result.put("success", true);
        } catch (Exception e) {
            result.put("success", false);
            result.put("error", e.getMessage());
        }

        return result.toJSONString();
    }

    /**
     * Query instance graph data - search instances and their relationships
     */
    public String queryInstanceGraph(String objectTypeName, String keyword, String projectId, int maxDepth) {
        if (projectId == null || projectId.isBlank()) {
            projectId = "project_public";
        }
        if (maxDepth <= 0) maxDepth = 2;
        if (maxDepth > 5) maxDepth = 5;

        JSONObject result = new JSONObject();
        try {
            // 1. Find the object type
            String otSql = "SELECT id, name, backing_dataset FROM object_types " +
                    "WHERE project_id = ? AND status = 'active'";
            if (objectTypeName != null && !objectTypeName.isBlank()) {
                otSql += " AND (name = ? OR id = ?)";
            }
            List<Map<String, Object>> otRows;
            if (objectTypeName != null && !objectTypeName.isBlank()) {
                otRows = jdbc.queryForList(otSql, projectId, objectTypeName, objectTypeName);
            } else {
                otRows = jdbc.queryForList(otSql, projectId);
            }

            if (otRows.isEmpty()) {
                result.put("success", false);
                result.put("error", "Object type not found: " + objectTypeName);
                return result.toJSONString();
            }

            JSONArray allNodes = new JSONArray();
            JSONArray allEdges = new JSONArray();
            Set<String> visitedNodes = new HashSet<>();

            for (Map<String, Object> ot : otRows) {
                String otId = (String) ot.get("id");
                String otName = (String) ot.get("name");
                String backingTable = (String) ot.get("backing_dataset");
                if (backingTable == null || backingTable.isBlank()) continue;

                // Get properties
                String propSql = "SELECT id, name, base_column, is_primary_key FROM properties " +
                        "WHERE object_type_id = ? AND (project_id = ? OR project_id IS NULL)";
                List<Map<String, Object>> propRows = jdbc.queryForList(propSql, otId, projectId);

                Optional<Map<String, Object>> pkProp = propRows.stream()
                        .filter(p -> "1".equals(String.valueOf(p.get("is_primary_key"))) || "true".equals(String.valueOf(p.get("is_primary_key"))))
                        .findFirst();

                // Query instances
                String instSql = "SELECT * FROM `" + backingTable + "`";
                List<Map<String, Object>> instRows;
                if (keyword != null && !keyword.isBlank()) {
                    // Search for keyword in string columns
                    String escapedKeyword = keyword.replace("'", "''");
                    List<String> textCols = new ArrayList<>();
                    if (pkProp.isPresent()) {
                        textCols.add((String) pkProp.get().get("base_column"));
                    }
                    for (Map<String, Object> p : propRows) {
                        String col = (String) p.get("base_column");
                        if (col != null && !col.isBlank()) {
                            textCols.add(col);
                        }
                    }
                    if (!textCols.isEmpty()) {
                        String whereClause = textCols.stream()
                                .map(c -> "`" + c + "` LIKE '%" + escapedKeyword + "%'")
                                .collect(Collectors.joining(" OR "));
                        instSql += " WHERE " + whereClause;
                    }
                    instSql += " LIMIT 20";
                    instRows = jdbc.queryForList(instSql);
                } else {
                    instSql += " LIMIT 20";
                    instRows = jdbc.queryForList(instSql);
                }

                for (Map<String, Object> instance : instRows) {
                    String instanceId = pkProp.isPresent()
                            ? String.valueOf(instance.get(pkProp.get().get("base_column")))
                            : String.valueOf(instance.values().iterator().next());
                    String nodeKey = otId + ":" + instanceId;

                    JSONObject node = new JSONObject();
                    node.put("id", nodeKey);
                    node.put("objectTypeId", otId);
                    node.put("objectTypeName", otName);
                    node.put("instanceId", instanceId);
                    JSONObject data = new JSONObject();
                    for (Map<String, Object> p : propRows) {
                        String col = (String) p.get("base_column");
                        if (col != null && instance.containsKey(col)) {
                            data.put((String) p.get("name"), instance.get(col));
                        }
                    }
                    node.put("data", data);
                    allNodes.add(node);
                    visitedNodes.add(nodeKey);

                    // If keyword is provided and maxDepth > 0, also fetch relations
                    if (keyword != null && !keyword.isBlank() && maxDepth > 0) {
                        fetchRelations(otId, instanceId, visitedNodes, allNodes, allEdges, projectId, 1, maxDepth);
                    }
                }

                // If no keyword, fetch relations for all instances up to maxDepth
                if ((keyword == null || keyword.isBlank()) && maxDepth > 0) {
                    for (Map<String, Object> instance : instRows) {
                        String instanceId = pkProp.isPresent()
                                ? String.valueOf(instance.get(pkProp.get().get("base_column")))
                                : String.valueOf(instance.values().iterator().next());
                        fetchRelations(otId, instanceId, visitedNodes, allNodes, allEdges, projectId, 1, maxDepth);
                    }
                }
            }

            result.put("nodes", allNodes);
            result.put("edges", allEdges);
            result.put("success", true);

        } catch (Exception e) {
            result.put("success", false);
            result.put("error", e.getMessage());
        }

        return result.toJSONString();
    }

    private void fetchRelations(String otId, String instanceId, Set<String> visitedNodes,
                                 JSONArray allNodes, JSONArray allEdges,
                                 String projectId, int currentDepth, int maxDepth) {
        if (currentDepth > maxDepth) return;

        try {
            // Find link types involving this object type
            String ltSql = "SELECT lt.id, lt.name, lt.source_object_id, lt.target_object_id, " +
                    "lt.source_column, lt.target_column, " +
                    "sot.name as source_name, tot.name as target_name, " +
                    "sot.backing_dataset as source_table, tot.backing_dataset as target_table " +
                    "FROM link_types lt " +
                    "JOIN object_types sot ON lt.source_object_id = sot.id AND sot.project_id = lt.project_id " +
                    "JOIN object_types tot ON lt.target_object_id = tot.id AND tot.project_id = lt.project_id " +
                    "WHERE (lt.source_object_id = ? OR lt.target_object_id = ?) AND lt.project_id = ?";
            List<Map<String, Object>> linkTypes = jdbc.queryForList(ltSql, otId, otId, projectId);

            for (Map<String, Object> lt : linkTypes) {
                String ltId = (String) lt.get("id");
                String srcOtId = (String) lt.get("source_object_id");
                String tgtOtId = (String) lt.get("target_object_id");
                boolean isSource = srcOtId.equals(otId);
                String relatedOtId = isSource ? tgtOtId : srcOtId;
                boolean isSameType = srcOtId.equals(tgtOtId);

                // Query link_instance_data
                String lidSql;
                if (isSameType) {
                    lidSql = "SELECT * FROM link_instance_data WHERE link_type_id = ? " +
                            "AND (source_instance_id = ? OR target_instance_id = ?) LIMIT 20";
                } else {
                    lidSql = "SELECT * FROM link_instance_data WHERE link_type_id = ? AND " +
                            (isSource ? "source_instance_id" : "target_instance_id") + " = ? LIMIT 20";
                }

                List<Map<String, Object>> linkInstances;
                if (isSameType) {
                    linkInstances = jdbc.queryForList(lidSql, ltId, instanceId, instanceId);
                } else {
                    linkInstances = jdbc.queryForList(lidSql, ltId, instanceId);
                }

                for (Map<String, Object> li : linkInstances) {
                    String srcInstId = String.valueOf(li.get("source_instance_id"));
                    String tgtInstId = String.valueOf(li.get("target_instance_id"));
                    String relatedInstId = isSameType
                            ? (srcInstId.equals(instanceId) ? tgtInstId : srcInstId)
                            : (isSource ? tgtInstId : srcInstId);

                    String sourceKey = srcOtId + ":" + srcInstId;
                    String targetKey = tgtOtId + ":" + tgtInstId;
                    String edgeKey = sourceKey + "->" + targetKey + ":" + ltId;

                    // Add edge
                    JSONObject edge = new JSONObject();
                    edge.put("id", edgeKey);
                    edge.put("source", sourceKey);
                    edge.put("target", targetKey);
                    edge.put("linkTypeId", ltId);
                    edge.put("linkTypeName", lt.get("name"));
                    edge.put("direction", isSource ? "downstream" : "upstream");
                    allEdges.add(edge);

                    // Add related node if not visited
                    String relatedKey = relatedOtId + ":" + relatedInstId;
                    if (!visitedNodes.contains(relatedKey)) {
                        visitedNodes.add(relatedKey);

                        // Get related object type info and instance data
                        try {
                            String relOtSql = "SELECT id, name, backing_dataset FROM object_types WHERE id = ?";
                            List<Map<String, Object>> relOt = jdbc.queryForList(relOtSql, relatedOtId);
                            if (!relOt.isEmpty()) {
                                String relTable = (String) relOt.get(0).get("backing_dataset");
                                String relOtName = (String) relOt.get(0).get("name");

                                // Get PK property for related type
                                String relPropSql = "SELECT id, name, base_column FROM properties " +
                                        "WHERE object_type_id = ? AND is_primary_key = 1";
                                List<Map<String, Object>> relPk = jdbc.queryForList(relPropSql, relatedOtId);

                                JSONObject relNode = new JSONObject();
                                relNode.put("id", relatedKey);
                                relNode.put("objectTypeId", relatedOtId);
                                relNode.put("objectTypeName", relOtName);
                                relNode.put("instanceId", relatedInstId);

                                // Get instance data
                                if (relTable != null && !relTable.isBlank()) {
                                    String relDataSql = "SELECT * FROM `" + relTable + "`";
                                    if (!relPk.isEmpty()) {
                                        String pkCol = (String) relPk.get(0).get("base_column");
                                        relDataSql += " WHERE `" + pkCol + "` = ? LIMIT 1";
                                    }
                                    try {
                                        List<Map<String, Object>> relData;
                                        if (!relPk.isEmpty()) {
                                            String pkCol = (String) relPk.get(0).get("base_column");
                                            relData = jdbc.queryForList(relDataSql, relatedInstId);
                                        } else {
                                            relData = jdbc.queryForList(relDataSql);
                                        }
                                        if (!relData.isEmpty()) {
                                            JSONObject data = new JSONObject();
                                            for (Map.Entry<String, Object> entry : relData.get(0).entrySet()) {
                                                data.put(entry.getKey(), entry.getValue());
                                            }
                                            relNode.put("data", data);
                                        }
                                    } catch (Exception e) {
                                        relNode.put("data", new JSONObject());
                                    }
                                }
                                allNodes.add(relNode);

                                // Recurse
                                fetchRelations(relatedOtId, relatedInstId, visitedNodes, allNodes, allEdges,
                                        projectId, currentDepth + 1, maxDepth);
                            }
                        } catch (Exception e) {
                            // Skip if we can't get related data
                        }
                    }
                }
            }
        } catch (Exception e) {
            // Log and continue
        }
    }
}
