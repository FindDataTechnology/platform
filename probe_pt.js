const D = require('better-sqlite3');
const db = new D('/data/cells/3fdc7b8e8ac03b68/data/data/app.db', { readonly: true });
console.log('=== registry creds ===');
for (const r of db.prepare('SELECT * FROM user_registry_credentials').all()) {
  console.log(' ', r.email, 'stale=' + r.stale, 'exp=' + r.expires_at, 'src=' + r.source);
}
console.log('=== extension_configs ===');
for (const r of db.prepare('SELECT name,enabled,origin,required_groups,config_json FROM extension_configs').all()) {
  console.log(' ', r.name, '| en=' + r.enabled, '| ' + r.origin, '| ' + JSON.stringify(r.required_groups), '| ' + String(r.config_json).slice(0, 90));
}
console.log('=== focus overlays / presets ===');
try {
  for (const r of db.prepare('SELECT * FROM user_preferences').all()) {
    const s = JSON.stringify(r);
    if (/focus|overlay|preset/i.test(s)) console.log(' pref:', s.slice(0, 300));
  }
} catch (e) { console.log(' pref ERR', e.message); }
