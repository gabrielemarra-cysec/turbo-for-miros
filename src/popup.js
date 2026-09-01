const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function runInPage(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args,
  });
  return result ? result.result : null;
}

function showMessage(text) {
  $("panel").hidden = true;
  const el = $("message");
  el.innerHTML = text;
  el.hidden = false;
}

function render(stats) {
  $("panel").hidden = false;
  $("message").hidden = true;
  $("saved").textContent = stats.savedRequests;
  $("pre").textContent = stats.prefetched;
  $("der").textContent = stats.derived;
  $("mem").textContent = stats.memoryHits;
  $("disk").textContent = stats.diskHits;
  $("dedup").textContent = stats.dedup;
  $("net").textContent = stats.network;
  $("enabled").checked = stats.enabled;
  $("state").textContent = stats.enabled ? "on" : "paused";
}

async function refresh() {
  const tab = await activeTab();

  if (!tab || !/^https:\/\/app\.miros\.work\//.test(tab.url || "")) {
    $("state").textContent = "";
    showMessage("Open <b>app.miros.work</b> to see what this is doing.");
    return null;
  }

  const stats = await runInPage(tab.id, () =>
    window.__mirosTurbo ? window.__mirosTurbo.stats() : null
  );

  if (!stats) {
    $("state").textContent = "";
    showMessage("Not loaded on this page yet. Reload the tab.");
    return null;
  }

  render(stats);
  return tab;
}

$("enabled").addEventListener("change", async (e) => {
  const tab = await activeTab();
  const on = e.target.checked;
  await runInPage(tab.id, (v) => window.__mirosTurbo.set({ enabled: v }), [on]);
  $("state").textContent = on ? "on" : "paused";
});

$("clear").addEventListener("click", async () => {
  const tab = await activeTab();
  await runInPage(tab.id, () => window.__mirosTurbo.purge());
  const btn = $("clear");
  btn.textContent = "Cleared";
  setTimeout(() => (btn.textContent = "Clear cache"), 1200);
  refresh();
});

refresh();
