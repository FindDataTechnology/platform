// ── 智能体详情页的 壹座 宿主（pack-detail-as-page 1.x）───────────────────────
//
// 页面本体在 `components/packs/PackDetailPage.tsx`（与 facet 共用一份）。这一层
// 只做宿主适配：把 react-router 的地址、身份、返回路径、提示词通道、装作入口接上。
//
// 交易可见性由身份决定（D2）：`useAuthStore().authenticated` 为真才有订阅卡；
// 未登录看到说明行 + 登录入口，不是置灰按钮。
import { useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@platform/core";

import { useAuthStore } from "@/hooks/useAuth";
import { PackDetailPage } from "@/components/packs/PackDetailPage";
import { PageShell } from "@/components/ui/page-shell";
import { STUDIO_ORIGIN } from "@/lib/studio-origin";

export function AgentPackDetailPage() {
  const { t } = useTranslation();
  const { packId } = useParams();
  const navigate = useNavigate();
  const auth = useAuthStore();
  const setComposerDraft = useChatStore((s) => s.setComposerDraft);

  // 示例问题 → 聊天（P2 3.5 的停放草稿通道，与 DocumentsPage 同一做法）：
  // 输入框在聊天页把它消费一次。
  const usePrompt = useCallback(
    (prompt: string) => {
      setComposerDraft(prompt);
      navigate("/chat");
    },
    [navigate, setComposerDraft],
  );

  return (
    <PageShell data-testid="agent-pack-detail-page" title={t("nav.agents")} titleTestId="agent-pack-detail-title">
      <PackDetailPage
        packId={packId ?? null}
        // 不认证的部署（AUTH_MODE=none：本地、e2e、自托管 demo）谁都能装——
        // 只按 authenticated 判会把它们的交易面整块藏掉。
        canTrade={Boolean(auth.authenticated || auth.ssoAuthenticated || auth.mode === "none")}
        // 壹座 是能装进 cell 的宿主：部署/计费面板在这里有数据。
        installSurface
        // 返回来处（保留筛选）：读者是从目录（带 ?line/?domain/?q/?unlined）点进来
        // 的，硬编码 navigate("/agents") 会把这些全丢掉——退回去看到的是全量列表
        // （2026-11-25 e2e「filter survives the detail round trip」实测：返回到 3 条）。
        // `-1` 回到上一处含全部 query；直接访问详情页（无站内来路）时退回列表页。
        onBack={() => (window.history.length > 1 ? navigate(-1) : navigate("/agents"))}
        onRequireLogin={() => navigate("/")}
        onUsePrompt={usePrompt}
        onGotoMine={() => navigate("/agents?tab=mine")}
        onFork={(id) => navigate(`/studio?fork=${encodeURIComponent(id)}`)}
        // 报告末尾的下一步：带着刚装好的角色/集群去对话。
        onOpenChat={(target) => navigate(target)}
        // 看板入口（reach-pack-console）：建完队直达集群控制台；已发布给对外
        // 分享链接——share 面只存在于谦面（facet `/t/<slug>`），跨域新开。
        onGotoConsole={(fleetId) => navigate(`/fleets/${encodeURIComponent(fleetId)}/console`)}
        onGotoBoard={(slug) => window.open(`${STUDIO_ORIGIN}/t/${encodeURIComponent(slug)}`, "_blank", "noopener")}
      />
    </PageShell>
  );
}

export default AgentPackDetailPage;
