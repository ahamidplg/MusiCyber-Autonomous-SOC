import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import TelegramBot from "node-telegram-bot-api";
import { fileURLToPath } from "url";
import axios from "axios";
import https from "https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

interface AppConfig {
  wazuhUrl: string;
  wazuhUser: string;
  wazuhPass: string;
  wazuhIndexerUrl: string;
  wazuhIndexerUser: string;
  wazuhIndexerPass: string;
  telegramToken: string;
  telegramChatId: string;
  geminiModel: string;
}

/**
 * OPENCLAW WAZUH ADAPTER
 * Logic to fetch real alerts from a Wazuh Manager API with dynamic config
 */
class WazuhConnector {
  private baseUrl: string = "";
  private user: string = "";
  private pass: string = "";
  private indexerUrl: string = "";
  private indexerUser: string = "";
  private indexerPass: string = "";
  private token: string | null = null;
  private httpsAgent: https.Agent;

  constructor() {
    this.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }

  updateConfig(cfg: AppConfig) {
    this.baseUrl = (cfg.wazuhUrl || "").replace(/\/$/, "");
    this.user = cfg.wazuhUser || "";
    this.pass = cfg.wazuhPass || "";
    
    this.indexerUrl = (cfg.wazuhIndexerUrl || "").replace(/\/$/, "");
    this.indexerUser = cfg.wazuhIndexerUser || "admin";
    this.indexerPass = cfg.wazuhIndexerPass || "";
    
    this.token = null; 
    console.log(`[OPENCLAW] SIEM Config Updated. API: ${this.baseUrl} | Indexer: ${this.indexerUrl}`);
  }

  async authenticate() {
    if (!this.baseUrl || !this.user) return null;
    const authUrl = `${this.baseUrl}/security/user/authenticate?raw=true`;
    try {
      const response = await axios.post(authUrl, {}, {
        auth: { username: this.user, password: this.pass },
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
        httpsAgent: this.httpsAgent
      });
      this.token = response.data; // With raw=true, the token is the body string
      console.log(`[WAZUH] Authenticated successfully via ${authUrl}`);
      
      // Also get manager info to see version
      const info = await axios.get(`${this.baseUrl}/manager/info`, {
        headers: { Authorization: `Bearer ${this.token}` },
        httpsAgent: this.httpsAgent
      });
      console.log(`[WAZUH] Connected to Wazuh Manager: ${info.data.data.name} v${info.data.data.version}`);
      
      return this.token;
    } catch (err: any) {
      console.error(`[WAZUH] Auth/Info Error: ${err.message} URL: ${authUrl}`);
      return null;
    }
  }

  async getAlerts() {
    if (!this.indexerUrl || !this.indexerPass) {
      console.log("[WAZUH] Indexer not configured. Skipping fetch.");
      return null;
    }

    const searchUrl = `${this.indexerUrl}/wazuh-alerts*/_search`;
    try {
      const response = await axios.post(searchUrl, {
        sort: [{ "timestamp": { "order": "desc" } }],
        size: 15,
        query: {
          range: { "rule.level": { "gte": 5 } } // Level 5 and up
        }
      }, {
        auth: { username: this.indexerUser, password: this.indexerPass },
        headers: { 'Content-Type': 'application/json' },
        httpsAgent: this.httpsAgent,
        timeout: 20000
      });

      console.log(`[WAZUH] Indexer query successful: ${response.data.hits?.total?.value || 0} hits found.`);
      
      const hits = response.data.hits?.hits || [];
      return hits.map((hit: any) => {
        const source = hit._source;
        return {
          id: hit._id,
          timestamp: source.timestamp,
          rule: source.rule,
          agent: source.agent,
          source: { IP: source.data?.srcip || source.data?.dstip || "Local" },
          severity: source.rule.level >= 12 ? "Critical" : source.rule.level >= 10 ? "High" : "Medium",
          status: "Pending",
          raw_log: source.full_log || source.rule.description
        };
      });
    } catch (err: any) {
      if (err.code === 'ECONNABORTED') {
        console.error(`[WAZUH] Indexer Timeout (20s): Is the indexer reachable at ${searchUrl}?`);
      } else if (err.response) {
        console.error(`[WAZUH] Indexer HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
      } else {
        console.error(`[WAZUH] Indexer Fetch Error: ${err.message}`);
      }
      return null;
    }
  }

  async getAgents() {
    if (!this.baseUrl) return null;
    if (!this.token) await this.authenticate();
    if (!this.token) return null;
    try {
      const response = await axios.get(`${this.baseUrl}/agents`, {
        headers: { Authorization: `Bearer ${this.token}` },
        httpsAgent: this.httpsAgent,
        timeout: 5000
      });
      return response.data.data.affected_items;
    } catch (err: any) {
      console.error(`[WAZUH] Agents Fetch Error: ${err.message}`);
      return null;
    }
  }
}

const wazuh = new WazuhConnector();
let bot: TelegramBot | null = null;
let currentTelegramToken = "";
let currentAdminChatId = "";

const updateTelegramBot = async (token: string, chatId: string) => {
  const trimmedChatId = chatId ? chatId.trim() : "";
  if (!token || token === currentTelegramToken) {
    currentAdminChatId = trimmedChatId;
    return;
  }

  if (bot) {
    try {
      await bot.stopPolling();
    } catch (e) {
      console.warn("Error stopping bot polling:", e);
    }
  }

  try {
    bot = new TelegramBot(token, { polling: true });
    currentTelegramToken = token;
    currentAdminChatId = trimmedChatId;
    console.log(`[TELEGRAM] Bot re-initialized. Admin ID: ${trimmedChatId || "NOT SET"}`);

    bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
      bot?.sendMessage(chatId, `🚀 MusiCyber SOC Bot Activated!\n\nYour Admin Chat ID is: ${chatId}\n\nCopy this ID into your settings to receive incident reports.`);
    });

    bot.onText(/\/status/, (msg) => {
      const chatId = msg.chat.id;
      bot?.sendMessage(chatId, `🛡️ MusiCyber Security Engine: ACTIVE\nStatus: CALIBRATED\nMonitoring: ${wazuh ? "CONNECTED" : "SIMULATED"}`);
    });
  } catch (err) {
    console.error("Failed to init bot:", (err as Error).message);
  }
};

// In-memory data store for the alerts
let alerts: any[] = [
  {
    id: "WAZ-5712",
    timestamp: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
    rule: { id: "5712", level: 10, description: "sshd: brute force attempt." },
    agent: { id: "001", name: "linux-server-prod" },
    source: { IP: "192.168.1.104" },
    severity: "High",
    status: "Pending",
    raw_log: "May 03 12:45:00 linux-server-prod sshd[1234]: Failed password for root from 192.168.1.104 port 54321 ssh2",
  },
  {
    id: "WAZ-2004",
    timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    rule: { id: "2004", level: 12, description: "Malware signature matching: mimikatz" },
    agent: { id: "042", name: "ws-marketing-01" },
    source: { IP: "10.0.0.12" },
    severity: "Critical",
    status: "Pending",
    raw_log: "Suspicious file 'mimikatz.exe' detected in C:\\Users\\User\\Downloads. Hash match with known credential dumper.",
  }
];

// Config Sync Route
app.post("/api/config", async (req, res) => {
  const config = req.body as AppConfig;
  wazuh.updateConfig(config);
  await updateTelegramBot(config.telegramToken, config.telegramChatId);
  res.json({ status: "success", message: "MusiCyber engine recalibrated" });
});

app.post("/api/config/test", async (req, res) => {
  const config = req.body as AppConfig;
  const tester = new WazuhConnector();
  tester.updateConfig(config);
  const token = await tester.authenticate();
  if (token) {
    res.json({ status: "success", manager: config.wazuhUrl });
  } else {
    res.json({ status: "error", message: "Failed to authenticate with Wazuh API. Check URL/User/Pass and Port 55000." });
  }
});

app.post("/api/config/test/telegram", async (req, res) => {
  const { token, chatId } = req.body;
  if (!token || !chatId) {
    return res.status(400).json({ status: "error", message: "Token and Chat ID are required." });
  }

  const testBot = new TelegramBot(token);
  try {
    await testBot.sendMessage(chatId.trim(), "🔔 MusiCyber SOC Connectivity Test:\n\nIf you see this message, your Telegram configuration is valid and active.");
    res.json({ status: "success", message: "Test message sent successfully!" });
  } catch (err: any) {
    console.error(`[TELEGRAM TEST] Failed: ${err.message}`);
    let msg = err.message;
    if (msg.includes("chat not found")) {
      msg = "Chat not found. Did you send /start to the bot first?";
    } else if (msg.includes("401")) {
      msg = "Unauthorized. Is your bot token correct?";
    }
    res.status(500).json({ status: "error", message: msg });
  }
});

app.get("/api/agents", async (req, res) => {
  const realAgents = await wazuh.getAgents();
  if (realAgents) {
    res.json(realAgents);
  } else {
    res.json([]);
  }
});

// API Routes
app.get("/api/alerts", async (req, res) => {
  const realAlerts = await wazuh.getAlerts();
  if (realAlerts) {
    // Indexer returns them in our format mostly, but we ensure consistency
    realAlerts.forEach((fa: any) => {
      // Avoid duplicates based on timestamp and rule ID
      if (!alerts.find(ea => ea.timestamp === fa.timestamp && ea.rule.id === fa.rule.id)) {
        alerts.push(fa);
      }
    });
  }
  // Sort and limit in-memory list
  const sorted = [...alerts].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  res.json(sorted.slice(0, 50));
});

app.post("/api/alerts/:id/report", async (req, res) => {
  const { id } = req.params;
  const alert = alerts.find(a => a.id === id);
  if (!alert || !alert.analysis) {
    return res.status(400).json({ error: "Alert or analysis not found" });
  }

  if (bot && currentAdminChatId) {
    const report = `📄 OPENCLAW SECURITY INCIDENT REPORT\n\n` +
                   `Incident ID: ${alert.id}\n` +
                   `Severity: ${alert.severity}\n` +
                   `Target Agent: ${alert.agent.name}\n` +
                   `Source IP: ${alert.source.IP}\n\n` +
                   `🔍 AI ANALYSIS:\n${alert.analysis.summary.slice(0, 3000)}\n\n` +
                   `MITRE Technique: ${alert.analysis.mitre_attack}\n\n` +
                   `🛡️ RECOMMENDED ACTION:\n${alert.analysis.recommended_action.slice(0, 500)}\n\n` +
                   `#SecurityAlert #SOC`;
    
    try {
      await bot.sendMessage(currentAdminChatId, report);
      res.json({ status: "sent" });
    } catch (err: any) {
      console.error(`[TELEGRAM] Dispatch Failed: ${err.message}`);
      let errorMessage = `Telegram dispatch failed: ${err.message}`;
      
      if (err.message.includes("chat not found")) {
        errorMessage = "Telegram Error: Chat not found. You MUST send /start to your bot first, then copy the numeric ID it gives you into the settings.";
      }
      
      if (err.response && err.response.body) {
        console.error(`[TELEGRAM] Response Body: ${JSON.stringify(err.response.body)}`);
      }
      res.status(500).json({ error: errorMessage });
    }
  } else {
    res.status(400).json({ error: "Telegram bot not configured" });
  }
});

app.patch("/api/alerts/:id", (req, res) => {
  const { id } = req.params;
  const { status, analysis } = req.body;
  const alertIndex = alerts.findIndex(a => a.id === id);
  if (alertIndex > -1) {
    alerts[alertIndex] = { ...alerts[alertIndex], status, analysis };
    res.json(alerts[alertIndex]);
  } else {
    res.status(404).json({ error: "Alert not found" });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
