## MODIFIED Requirements

### Requirement: Cluster-aware agent picker

The chat control strip's agent menu SHALL group pack-sourced agents that carry a `clusterId` under a cluster header showing the cluster name and member count, listing default members before optional ones; agents without a cluster keep their flat order. Each cluster header SHALL offer a 「载入集群」(load cluster) action. Because the shared runtime hosts one persona at a time, loading a cluster SHALL mean: create a dynamic cluster from the group's members bound to the current session (openspec: dynamic-cluster-composer, Cluster session binding) and switch the runtime to the first default member; it SHALL NOT claim to activate several personas at once — concurrent member execution is the cluster task surface (openspec: scheduling-cluster-aware). If no member carries the default marker, the load action SHALL fall back to the group's first listed member and surface that fallback honestly instead of implying a default member was chosen (current picker behavior, web/src/components/AssistantPicker.tsx:186). The picker lists installed agents only, so no install step is involved.

#### Scenario: Cluster grouping in picker

- **WHEN** a user installs a cluster pack and opens the agent menu in a chat session
- **THEN** the pack's installed members are grouped under a header naming the cluster and its member count, default members first, with a load-cluster action

#### Scenario: Loading a cluster binds the session and switches to the lead

- **WHEN** the user triggers load-cluster inside an open session
- **THEN** a dynamic cluster bound to that session is created, the session header shows the cluster, and the runtime switches to the first default member
