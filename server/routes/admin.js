// Admin dashboard for Agent Cluster Platform

import { getClusterDatabase } from "./clusters-db.js";

const clusterDb = getClusterDatabase();

export function createAdminRoutes(app) {
  // GET /api/admin/clusters - List all clusters (admin only)
  app.get("/api/admin/clusters", (req, res) => {
    try {
      const user = req.user;
      if (!user || !user.isAdmin) {
        return res.status(403).json({ error: "Admin access required" });
      }
      
      const clusters = [];
      for (const cluster of clusterDb.listAll()) {
        clusters.push({
          id: cluster.id,
          name: cluster.name,
          status: cluster.status,
          agentCount: cluster.agents.length,
          totalExecutions: cluster.totalExecutions,
          totalTokensUsed: cluster.totalTokensUsed,
          lastUsedAt: cluster.lastUsedAt,
          createdAt: cluster.createdAt,
          owner: cluster.ownerEmail || "unknown",
        });
      }
      
      res.json({ clusters, count: clusters.length });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
  
  // POST /api/admin/clusters/:id/terminate - Force terminate cluster
  app.post("/api/admin/clusters/:id/terminate", (req, res) => {
    try {
      const user = req.user;
      if (!user || !user.isAdmin) {
        return res.status(403).json({ error: "Admin access required" });
      }
      
      const clusterId = req.params.id;
      const cluster = clusterDb.get(clusterId);
      
      if (!cluster) {
        return res.status(404).json({ error: "Cluster not found" });
      }
      
      clusterDb.update(clusterId, { status: "terminated" });
      
      res.json({ 
        success: true, 
        message: `Cluster ${clusterId} terminated by admin` 
      });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
  
  // GET /api/admin/users - List users with cluster usage
  app.get("/api/admin/users", (req, res) => {
    try {
      const user = req.user;
      if (!user || !user.isAdmin) {
        return res.status(403).json({ error: "Admin access required" });
      }
      
      // In production, query user database
      res.json({
        users: [
          { email: "user1@example.com", clusterCount: 5, totalExecutions: 1234 },
          { email: "user2@example.com", clusterCount: 3, totalExecutions: 567 },
        ],
        totalUsers: 2,
      });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
  
  // POST /api/admin/bulk-terminate - Terminate multiple clusters
  app.post("/api/admin/bulk-terminate", (req, res) => {
    try {
      const user = req.user;
      if (!user || !user.isAdmin) {
        return res.status(403).json({ error: "Admin access required" });
      }
      
      const { clusterIds } = req.body;
      if (!Array.isArray(clusterIds)) {
        return res.status(400).json({ error: "clusterIds array required" });
      }
      
      let terminated = 0;
      for (const id of clusterIds) {
        if (clusterDb.get(id)) {
          clusterDb.update(id, { status: "terminated" });
          terminated++;
        }
      }
      
      res.json({ 
        success: true, 
        terminated,
        message: `${terminated} clusters terminated` 
      });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
}
