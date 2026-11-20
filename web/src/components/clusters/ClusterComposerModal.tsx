// ClusterComposerModal — create a dynamic cluster from multiple pack agents
// (agent-cluster-platform)
//
// Allows users to assemble custom agent clusters at runtime from multiple
// installed pack agents, with full lifecycle management.

import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@platform/core";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/packs/Badge";
import * as api from "@/lib/packs-api";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (clusterId: string, name: string) => void;
}

interface AgentOption {
  packId: string;
  packName: string;
  agentId: string;
  agentName: string;
  description?: string;
  isDefaultAgent?: boolean;
}

export function ClusterComposerModal({ open, onOpenChange, onSuccess }: Props) {
  const { t } = useTranslation();
  
  // Form state
  const [clusterName, setClusterName] = useState("");
  const [clusterDescription, setClusterDescription] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [activateAll, setActivateAll] = useState(true);
  const [bindToSession, setBindToSession] = useState(false);
  
  // Available agents from installed packs
  const [availableAgents, setAvailableAgents] = useState<AgentOption[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  
  // Creation state
  const [creating, setCreating] = useState(false);
  const [creationStatus, setCreationStatus] = useState<{
    status: "creating" | "ready" | "loading";
    agents: Array<{ agentId: string; status: string }>;
  } | null>(null);
  
  // Load available agents when modal opens
  // biome-ignore lint/correctness/useExhaustiveDependencies: open-triggered reload; the loader is recreated per render by design
  useEffect(() => {
    if (open) {
      void loadAvailableAgents();
      // Reset form
      setClusterName("");
      setClusterDescription("");
      setSelectedAgents(new Set());
      setActivateAll(true);
      setBindToSession(false);
      setCreationStatus(null);
    }
  }, [open]);
  
  const loadAvailableAgents = async () => {
    setLoadingAgents(true);
    try {
      // InstalledPack already carries the manifest — no per-pack detail round-trip.
      // Field is `packId` (not `id`); using the wrong one produced
      // GET /api/packs/undefined → 404 and an empty agent list.
      const myPacks = await api.listInstalledPacks();
      const agents: AgentOption[] = [];
      for (const pack of myPacks.packs || []) {
        const manifest = pack.manifest;
        for (const agent of manifest?.agents ?? []) {
          agents.push({
            packId: pack.packId,
            packName: pack.name,
            agentId: agent.id,
            agentName: agent.name,
            description: agent.description,
            isDefaultAgent: manifest?.cluster?.defaultAgents?.includes(agent.id) ?? false,
          });
        }
      }
      setAvailableAgents(agents);
    } catch (err) {
      console.error("Failed to load available agents:", err);
      setAvailableAgents([]);
    } finally {
      setLoadingAgents(false);
    }
  };

  const toggleAgentSelection = (agentId: string) => {
    const next = new Set(selectedAgents);
    if (next.has(agentId)) {
      next.delete(agentId);
    } else {
      next.add(agentId);
    }
    setSelectedAgents(next);
  };
  
  const addAllFromPack = (packId: string) => {
    const packAgents = availableAgents.filter(a => a.packId === packId);
    const next = new Set(selectedAgents);
    for (const agent of packAgents) {
      next.add(agent.agentId);
    }
    setSelectedAgents(next);
  };
  
  const validateForm = (): string | null => {
    if (!clusterName.trim()) {
      return t("clusters.composer.nameRequired");
    }
    if (clusterName.length > 100) {
      return t("clusters.composer.nameTooLong");
    }
    if (selectedAgents.size === 0) {
      return t("clusters.composer.atLeastOneAgent");
    }
    return null;
  };
  
  const handleCreate = async () => {
    const error = validateForm();
    if (error) {
      alert(error);
      return;
    }
    
    setCreating(true);
    try {
      const agents = Array.from(selectedAgents).map(agentId => {
        const agentOpt = availableAgents.find(a => a.agentId === agentId);
        return {
          packId: agentOpt?.packId || "",
          agentId: agentId
        };
      });
      
      // Session binding rides the chat store's live session id — the composer
      // opens from /agents, so the "current" session is whatever the chat
      // store last had open (the server keys the binding on this id).
      const liveSessionId = useChatStore.getState().currentSessionId;
      const result = await api.createDynamicCluster({
        name: clusterName.trim(),
        description: clusterDescription.trim(),
        agents,
        activateAll,
        bindToSession,
        ...(bindToSession && liveSessionId ? { sessionId: liveSessionId } : {}),
      });
      
      setCreationStatus(result);
      
      // Auto-success if ready immediately
      if (result.status === "ready") {
        setTimeout(() => {
          onSuccess?.(result.clusterId, clusterName);
          onOpenChange(false);
        }, 500);
      }
    } catch (err) {
      console.error("Failed to create cluster:", err);
      alert(err instanceof Error ? err.message : "Failed to create cluster");
    } finally {
      setCreating(false);
    }
  };
  
  const groupedAgents = useMemo(() => {
    const groups: Record<string, AgentOption[]> = {};
    for (const agent of availableAgents) {
      if (!groups[agent.packId]) {
        groups[agent.packId] = [];
      }
      groups[agent.packId]?.push(agent);
    }
    return groups;
  }, [availableAgents]);
  
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("clusters.composer.title")}</DialogTitle>
        </DialogHeader>
        
        {/* Section 1: Cluster metadata */}
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-2 block">
              {t("clusters.composer.clusterName")} *
            </label>
            <Input
              value={clusterName}
              onChange={(e) => setClusterName(e.target.value)}
              placeholder="My Analysis Team"
              maxLength={100}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {clusterName.length}/100 characters
            </p>
          </div>
          
          <div>
            <label className="text-sm font-medium mb-2 block">
              {t("clusters.composer.description")}
            </label>
            <Textarea
              value={clusterDescription}
              onChange={(e) => setClusterDescription(e.target.value)}
              placeholder="A team of agents for financial analysis..."
              rows={3}
            />
          </div>
        </div>
        
        <hr className="my-4" />
        
        {/* Section 2: Agent selection */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm font-medium">
              {t("clusters.composer.selectAgents")} *
            </label>
            <span className="text-xs text-muted-foreground">
              {selectedAgents.size} selected
            </span>
          </div>
          
          {loadingAgents ? (
            <div className="text-sm text-muted-foreground py-4">
              Loading available agents...
            </div>
          ) : Object.keys(groupedAgents).length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 border border-dashed rounded-md p-4 text-center">
              {t("clusters.composer.noAgents")}
            </div>
          ) : (
            <div className="space-y-4">
              {Object.entries(groupedAgents).map(([packId, agents]) => (
                <div key={packId} className="border border-border rounded-md p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-medium text-sm">{agents[0]?.packName ?? packId}</div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs"
                      onClick={() => addAllFromPack(packId)}
                    >
                      + {t("clusters.composer.addAllFromPack")}
                    </Button>
                  </div>
                  
                  <div className="space-y-1">
                    {agents.map((agent) => {
                      const isSelected = selectedAgents.has(agent.agentId);
                      return (
                        <div
                          key={agent.agentId}
                          className={`flex items-start gap-2 p-2 rounded-md cursor-pointer transition-colors ${
                            isSelected ? "bg-primary/10 border border-primary/20" : "hover:bg-muted"
                          }`}
                          onClick={() => toggleAgentSelection(agent.agentId)}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            className="mt-0.5"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{agent.agentName}</span>
                              {agent.isDefaultAgent && (
                                <Badge>{t("clusters.composer.defaultAgent")}</Badge>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground font-mono mt-0.5">
                              {agent.agentId}
                            </div>
                            {agent.description && (
                              <div className="text-xs text-muted-foreground mt-1 line-clamp-1">
                                {agent.description}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        
        <hr className="my-4" />
        
        {/* Section 3: Activation policy */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="activateAll"
            checked={activateAll}
            onChange={(e) => setActivateAll(e.target.checked)}
            className="w-4 h-4"
          />
          <label htmlFor="activateAll" className="text-sm">
            {t("clusters.composer.activateAllOnCreation")}
          </label>
        </div>
        
        {/* Section 4: Session binding */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="bindToSession"
            checked={bindToSession}
            onChange={(e) => setBindToSession(e.target.checked)}
            className="w-4 h-4"
          />
          <label htmlFor="bindToSession" className="text-sm">
            {t("clusters.composer.bindToCurrentSession")}
          </label>
        </div>
        
        {/* Creation progress */}
        {creationStatus && (
          <div className="mt-4 p-3 bg-muted rounded-md">
            <div className="text-sm font-medium mb-2">
              {creationStatus.status === "creating" || creationStatus.status === "loading"
                ? t("clusters.composer.creating")
                : t("clusters.composer.created")}
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              {creationStatus.agents.map((a) => (
                <div key={a.agentId} className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    a.status === "active" ? "bg-green-500" : 
                    a.status === "installing" ? "bg-yellow-500 animate-pulse" :
                    "bg-gray-500"
                  }`}></span>
                  <span>{a.agentId}: {a.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        
        {/* Action bar */}
        <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            {t("clusters.composer.cancel")}
          </Button>
          <Button
            onClick={handleCreate}
            disabled={creating || !clusterName.trim() || selectedAgents.size === 0}
          >
            {creating
              ? t("clusters.composer.creatingBtn")
              : t("clusters.composer.createCluster")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
