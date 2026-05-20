package com.ontology.mcp.model;

public class InstanceGraphRequest {
    private String objectTypeName;
    private String keyword;
    private String projectId;
    private int maxDepth = 2;

    public String getObjectTypeName() { return objectTypeName; }
    public void setObjectTypeName(String objectTypeName) { this.objectTypeName = objectTypeName; }
    public String getKeyword() { return keyword; }
    public void setKeyword(String keyword) { this.keyword = keyword; }
    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }
    public int getMaxDepth() { return maxDepth; }
    public void setMaxDepth(int maxDepth) { this.maxDepth = maxDepth; }
}
