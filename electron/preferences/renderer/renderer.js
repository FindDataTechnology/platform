// ── Vanilla JS renderer for Preferences window ──────────────────────────────

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => {
  t.classList.remove('active');
});
    document.querySelectorAll('.tab-panel').forEach(p => {
  p.classList.remove('active');
});
    tab.classList.add('active');
    document.querySelector(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
  });
});

// Load initial data
let currentSettings = {};
async function loadInitial() {
  currentSettings = await window.platform.getVisibleSettings();
  if (currentSettings.LLM_API_KEY !== undefined) {
    document.getElementById('llmApiKey').value = currentSettings.LLM_API_KEY || '';
  }
  if (currentSettings.LLM_BASE_URL !== undefined) {
    document.getElementById('llmBaseUrl').value = currentSettings.LLM_BASE_URL || '';
  }
  if (currentSettings.DEFAULT_MODEL !== undefined) {
    document.getElementById('defaultModel').value = currentSettings.DEFAULT_MODEL || '';
  }
  // Wanxing fleet tab: switch + registry wiring (secrets shown as presence only).
  document.getElementById('wanxingEnabled').checked = currentSettings.WANXING_PLUGIN_ENABLED === '1';
  document.getElementById('wanxingRegistryUrl').value = currentSettings.AGENT_SERVING_REGISTRY_URL || '';
  document.getElementById('wanxingRunnerPort').value = currentSettings.AGENT_RUNNER_PORT || '';
  document.getElementById('wanxingFleetUrl').value = currentSettings.AGENT_RUNNER_FLEET_URL || '';
  const tokenInput = document.getElementById('wanxingRegistryToken');
  if (currentSettings.AGENT_SERVING_REGISTRY_TOKEN_SET) {
    tokenInput.placeholder = '•••• saved — type to replace';
  } else {
    tokenInput.placeholder = 'paste token';
  }
  const fleetTokenInput = document.getElementById('wanxingFleetToken');
  if (currentSettings.AGENT_RUNNER_FLEET_TOKEN_SET) {
    fleetTokenInput.placeholder = '•••• saved — type to replace';
  } else {
    fleetTokenInput.placeholder = 'paste token';
  }
}

loadInitial();

// General save
document.getElementById('saveGeneral').addEventListener('click', async () => {
  const statusEl = document.getElementById('generalStatus');
  const key = document.getElementById('llmApiKey').value;
  const baseUrl = document.getElementById('llmBaseUrl').value;
  const defaultModel = document.getElementById('defaultModel').value;

  if (key.trim()) {
    await window.platform.setSettingField('LLM_API_KEY', key.trim());
  }
  if (baseUrl.trim() || baseUrl === '') {
    await window.platform.setSettingField('LLM_BASE_URL', baseUrl.trim());
  }
  if (defaultModel.trim() || defaultModel === '') {
    await window.platform.setSettingField('DEFAULT_MODEL', defaultModel.trim());
  }

  const result = await window.platform.restartService('server-js');
  if (result.ok) {
    statusEl.className = 'success';
    statusEl.textContent = '✓ Saved and restarted Platform backend';
  } else {
    statusEl.className = 'error';
    statusEl.textContent = '✗ Restart failed: ' + (result.error || 'unknown error');
  }
  setTimeout(() => { statusEl.textContent = ''; }, 5000);
});

// Wanxing fleet save
document.getElementById('saveWanxing').addEventListener('click', async () => {
  const statusEl = document.getElementById('wanxingStatus');
  const enabled = document.getElementById('wanxingEnabled').checked;
  const registryUrl = document.getElementById('wanxingRegistryUrl').value.trim();
  const token = document.getElementById('wanxingRegistryToken').value;
  const port = document.getElementById('wanxingRunnerPort').value.trim();
  const fleetUrl = document.getElementById('wanxingFleetUrl').value.trim();
  const fleetToken = document.getElementById('wanxingFleetToken').value;
  const wasEnabled = currentSettings.WANXING_PLUGIN_ENABLED === '1';

  // Front-of-gate: enabling without a registry keeps the runner crash-looping
  // (it exits without AGENT_SERVING_REGISTRY_URL) — refuse the combination.
  if (enabled && !registryUrl) {
    statusEl.className = 'error';
    statusEl.textContent = '✗ A serving registry URL is required to enable the fleet runner';
    return;
  }
  if (port && !/^\d+$/.test(port)) {
    statusEl.className = 'error';
    statusEl.textContent = '✗ Runner port must be a number';
    return;
  }

  await window.platform.setSettingField('WANXING_PLUGIN_ENABLED', enabled ? '1' : '0');
  await window.platform.setSettingField('AGENT_SERVING_REGISTRY_URL', registryUrl);
  // Empty inputs = keep the saved secrets (masked echo is display-only).
  if (token.trim()) {
    await window.platform.setSettingField('AGENT_SERVING_REGISTRY_TOKEN', token.trim());
    document.getElementById('wanxingRegistryToken').value = '';
  }
  await window.platform.setSettingField('AGENT_RUNNER_PORT', port);
  await window.platform.setSettingField('AGENT_RUNNER_FLEET_URL', fleetUrl);
  if (fleetToken.trim()) {
    await window.platform.setSettingField('AGENT_RUNNER_FLEET_TOKEN', fleetToken.trim());
    document.getElementById('wanxingFleetToken').value = '';
  }

  currentSettings.WANXING_PLUGIN_ENABLED = enabled ? '1' : '0';
  statusEl.className = 'success';
  if (enabled !== wasEnabled) {
    statusEl.textContent = '✓ Saved — restart the app for the switch to take effect';
  } else if (enabled) {
    const r = await window.platform.restartService('agent-runner-js');
    statusEl.textContent = r.ok
      ? '✓ Saved and restarted Wanxing fleet runner'
      : '✓ Saved (runner restart failed: ' + (r.error || 'unknown') + ')';
  } else {
    statusEl.textContent = '✓ Saved';
  }
  setTimeout(() => { statusEl.textContent = ''; }, 6000);
});


// Pair with the Wanxing console (slice ③): the code redeems server-side and
// the credentials persist in settings.json — the renderer only sees success.
document.getElementById('wanxingPairBtn').addEventListener('click', async () => {
  const btn = document.getElementById('wanxingPairBtn');
  const code = document.getElementById('wanxingPairCode').value.trim();
  const machineName = document.getElementById('wanxingPairName').value.trim();
  const statusEl = document.getElementById('wanxingStatus');
  if (!/^\d{6}$/.test(code)) {
    statusEl.className = 'error';
    statusEl.textContent = '✗ The pairing code is six digits';
    return;
  }
  btn.disabled = true;
  try {
    const r = await fetch('/api/wanxing/fleet/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machineName }),
    });
    const doc = await r.json().catch(() => ({}));
    if (!r.ok) {
      statusEl.className = 'error';
      statusEl.textContent = '✗ Pairing failed: ' + (doc.message || doc.error || r.status);
    } else {
      document.getElementById('wanxingPairCode').value = '';
      document.getElementById('wanxingFleetUrl').value = doc.fleetUrl || '';
      statusEl.className = 'success';
      statusEl.textContent = '✓ Seat ' + doc.runnerId + ' paired — uplink saved. Restart the fleet runner to apply.';
      setTimeout(() => void loadInitial(), 400);
    }
  } catch (e) {
    statusEl.className = 'error';
    statusEl.textContent = '✗ Pairing unreachable: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});
