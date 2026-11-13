export default defineAppConfig({
  pages: [
    "pages/chat/index",
    "pages/login/index",
    "pages/bind-guide/index",
    "pages/share/index",
    "pages/cron/index",
    "pages/resources/index",
    "pages/command/index",
    // UE 订货台页面集（add-erp-miniapp-pagesets P1；docs/pageset-base-v1.md
    // §4 静态注册模式：页面随包编译，授权可见性落在入口渲染 + PagesetGate
    // 路由守卫，永不动态装载。路径 = registry pages/ue/* 一一对应）。
    // 智语房间（openspec: add-zhiyu-mobile-clients 3.1）：两页静态注册，
    // 与 web 同一批端点、同一套游标语义；重交互不在移动端实现，改为一次性链接。
    "pages/zhiyu/list/index",
    "pages/zhiyu/room/index",
    "pages/ue/home",
    "pages/ue/product-search",
    "pages/ue/product-detail",
    "pages/ue/cart",
    "pages/ue/order-create",
    "pages/ue/order-list",
    "pages/ue/order-detail",
    "pages/ue/statement-confirm",
    "pages/ue/invoice-apply",
    "pages/ue/aftersale-apply",
    "pages/ue/aftersale-detail",
    "pages/ue/ai-assistant",
    // SE 业务员台（P2 3.1-3.6）+ SP 供应商协同（P2 4.1-4.7）与 CP 承运协同
    // （P3 5.1-5.8）页面集：同一条静态注册纪律（registry pages/<surface>/*
    // 一一对应，授权与身份闸都在页面内，永不动态装载）。
    "pages/se/home",
    "pages/se/customer-list",
    "pages/se/customer-detail",
    "pages/se/lead-visit",
    "pages/se/order-proxy",
    "pages/se/order-track",
    "pages/se/alert-inbox",
    "pages/se/alert-handle",
    "pages/se/statement-assist",
    "pages/se/ai-assistant",
    "pages/sp/home",
    "pages/sp/order-accept",
    "pages/sp/delivery-feedback",
    "pages/sp/arrival-notice",
    "pages/sp/reconciliation",
    "pages/sp/invoice-upload",
    "pages/sp/payment-view",
    "pages/sp/ai-assistant",
    "pages/cp/home",
    "pages/cp/waybill-accept",
    "pages/cp/dock-reserve",
    "pages/cp/pickup-checkin",
    "pages/cp/pod-report",
    "pages/cp/track",
    "pages/cp/reconciliation",
    "pages/cp/ai-assistant",
  ],
  window: {
    backgroundTextStyle: "light",
    // Custom navigation on every page (layout P2 #5): the daylight world
    // draws its own top bar; the dark native bar (an Inverted Ink violation
    // and a double header on chat) is gone. Pages pad for the status bar and
    // reserve the capsule lane via lib/top-insets + PageHeader.
    navigationStyle: "custom",
    // Status bar glyphs stay dark on the light header/paper.
    navigationBarTextStyle: "black",
    navigationBarTitleText: "Platform",
  },
});
