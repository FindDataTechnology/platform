// 万星跨线副驾的宿主上下文（adopt-wanxing-copilot-in-paas 2.2/2.4）。
//
// 只做三件事：把「用户在哪个页面、看哪条线的板」递过去；路由变化时推一次；
// 按路由决定萬星 widget 是否在场（unify-yizuo-copilot-surface D1/D3）。
// 不实现 identify()——壹座的身份是 forward_auth（代理头注入，浏览器无 ID token），
// 与万星 identify 契约不兼容；身份升级走万星自己的 popup 登录（design D4）。
//
// board line 塞进 `entity` 而不是新字段：万星协议里 entity 的语义就是「用户在看哪个
// 对象」，board 与 pack 都符合。不发明新字段，免得 loader 与 widget 两端又要各写一份。
//
// 去重机制：`copilot.js` 把 iframe `appendChild` 到宿主 body，带
// `data-wanxing-copilot`——宿主天然拥有它，`style.display = "none"` 即可退场，
// 不需要给萬星加钩子、不需要跨仓发版。必须用 display 而不是 visibility/opacity：
// 收起态 iframe 只有 80px 高但仍是 position:fixed 的透明文档，会吃掉那一角的点击。
// loader 是 defer 且要先 fetch 绑定解析才 mount，所以还要观测新增节点。
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { shouldMountWanxingCopilot } from "@/lib/copilotSurfaces";

type CopilotApi = {
  context?: () => Record<string, unknown>;
  pushContext?: () => void;
};

/** /boards/<line> → line；其余路径 → null。 */
export function boardLineFromPath(pathname: string): string | null {
  const m = /^\/boards\/([^/?#]+)/.exec(pathname);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

const FRAME_SELECTOR = "iframe[data-wanxing-copilot]";

/** 按当前路由同步萬星 widget 的显隐。 */
function syncVisibility(mount: boolean): void {
  for (const frame of document.querySelectorAll<HTMLIFrameElement>(FRAME_SELECTOR)) {
    frame.style.display = mount ? "" : "none";
  }
}

export function WanxingCopilotHost() {
  const location = useLocation();
  const path = location.pathname + location.search;
  const mount = shouldMountWanxingCopilot(location.pathname, location.search);

  useEffect(() => {
    const w = window as unknown as { WanxingCopilot?: CopilotApi };
    if (!w.WanxingCopilot) w.WanxingCopilot = {};
    const api = w.WanxingCopilot;
    api.context = () => {
      const line = boardLineFromPath(location.pathname);
      return {
        line: "壹座",
        page: path,
        ...(line ? { entity: line } : {}),
      };
    };
    // loader 已经在 ready 时取过一次 context；路由变了要主动推，否则 widget 的
    // 上下文栏会停在首次挂载的那一页。
    try {
      api.pushContext?.();
    } catch {
      /* loader 未挂载（未绑定/已暂停时不注入），忽略 */
    }
  }, [path, location.pathname]);

  // 显隐：路由变化的立即求值 + 观测晚到的 iframe（loader 异步 mount）。
  useEffect(() => {
    syncVisibility(mount);
    const observer = new MutationObserver(() => syncVisibility(mount));
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [mount]);

  return null;
}
