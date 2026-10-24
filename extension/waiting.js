"use strict";
const msg = document.getElementById("msg");
let timer = null;

async function tryNext() {
  const res = await chrome.runtime.sendMessage({ type: "session:next" });
  if (!res.ok) { msg.textContent = res.error; return; }
  const d = res.data;
  if (d.done) { msg.textContent = d.message; return; }
  if (d.opened) return;
  const tick = () => {
    const left = Math.max(0, Math.ceil(d.waitUntil - Date.now() / 1000));
    msg.textContent = left > 0
      ? `${d.next.title || "Next listing"} · ${d.next.company || ""} unlocks in ${left}s (${d.reason}).`
      : "Opening…";
    if (left > 0) timer = setTimeout(tick, 1000);
    else tryNext();
  };
  clearTimeout(timer);
  tick();
}
tryNext();
