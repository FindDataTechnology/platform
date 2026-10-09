// MCP 服务卡片区块 (add-facet-platform S2): 注册处的 MCP 目录只读聚合——
// 名称/描述/连接端点/所需组。连接需要 registry 账号凭据（per-user JWT），
// 卡片如实标注，不提供任何写操作（ADR-0015 轻归屋）。

import { useEffect, useState } from "react";
import { Badge } from "@/components/packs/Badge";

type McpCard = {
  name: string;
  displayName: string;
  description: string;
  endpoint: string;
  requiredGroups: string[];
};

export function McpCatalog() {
  const [cards, setCards] = useState<McpCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/mcp-catalog")
      .then((r) => r.json())
      .then((d) => setCards(Array.isArray(d?.servers) ? d.servers : []))
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="text-sm text-muted-foreground">MCP 目录暂不可用：{error}</div>;
  if (!cards) return <div className="text-sm text-muted-foreground">加载中…</div>;
  if (cards.length === 0)
    return <div className="text-sm text-muted-foreground">当前身份下没有可见的 MCP 服务（登录后可见更多）。</div>;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        来自注册处的 MCP 服务目录（只读）。连接需要 registry 账号凭据——授权走注册处登录，
        URL 即各卡片上的端点。
      </p>
      {cards.map((c) => (
        <div key={c.name} className="border border-border rounded-lg p-4">
          <div className="flex items-center justify-between">
            <span className="font-medium">{c.displayName}</span>
            {c.requiredGroups.length > 0 && (
              <Badge>requires group {c.requiredGroups[0]}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">{c.description}</p>
          <code className="text-xs text-muted-foreground mt-2 block break-all">{c.endpoint}</code>
        </div>
      ))}
    </div>
  );
}