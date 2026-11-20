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

// ── Resident steward tab (add-cell-lifecycle, chapter 2) ───────────────────
const stewardConsentEl = document.getElementById('stewardConsent');
const stewardStatusTextEl = document.getElementById('stewardStatusText');
const stewardInstallBtn = document.getElementById('stewardInstallBtn');
const stewardUninstallBtn = document.getElementById('stewardUninstallBtn');
const stewardRepairBtn = document.getElementById('stewardRepairBtn');

// Three honest states (add-desktop-residency-hardening 3.x): registered and
// healthy / registered but NOT healthy (the crash loop's last reason travels
// with it) / not registered. A registration file alone is never "healthy".
async function refreshStewardPanel() {
  if (!window.platform.getStewardConsent) return;
  const consent = await window.platform.getStewardConsent();
  stewardConsentEl.textContent = consent.consentText;
  // add-unified-fleet-console D7: already-paired installs see the 运行明细
  // lane notice once on the first launch after the update (informational —
  // every listed field is still content-free metadata).
  const noticeEl = document.getElementById('fleetDetailNotice');
  if (noticeEl && consent.fleetDetailNoticeText) {
    const paired = currentSettings.AGENT_RUNNER_FLEET_TOKEN_SET || currentSettings.AGENT_RUNNER_FLEET_TOKEN;
    const flagKey = 'fleetDetailNoticeSeen.v1';
    if (paired && !localStorage.getItem(flagKey)) {
      noticeEl.textContent = consent.fleetDetailNoticeText;
      noticeEl.style.display = '';
      localStorage.setItem(flagKey, '1');
    }
  }
  const st = await window.platform.getStewardStatus();
  const crash = st.crash || {};
  if (st.state === 'healthy' || st.running) {
    stewardStatusTextEl.textContent = `运行中 (pid ${st.pid}, protocol v${st.protocolVersion})`;
    stewardInstallBtn.style.display = 'none';
    stewardUninstallBtn.style.display = '';
    stewardRepairBtn.style.display = 'none';
  } else if (st.state === 'unhealthy' || st.installed) {
    const why = crash.lastFailure?.message || st.error || '进程未响应';
    const cooling = crash.coolingDown ? `（崩溃保护冷却中，${Math.ceil((crash.retryAfterMs || 0) / 1000)}s 后自动重试）` : '';
    stewardStatusTextEl.textContent = `已注册未在运行 — ${why}${cooling}`;
    stewardInstallBtn.style.display = 'none';
    stewardUninstallBtn.style.display = '';
    stewardRepairBtn.style.display = '';
  } else {
    stewardStatusTextEl.textContent = '未安装 — 退出应用窗口后舰队与定时任务不会继续运行';
    stewardInstallBtn.style.display = '';
    stewardUninstallBtn.style.display = 'none';
    stewardRepairBtn.style.display = 'none';
  }
  await refreshPairPanel(st);
}

document.getElementById('stewardRepairBtn')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('stewardStatus');
  statusEl.className = '';
  statusEl.textContent = '重新注册中…';
  const r = await window.platform.repairSteward();
  statusEl.className = r.ok ? 'success' : 'error';
  statusEl.textContent = r.ok ? '✓ 已重新注册自启并重置崩溃计数' : `✗ 重新注册失败：${r.error || 'unknown'}`;
  await refreshStewardPanel();
});

document.getElementById('stewardInstallBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('stewardStatus');
  statusEl.className = '';
  statusEl.textContent = '安装中…';
  const r = await window.platform.installSteward();
  statusEl.className = r.ok ? 'success' : 'error';
  statusEl.textContent = r.ok ? '✓ 后台管家已安装并启动' : `✗ 安装失败：${r.error || 'unknown'}`;
  await refreshStewardPanel();
});

document.getElementById('stewardUninstallBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('stewardStatus');
  statusEl.className = '';
  statusEl.textContent = '卸载中…';
  const r = await window.platform.uninstallSteward();
  statusEl.className = r.ok ? 'success' : 'error';
  statusEl.textContent = r.ok ? '✓ 已卸载（运行时随之停排，数据与设置保留）' : `✗ 卸载失败：${r.error || 'unknown'}`;
  await refreshStewardPanel();
});

refreshStewardPanel();

// ── Steward pairing (add-cell-lifecycle chapter 4) ─────────────────────────
async function refreshPairPanel(st) {
  const pairGroup = document.getElementById('stewardPairGroup');
  const pairedGroup = document.getElementById('stewardPairedGroup');
  if (!pairGroup || !pairedGroup) return;
  if (st?.paired) {
    pairGroup.style.display = 'none';
    pairedGroup.style.display = '';
    document.getElementById('stewardPairedText').textContent =
      `配对码设备 ${st.pairDeviceId} — 仅上报在线状态与计数摘要，内容零出机`;
  } else {
    pairGroup.style.display = st?.running ? '' : 'none';
    pairedGroup.style.display = 'none';
  }
}

document.getElementById('stewardPairBtn')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('stewardStatus');
  const code = document.getElementById('stewardPairCode').value.trim();
  const label = document.getElementById('stewardPairLabel').value.trim() || null;
  if (!/^\d{6}$/.test(code)) { statusEl.className = 'error'; statusEl.textContent = '✗ 配对码是六位数字'; return; }
  statusEl.textContent = '配对中…';
  const r = await window.platform.pairSteward(code, label);
  statusEl.className = r.ok ? 'success' : 'error';
  statusEl.textContent = r.ok ? `✓ 配对完成${r.email ? `（${r.email}）` : ''}，上行即刻开始` : `✗ 配对失败：${r.error}`;
  await refreshStewardPanel();
});

document.getElementById('stewardUnpairBtn')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('stewardStatus');
  const r = await window.platform.unpairSteward();
  statusEl.className = r.ok ? 'success' : 'error';
  statusEl.textContent = r.ok ? '✓ 已解除配对并停上报（凭据已焚毁）' : `✗ 解配失败：${r.error}`;
  await refreshStewardPanel();
});

// ── In-app update tab (add-desktop-in-app-update) ────────────────────────────

const updateStateTextEl = document.getElementById('updateStateText');
const updateVersionTextEl = document.getElementById('updateVersionText');
const updateDegradeTextEl = document.getElementById('updateDegradeText');
const updateQuitInstallBtnEl = document.getElementById('updateQuitInstallBtn');
const updateOpenDownloadBtnEl = document.getElementById('updateOpenDownloadBtn');
const updateActionStatusEl = document.getElementById('updateActionStatus');

const UPDATE_STATUS_TEXT = {
  idle: '未检查（启动后会自动静默查一次）',
  checking: '检查中…',
  downloading: '发现新版本，后台下载中…（不打断使用；退出时自动安装）',
  downloaded: '新版本已就绪——退出应用时自动安装，或现在点「退出并安装」',
  'up-to-date': '已是最新版本',
  'notify-only': '有新版本（未签名构建仅提示，见下方说明）',
  error: '检查失败（通道不可达或暂不可用——应用照常可用）',
};

function renderUpdateState(st) {
  updateStateTextEl.textContent = UPDATE_STATUS_TEXT[st.status] || st.status;
  if (st.status === 'error' && st.error) updateStateTextEl.textContent += `：${st.error}`;
  if (st.version) updateStateTextEl.textContent += `（${st.version}）`;
  updateVersionTextEl.textContent = st.runningVersion || '—';
  // macOS notify-only degrade note rides the status, not a platform branch:
  // the shell flips status to notify-only exactly when the build can't auto-swap.
  updateDegradeTextEl.style.display = st.status === 'notify-only' ? '' : 'none';
  updateQuitInstallBtnEl.style.display = st.status === 'downloaded' ? '' : 'none';
  updateOpenDownloadBtnEl.style.display = st.url ? '' : 'none';
}

async function refreshUpdatePanel() {
  const st = await window.platform.getUpdateState();
  renderUpdateState(st);
  const visible = await window.platform.getVisibleSettings();
  document.getElementById('updateChannelInput').value = visible.DESKTOP_UPDATE_URL || '';
}

document.getElementById('updateCheckBtn')?.addEventListener('click', async () => {
  updateActionStatusEl.textContent = '';
  updateStateTextEl.textContent = '检查中…';
  const st = await window.platform.checkForUpdate();
  renderUpdateState(st);
});

document.getElementById('updateQuitInstallBtn')?.addEventListener('click', async () => {
  const r = await window.platform.quitAndInstallUpdate();
  if (!r.ok) updateActionStatusEl.textContent = '✗ 当前没有已下载完成的更新';
});

document.getElementById('updateOpenDownloadBtn')?.addEventListener('click', async () => {
  await window.platform.openUpdateDownload();
});

document.getElementById('updateChannelSaveBtn')?.addEventListener('click', async () => {
  const v = document.getElementById('updateChannelInput').value.trim();
  const r = await window.platform.setSettingField('DESKTOP_UPDATE_URL', v || null);
  updateActionStatusEl.textContent = r.ok ? '✓ 通道已保存，下次检查生效' : `✗ ${r.error}`;
});

refreshUpdatePanel();
