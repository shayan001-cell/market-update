// OneView WhatsApp bridge: posts the after-the-close summary to a group as the linked account.
//   node wa.js login                      -> prints a QR (also writes qr.png); scan it in WhatsApp > Linked devices
//   node wa.js groups                     -> lists the groups the account is in
//   node wa.js send "<group name>" <file> -> sends the text in <file> to that group
const path = require("path");
const fs = require("fs");
const { Client, LocalAuth } = require("whatsapp-web.js");
const root = path.resolve(__dirname, "..", "..");
const sessionDir = process.env.MU_WA_SESSION || path.join(root, "output", "wa-session");
const [cmd, arg1, arg2] = process.argv.slice(2);
if (!cmd) { console.error("usage: node wa.js login | groups | send <group> <file>"); process.exit(2); }

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: sessionDir }),
  puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] },
});
const bail = (msg, code = 1) => { console.error(msg); client.destroy().catch(() => {}); process.exit(code); };
setTimeout(() => bail("timeout: WhatsApp did not become ready in time"), cmd === "login" ? 600000 : 180000).unref();

client.on("qr", async (qr) => {
  try {
    require("qrcode-terminal").generate(qr, { small: true });
    await require("qrcode").toFile(path.join(__dirname, "qr.png"), qr, { width: 480, margin: 2 });
    console.log("QR written to tools/whatsapp/qr.png — open WhatsApp on your phone > Linked devices > Link a device, and scan it.");
  } catch (e) { console.error("qr render failed:", e.message); }
});
client.on("auth_failure", (m) => bail("auth failure: " + m));
client.on("ready", async () => {
  await new Promise((r) => setTimeout(r, 4000));
  try {
    const me = client.info && client.info.wid ? client.info.wid.user : "?";
    if (cmd === "login") { console.log("linked as +" + me + "; session saved in " + sessionDir); return bail("", 0); }
    // a group can be named by its invite link (chat.whatsapp.com/<code>) or its id (<digits>@g.us): no chat listing needed
    const inviteCode = (v) => { const m = String(v || "").match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]{10,})/); return m ? m[1] : (/^[A-Za-z0-9_-]{18,}$/.test(String(v || "")) ? v : null); };
    if (cmd === "info") {
      const code = inviteCode(arg1); if (!code) return bail("give an invite link or code");
      const info = await client.getInviteInfo(code);
      const id = info && info.id ? (info.id._serialized || (info.id.user + "@" + info.id.server)) : null;
      console.log(JSON.stringify({ name: info && info.subject, id, size: info && info.size }));
      return bail("", 0);
    }
    if (cmd === "send" && (inviteCode(arg1) || /@g\.us$/.test(String(arg1)))) {
      let id = arg1;
      if (!/@g\.us$/.test(String(arg1))) { const info = await client.getInviteInfo(inviteCode(arg1)); id = info.id._serialized || (info.id.user + "@" + info.id.server); }
      const text = fs.readFileSync(arg2, "utf8");
      await client.sendMessage(id, text);
      console.log(`sent ${text.length} chars to ${id} as +${me}`);
      return setTimeout(() => bail("", 0), 1500);
    }
    const chats = await client.getChats();
    const groups = chats.filter((c) => c.isGroup);
    if (cmd === "groups") { groups.forEach((g) => console.log(`${g.name}  (${g.participants ? g.participants.length : "?"} members)`)); return bail("", 0); }
    if (cmd === "send") {
      const g = groups.find((x) => x.name === arg1) || groups.find((x) => x.name.toLowerCase().includes(String(arg1).toLowerCase()));
      if (!g) return bail("group not found: " + arg1 + " (known: " + groups.map((x) => x.name).join(" | ") + ")");
      const text = fs.readFileSync(arg2, "utf8");
      await g.sendMessage(text);
      console.log(`sent ${text.length} chars to "${g.name}" as +${me}`);
      setTimeout(() => bail("", 0), 1500);
    }
  } catch (e) { bail("error: " + (e && e.stack ? e.stack : e)); }
});
client.initialize();
