// OneView WhatsApp bridge on Baileys (no browser): login by QR, list groups, send to groups by name or id.
//   node wab.js login                          -> writes qr.png; scan in WhatsApp > Linked devices
//   node wab.js groups                         -> "<id>\t<name>\t<members>" for every group the account is in
//   node wab.js send "<id|name>[,<id|name>...]" <file>
//   node wab.js resolve "<invite link>"        -> group id + name
const path = require("path"), fs = require("fs");
const P = require("pino");
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, jidNormalizedUser } = require("@whiskeysockets/baileys");
const root = path.resolve(__dirname, "..", "..");
const authDir = process.env.MU_WA_AUTH || path.join(root, "output", "wa-baileys");
const [cmd, arg1, arg2] = process.argv.slice(2);
if (!cmd) { console.error("usage: node wab.js login | groups | send <targets> <file> | resolve <invite>"); process.exit(2); }
const logger = P({ level: "silent" });

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false, browser: ["OneView", "Desktop", "1.0"], syncFullHistory: false, markOnlineOnConnect: false, qrTimeout: 180000 });
  sock.ev.on("creds.update", saveCreds);
  const deadline = setTimeout(() => { console.error("timeout: not connected in time"); process.exit(1); }, cmd === "login" ? 600000 : 120000);
  let done = false;
  sock.ev.on("connection.update", async (u) => {
    if (u.qr) {
      try { await require("qrcode").toFile(path.join(__dirname, "qr.png"), u.qr, { width: 480, margin: 2 }); console.log("QR written to tools/whatsapp/qr.png"); } catch (e) { console.error("qr:", e.message); }
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output ? u.lastDisconnect.error.output.statusCode : undefined;
      if (done) return;
      if (code === DisconnectReason.loggedOut) { console.error("logged out: run login again"); process.exit(1); }
      if (code === DisconnectReason.restartRequired || code === 515) { return main(); }   // normal after a fresh pairing
      console.error("connection closed: " + code); process.exit(1);
    }
    if (u.connection !== "open") return;
    try {
      const me = jidNormalizedUser(sock.user && sock.user.id);
      if (cmd === "login") { console.log("linked as " + me + "; auth saved in " + authDir); done = true; clearTimeout(deadline); setTimeout(() => process.exit(0), 1500); return; }
      const groups = await sock.groupFetchAllParticipating();
      const list = Object.values(groups).map((g) => ({ id: g.id, name: g.subject || "", n: (g.participants || []).length }));
      if (cmd === "groups") { list.sort((a, b) => a.name.localeCompare(b.name)).forEach((g) => console.log(`${g.id}\t${g.name}\t${g.n}`)); done = true; clearTimeout(deadline); setTimeout(() => process.exit(0), 800); return; }
      if (cmd === "resolve") {
        const m = String(arg1 || "").match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]{10,})/); const code = m ? m[1] : arg1;
        const info = await sock.groupGetInviteInfo(code); console.log(JSON.stringify({ id: info.id, name: info.subject, n: info.size }));
        done = true; clearTimeout(deadline); setTimeout(() => process.exit(0), 800); return;
      }
      if (cmd === "send") {
        const text = fs.readFileSync(arg2, "utf8");
        const targets = String(arg1 || "").split(",").map((x) => x.trim()).filter(Boolean);
        let ok = 0;
        for (const t of targets) {
          let jid = null;
          if (/@(g\.us|s\.whatsapp\.net|c\.us)$/.test(t)) jid = t.replace(/@c\.us$/, "@s.whatsapp.net");
          else if (/^\+?\d{8,15}$/.test(t)) { const r = await sock.onWhatsApp(t.replace(/\D/g, "")); jid = r && r[0] && r[0].exists ? r[0].jid : null; }
          else { const g = list.find((x) => x.name === t) || list.find((x) => x.name.toLowerCase().includes(t.toLowerCase())); jid = g ? g.id : null; }
          if (!jid) { console.error(`not found: ${t}`); continue; }
          try {
            const sent = await sock.sendMessage(jid, { text });
            if (sent && sent.key && sent.key.id) { ok += 1; console.log(`sent ${text.length} chars to ${jid} (${sent.key.id})`); } else console.error(`no confirmation for ${jid}`);
          } catch (e) { console.error(`failed for ${jid}: ${e.message}`); }
          await new Promise((r) => setTimeout(r, 2500));
        }
        done = true; clearTimeout(deadline); setTimeout(() => process.exit(ok ? 0 : 1), 2500); return;
      }
    } catch (e) { console.error("error: " + (e && e.stack ? e.stack : e)); process.exit(1); }
  });
}
main();
