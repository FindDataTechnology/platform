// Taro babel preset — compiles the React JSX runtime and TS for the weapp
// target. ES5 down-compilation is off: WeChat's runtime is modern enough and
// the smaller output helps the main-package size budget.
module.exports = {
  presets: [
    [
      "taro",
      {
        framework: "react",
        ts: true,
        compiler: "webpack5",
        useBuiltIns: false,
      },
    ],
  ],
};
