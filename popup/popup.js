const SYNC_KEYS = ['fbTimeFilterStart', 'fbTimeFilterEnabled', 'fbTimeMarkerCompareCheckpoint', 'fbTimeMarkerNewCheckpoint'];
const $ = id => document.getElementById(id);
function fmt(value) { return value ? new Date(value).toLocaleString('vi-VN') : 'Chưa lưu'; }
function fmtCheckpoint(value) { return value ? new Date(value).toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'medium' }) : 'Chưa có'; }
function toLocalInput(value) {
  if (!value) return '';
  const d = new Date(value), pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
async function render() {
  const sync = await chrome.storage.sync.get(SYNC_KEYS);
  $('startInput').value = toLocalInput(sync.fbTimeFilterStart);
  $('savedTime').textContent = 'Mốc đang lưu: ' + fmt(sync.fbTimeFilterStart);
  $('enabled').checked = !!sync.fbTimeFilterEnabled;
  $('status').textContent = sync.fbTimeFilterEnabled ? 'Đánh dấu theo mốc T đang bật' : 'Đánh dấu theo mốc T đang tắt';
  // The comparison checkpoint is the real filtering threshold T.
  $('compareCheckpoint').textContent = fmtCheckpoint(sync.fbTimeFilterStart);
  $('newCheckpoint').textContent = fmtCheckpoint(sync.fbTimeMarkerNewCheckpoint);
  $('advanceCheckpoint').disabled = !sync.fbTimeMarkerNewCheckpoint || sync.fbTimeMarkerNewCheckpoint === sync.fbTimeFilterStart;
}
async function messageTab(type) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) {
    try { await chrome.tabs.sendMessage(tabs[0].id, { type }); } catch { /* The current tab may not be Facebook. */ }
  }
}
async function saveStart(iso) {
  await chrome.storage.sync.set({ fbTimeFilterStart: iso });
  await render();
  await messageTab('FB_TIME_FILTER_APPLY');
}
$('saveCustom').addEventListener('click', async () => {
  const value = $('startInput').value;
  if (!value) { $('savedTime').textContent = 'Hãy chọn ngày và giờ trước.'; return; }
  const date = new Date(value);
  if (Number.isFinite(date.getTime())) await saveStart(date.toISOString());
});
$('saveNow').addEventListener('click', async () => {
  const now = new Date();
  $('startInput').value = toLocalInput(now.toISOString());
  await saveStart(now.toISOString());
});
$('clearStart').addEventListener('click', async () => {
  await chrome.storage.sync.remove('fbTimeFilterStart');
  await render();
  await messageTab('FB_TIME_FILTER_APPLY');
});
$('enabled').addEventListener('change', async event => {
  await chrome.storage.sync.set({ fbTimeFilterEnabled: event.target.checked });
  await messageTab('FB_TIME_FILTER_APPLY');
  await render();
});
$('scan').addEventListener('click', async () => { await messageTab('FB_TIME_FILTER_SCAN'); });
render();


$('captureCheckpoint').addEventListener('click', async () => {
  const now = new Date().toISOString();
  await chrome.storage.sync.set({ fbTimeMarkerNewCheckpoint: now });
  await render();
});

$('advanceCheckpoint').addEventListener('click', async () => {
  const sync = await chrome.storage.sync.get(['fbTimeFilterStart', 'fbTimeMarkerNewCheckpoint']);
  if (!sync.fbTimeMarkerNewCheckpoint) {
    return;
  }
  if (sync.fbTimeMarkerNewCheckpoint === sync.fbTimeFilterStart) {
    return;
  }
  // T is the actual comparison threshold used by the content scanner.
  await chrome.storage.sync.set({
    fbTimeFilterStart: sync.fbTimeMarkerNewCheckpoint,
    fbTimeMarkerCompareCheckpoint: sync.fbTimeMarkerNewCheckpoint
  });
  $('startInput').value = toLocalInput(sync.fbTimeMarkerNewCheckpoint);
  await messageTab('FB_TIME_FILTER_APPLY');
  await render();
});
