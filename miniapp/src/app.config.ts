export default defineAppConfig({
  pages: [
    "pages/chat/index",
    "pages/login/index",
    "pages/bind-guide/index",
    "pages/share/index",
    "pages/cron/index",
    "pages/resources/index",
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
