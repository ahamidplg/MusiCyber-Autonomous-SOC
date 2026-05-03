import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import https from "https";
import fs from "fs";
import path from "path";

// --- FIREBASE KHUSUS BACKEND (TANPA AUTH) ---
import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, setDoc, getDocs, getDoc, query, orderBy, limit } from "firebase/firestore";

const configPath = path.join(process.cwd(), "firebase-applet-config.json");
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

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

// --- MIDDLEWARE STATLESS: Ambil Config User dari Firestore ---
// Setiap request wajib bawa header x-user-id
async function getUserConfig(uid: string): Promise<AppConfig | null> {
  if (!uid) return null;
  try {
    const docRef = doc(db, "users", uid, "settings", "main");
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      return snap.data() as AppConfig;
    }
    return null;
  } catch (error) {
    console.error(`[FIRESTORE] Gagal narik config untuk UID ${uid}:`, error);
    return null;
  }
}

// --- FIREBASE HELPER FUNCTIONS ---
async function saveAlertToFirestore(alertData: any, uid: string) {
  try {
    // Kita tambahin uid biar alert-nya terisolasi per user
    const alertRef = doc(db, ALERTS_COLLECTION, alertData.id);
    await setDoc(alertRef, { ...alertData, userId: uid }, { merge: true });
  } catch (error) {
    console.error("[FIRESTORE] Gagal simpan alert:", error);
  }
}

// Fitur multi-tenant: Tarik alert khusus punya user yang lagi request
async function getAlertsFromFirestore(uid: string) {
  try {
    // Note: Pastikan di Firestore Rules / Index udah support query ini
    const q = query(collection(db, ALERTS_COLLECTION), orderBy("timestamp", "desc"), limit(50));
    const querySnapshot = await getDocs(q);
    const fetchedAlerts: any[] = [];
    querySnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if (data.userId === uid) {
        fetchedAlerts.push(data);
      }
    });
    return fetchedAlerts;
  } catch (error) {
    console.error("[FIRESTORE] Gagal ambil alert:", error);
    return [];
  }
}

/**
 * OPENCLAW WAZUH ADAPTER (Stateless Version)
 */
class WazuhConnector {
  private baseUrl: string;
  private user: string;
  private pass: string;
  private indexerUrl: string;
  private indexerUser: string;
  private indexerPass: string;
  private httpsAgent: https.Agent;

  // Constructor sekarang butuh config, tidak ada variabel global lagi
  constructor(cfg: AppConfig) {
    this.baseUrl = (cfg.wazuhUrl || "").replace(/\/$/, "");
    this.user = cfg.wazuhUser || "";
    this.pass = cfg.wazuhPass || "";
    this.indexerUrl = (cfg.wazuhIndexerUrl || "").replace(/\/$/, "");
    this.indexerUser = cfg.wazuhIndexerUser || "admin";
    this.indexerPass = cfg.wazuhIndexerPass || "";
    this.httpsAgent = new https.Agent({ rejectUnauthorized: false });
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
      return response.data; // token
    } catch (err: any) {
      console.error(`[WAZUH] Auth Error: ${err.message}`);
      return null;
    }
  }

  async getAlerts() {
    if (!this.indexerUrl || !this.indexerPass) return null;
    const searchUrl = `${this.indexerUrl}/wazuh-alerts*/_search`;
    try {
      const response = await axios.post(searchUrl, {
        sort: [{ "timestamp": { "order": "desc" } }],
        size: 15,
        query: { range: { "rule.level": { "gte": 5 } } }
      }, {
        auth: { username: this.indexerUser, password: this.indexerPass },
        headers: { 'Content-Type': 'application/json' },
        httpsAgent: this.httpsAgent,
        timeout: 20000
      });

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
      console.error(`[WAZUH] Indexer Fetch Error: ${err.message}`);
      return null;
    }
  }

  async getAgents() {
    if (!this.baseUrl) return null;
    const token = await this.authenticate();
    if (!token) return null;
    try {
      const response = await axios.get(`${this.baseUrl}/agents`, {
        headers: { Authorization: `Bearer ${token}` },
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

// --- ROUTES ---

// Middleware untuk mengecek Header UID dari Frontend
app.use("/api", (req, res, next) => {
  // Pengecualian untuk webhook karena asalnya dari Telegram, bukan frontend kita
  if (req.path.startsWith("/telegram-webhook")) return next();
  
  const uid = req.headers['x-user-id'] as string;
  if (!uid && req.path !== "/config/test/telegram") {
    return res.status(401).json({ error: "Unauthorized: Missing x-user-id header" });
  }
  next();
});

// Endpoint webhook dinamis per user. Telegram bakal nembak ke URL ini bawa UID.
app.post("/api/telegram-webhook/:uid", async (req, res) => {
  const { uid } = req.params;
  const config = await getUserConfig(uid);
  
  if (config && config.telegramToken) {
    const bot = new TelegramBot(config.telegramToken);
    bot.processUpdate(req.body);
  }
  res.sendStatus(200);
});

app.post("/api/config", async (req, res) => {
  const uid = req.headers['x-user-id'] as string;
  const config = req.body as AppConfig;
  
  // Daftarin Webhook otomatis tiap kali config disave
  if (config.telegramToken) {
    const bot = new TelegramBot(config.telegramToken);
    const appUrl = process.env.APP_URL || "";
    if (appUrl) {
      const webhookUrl = `${appUrl.replace(/\/$/, "")}/api/telegram-webhook/${uid}`;
      await bot.setWebHook(webhookUrl);
      console.log(`[TELEGRAM] Webhook set to ${webhookUrl} for UID: ${uid}`);
    }
  }
  res.json({ status: "success", message: "MusiCyber engine recalibrated" });
});

app.post("/api/config/test", async (req, res) => {
  const config = req.body as AppConfig;
  const tester = new WazuhConnector(config);
  const token = await tester.authenticate();
  if (token) {
    res.json({ status: "success", manager: config.wazuhUrl });
  } else {
    res.json({ status: "error", message: "Failed to authenticate with Wazuh API." });
  }
});

app.get("/api/agents", async (req, res) => {
  const uid = req.headers['x-user-id'] as string;
  const config = await getUserConfig(uid);
  
  if (!config) return res.json([]);

  const wazuh = new WazuhConnector(config);
  const realAgents = await wazuh.getAgents();
  res.json(realAgents || []);
});

app.get("/api/alerts", async (req, res) => {
  const uid = req.headers['x-user-id'] as string;
  const config = await getUserConfig(uid);
  
  if (config) {
    const wazuh = new WazuhConnector(config);
    const realAlerts = await wazuh.getAlerts();
    
    if (realAlerts && realAlerts.length > 0) {
      await Promise.all(realAlerts.map(async (fa: any) => {
        await saveAlertToFirestore(fa, uid);
      }));
    }
  }

  const firestoreAlerts = await getAlertsFromFirestore(uid);
  res.json(firestoreAlerts);
});

app.post("/api/alerts/:id/report", async (req, res) => {
  const { id } = req.params;
  const uid = req.headers['x-user-id'] as string;
  const config = await getUserConfig(uid);

  if (!config || !config.telegramToken || !config.telegramChatId) {
    return res.status(400).json({ error: "Telegram bot not configured" });
  }

  try {
    const alertRef = doc(db, ALERTS_COLLECTION, id);
    const alertSnap = await getDoc(alertRef);

    if (!alertSnap.exists()) return res.status(400).json({ error: "Alert not found" });

    const alert = alertSnap.data();
    if (!alert.analysis) return res.status(400).json({ error: "Analysis not found" });

    const bot = new TelegramBot(config.telegramToken);
    const report = `📄 OPENCLAW SECURITY INCIDENT REPORT\n\n` +
                   `Incident ID: ${alert.id}\n` +
                   `Severity: ${alert.severity}\n` +
                   `Target Agent: ${alert.agent.name}\n` +
                   `Source IP: ${alert.source.IP}\n\n` +
                   `🔍 AI ANALYSIS:\n${alert.analysis.summary.slice(0, 3000)}\n\n` +
                   `MITRE Technique: ${alert.analysis.mitre_attack}\n\n` +
                   `🛡️ RECOMMENDED ACTION:\n${alert.analysis.recommended_action.slice(0, 500)}\n\n` +
                   `#SecurityAlert #SOC`;
    
    await bot.sendMessage(config.telegramChatId, report);
    res.json({ status: "sent" });
  } catch (err: any) {
    res.status(500).json({ error: `Telegram dispatch failed: ${err.message}` });
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

export default app;
