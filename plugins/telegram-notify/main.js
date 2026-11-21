// Telegram notify: a message when Claude is done (or waits for you) while you're away.

const folder = (path) => (path ? path.split(/[\\/]/).pop() : "Tern");

async function send(text) {
  const { token, chat } = await tern.settings.all();
  if (!token || !chat) {
    tern.notify("set the bot token and chat id in the plugin's settings");
    return;
  }
  const res = await tern.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    body: { chat_id: chat, text },
  });
  if (!res.ok) tern.notify(`Telegram: ${res.json?.description ?? res.status}`);
}

tern.on("claude:done", async (e) => {
  const s = await tern.settings.all();
  if (s.onlyAway && e.seen) return;
  send(`✅ Claude finished — ${folder(e.project)}`);
});

tern.on("claude:waiting", async (e) => {
  const s = await tern.settings.all();
  if (!s.waiting || (s.onlyAway && e.seen)) return;
  send(`⏳ Claude is waiting for your answer — ${folder(e.project)}`);
});

// Right-click a folder or file in the tree to check the bot works.
tern.addMenuItem({
  label: "Telegram: send a test message",
  onClick: () => send("👋 Test message from Tern"),
});
