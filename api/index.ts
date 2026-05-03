import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import https from "https";

// --- FIREBASE KHUSUS BACKEND (TANPA AUTH) ---
import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, setDoc, getDocs, getDoc, query, orderBy, limit } from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";

// Inisialisasi Firebase App murni untuk database (bisa jalan di Serverless Node.js)
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

const app = express();
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

const ALERTS_COLLECTION = "wazuh_alerts";

// --- FIREBASE HELPER FUNCTIONS ---
async function saveAlertToFirestore(alertData: any) {
  try {
    const alertRef = doc(db, ALERTS_COLLECTION, alertData.id);
    await setDoc(alertRef, alertData, { merge: true });
  } catch (error) {
    console.error("[FIRESTORE] Gagal simpan alert:", error);
  }
}

async function getAlertsFromFirestore() {
  try {
    const q = query(collection(db, ALERTS_COLLECTION), orderBy("timestamp", "desc"), limit(50));
    const querySnapshot = await getDocs(q);
    const fetchedAlerts: any[] = [];
    querySnapshot.forEach((docSnap) => {
      fetchedAlerts.push(docSnap.data());
    });
    return fetchedAlerts;
  } catch (error) {
    console.error("[FIRESTORE] Gagal ambil alert:", error);
    return [];
  }
}

/**
 * OPENCLAW WAZUH ADAPTER
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
      this.token = response.data;
      console.log(`[WAZUH] Authenticated successfully via ${authUrl}`);
      
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

  try {
    // Mode Webhook (tanpa polling) untuk Vercel Serverless
    bot = new TelegramBot(token);
    currentTelegramToken = token;
    currentAdminChatId = trimmedChatId;

    // Pastikan APP_URL lo udah terisi di Environment Variables Vercel
    const appUrl = process.env.APP_URL || ""; 
    if (appUrl) {
      const webhookUrl = `${appUrl.replace(/\/$/, "")}/api/telegram-webhook`;
      await bot.setWebHook(webhookUrl);
      console.log(`[TELEGRAM] Webhook set to ${webhookUrl}. Admin ID: ${trimmedChatId || "NOT SET"}`);
    } else {
      console.warn("[TELEGRAM] Warning: APP_URL environment variable is missing. Webhook not set.");
    }

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

// --- ROUTES ---

// Endpoint khusus untuk menerima update dari Telegram
app.post("/api/telegram-webhook", (req, res) => {
  if (bot) {
    bot.processUpdate(req.body);
  }
  res.sendStatus(200);
});

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
    let msg = err.message;
    if (msg.includes("chat not found")) msg = "Chat not found. Did you send /start to the bot first?";
    else if (msg.includes("401")) msg = "Unauthorized. Is your bot token correct?";
    res.status(500).json({ status: "error", message: msg });
  }
});

app.get("/api/agents", async (req, res) => {
  const realAgents = await wazuh.getAgents();
  res.json(realAgents || []);
});

app.get("/api/alerts", async (req, res) => {
  const realAlerts = await wazuh.getAlerts();
  
  if (realAlerts && realAlerts.length > 0) {
    // Simpan semua alert baru ke Firestore secara paralel
    await Promise.all(realAlerts.map(async (fa: any) => {
      await saveAlertToFirestore(fa);
    }));
  }

  // Tarik dan kirim data dari Firestore
  const firestoreAlerts = await getAlertsFromFirestore();
  res.json(firestoreAlerts);
});

app.post("/api/alerts/:id/report", async (req, res) => {
  const { id } = req.params;
  
  try {
    const alertRef = doc(db, ALERTS_COLLECTION, id);
    const alertSnap = await getDoc(alertRef);

    if (!alertSnap.exists()) {
      return res.status(400).json({ error: "Alert not found in database" });
    }

    const alert = alertSnap.data();

    if (!alert.analysis) {
      return res.status(400).json({ error: "Analysis not found" });
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
        res.status(500).json({ error: `Telegram dispatch failed: ${err.message}` });
      }
    } else {
      res.status(400).json({ error: "Telegram bot not configured" });
    }
  } catch (error) {
    res.status(500).json({ error: "Internal server error reading from Firestore" });
  }
});

app.patch("/api/alerts/:id", async (req, res) => {
  const { id } = req.params;
  const { status, analysis } = req.body;
  
  try {
    const alertRef = doc(db, ALERTS_COLLECTION, id);
    const alertSnap = await getDoc(alertRef);

    if (alertSnap.exists()) {
      const currentAlert = alertSnap.data();
      const updatedAlert = { ...currentAlert, status, analysis };
      
      await setDoc(alertRef, updatedAlert);
      res.json(updatedAlert);
    } else {
      res.status(404).json({ error: "Alert not found in database" });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to update alert" });
  }
});

// EKSPOR APP UNTUK VERCEL SERVERLESS
export default app;
