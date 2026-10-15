// The app is a client for user-entered self-hosted instances, which may be
// plain http on a LAN (and CI's mock is http://10.0.2.2:9411). This SDK's
// prebuild ignores expo.android.usesCleartextTraffic (the key never reaches
// the manifest), so release builds default to the API-28+ no-cleartext
// policy — only the template's src/debug override made local dev work.
// Force the attribute on the main application and drop any
// networkSecurityConfig reference (which would take precedence).
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = (config) =>
  withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) return cfg;
    application.$ = application.$ ?? {};
    delete application.$["android:networkSecurityConfig"];
    application.$["android:usesCleartextTraffic"] = "true";
    return cfg;
  });
