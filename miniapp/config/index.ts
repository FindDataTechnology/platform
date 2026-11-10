import path from "node:path";
import { defineConfig } from "@tarojs/cli";

// Taro build configuration for the WeChat mini-program client.
//
// `@platform/core` is a file:-linked source package (TypeScript, no build
// step). Webpack resolves it through the symlink, and the alias below makes
// the resolution explicit and root-relative so the build never depends on
// node_modules layout. `zustand` is aliased to THIS project's copy: the shared
// core's store imports it, and letting that import resolve through the symlink
// into the web app's node_modules would drag a second React binding along.
export default defineConfig({
  projectName: "platform-miniapp",
  date: "2026-09-18",
  designWidth: 750,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    828: 1.81 / 2,
    375: 2,
  },
  sourceRoot: "src",
  outputRoot: "dist",
  plugins: [],
  defineConstants: {},
  copy: { patterns: [], options: {} },
  framework: "react",
  compiler: {
    type: "webpack5",
    prebundle: { enable: false },
  },
  cache: { enable: false },
  mini: {
    postcss: {
      pxtransform: { enable: true, config: {} },
      url: { enable: true, config: { limit: 1024 } },
      cssModules: { enable: false },
    },
    webpackChain(chain) {
      chain.resolve.alias
        .set("@", path.resolve(__dirname, "..", "src"))
        .set("zustand", path.resolve(__dirname, "..", "node_modules", "zustand"))
        .set("@platform/core", path.resolve(__dirname, "..", "..", "packages", "core", "src", "index.ts"));
      // The shared core lives outside the project root; run it through the
      // same babel pipeline as src/ (Taro excludes non-project files by
      // default, which would leave TS/JSX untranspiled).
      chain.module
        .rule("shared-core")
        .test(/\.[jt]sx?$/)
        .include.add(path.resolve(__dirname, "..", "..", "packages", "core", "src"))
        .end()
        .use("babel")
        .loader(require.resolve("babel-loader"))
        .options({
          presets: [[require.resolve("babel-preset-taro"), { framework: "react", ts: true }]],
          babelrc: false,
          configFile: false,
        });
    },
  },
  h5: {},
});
