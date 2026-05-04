import express from "express";
import axios from "axios";
import https from "https";

const app = express();
app.use(express.json());

// Agent HTTPS untuk mengabaikan self-signed certificate Wazuh (Standar On-Premise)
const agent = new https.Agent({ rejectUnauthorized: false });

// ============================================================================
// 1. Route: Get Agents dari Wazuh Manager (Port 55000)
// ============================================================================
app.post("/api/agents", async (req, res) => {
  const { wazuhUrl, wazuhUser, wazuhPass } = req.body;
  
  if (!wazuhUrl || !wazuhUser || !wazuhPass) {
    return res.status(400).json({ error: "Kredensial Manager tidak lengkap." });
  }

  try {
    // Autentikasi ke Manager API untuk mendapatkan token
    const authRes = await axios.post(`${wazuhUrl}/security/user/authenticate?raw=true`, {}, {
      auth: { username: wazuhUser, password: wazuhPass },
      httpsAgent: agent
    });
    
    const token = authRes.data;

    // Ambil daftar agent aktif
    const agentsRes = await axios.get(`${wazuhUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent: agent
    });

    res.json(agentsRes.data.data.affected_items);
  } catch (err: any) {
    console.error("Manager Error:", err.message);
    res.status(500).json({ error: "Gagal terhubung ke Wazuh Manager." });
  }
});

// ============================================================================
// 2. Route: Get Alerts dari Wazuh Indexer (Port 9200)
// ============================================================================
app.post("/api/alerts", async (req, res) => {
  const { wazuhIndexerUrl, wazuhIndexerUser, wazuhIndexerPass } = req.body;

  if (!wazuhIndexerUrl || !wazuhIndexerUser || !wazuhIndexerPass) {
    return res.status(400).json({ error: "Kredensial Indexer tidak lengkap." });
  }

  try {
    // Query ke Elasticsearch/OpenSearch untuk mencari alert terbaru (Level >= 5)
    const response = await axios.post(`${wazuhIndexerUrl}/wazuh-alerts*/_search`, {
      sort: [{ "timestamp": { "order": "desc" } }],
      size: 20,
      query: {
        range: {
          "rule.level": { "gte": 5 }
        }
      }
    }, {
      auth: { username: wazuhIndexerUser, password: wazuhIndexerPass },
      httpsAgent: agent
    });
    
    const hits = response.data.hits?.hits || [];
    const formattedAlerts = hits.map((hit: any) => ({
      id: hit._id,
      timestamp: hit._source.timestamp,
      rule: hit._source.rule,
      agent: hit._source.agent,
      raw_log: hit._source.full_log || hit._source.rule.description,
      data: hit._source.data || {} // Pastikan node data ikut terbaca untuk Source IP
    }));

    res.json(formattedAlerts);
  } catch (err: any) {
    console.error("Indexer Error:", err.message);
    res.status(500).json({ error: "Gagal menarik data dari Wazuh Indexer." });
  }
});

// ============================================================================
// 3. Route: Kirim Laporan ke Telegram (Format Clean & Professional)
// ============================================================================
app.post("/api/alerts/report", async (req, res) => {
  const { config, alert } = req.body;
  const { telegramToken, telegramChatId } = config;

  if (!telegramToken || !telegramChatId) {
    return res.status(400).json({ error: "Konfigurasi Telegram (Token/ID) kosong." });
  }

  // Coba ambil Source IP dari data alert Wazuh, kalau tidak ada gunakan IP Agent
  const sourceIp = alert.data?.srcip || alert.agent?.ip || "Unknown";

  // Format pesan laporan (Plain Text agar terhindar dari parsing error Markdown)
  const message = `📄 MUSICYBER SECURITY INCIDENT REPORT

Incident ID: ${alert.id.substring(0,8)}
Severity: ${alert.analysis?.severity || "High"}
Target Agent: ${alert.agent?.name || "Unknown"}
Source IP: ${sourceIp}

🔍 AI ANALYSIS:
${alert.analysis?.summary || "No analysis available."}

MITRE Technique: ${alert.analysis?.mitre_attack || "T1110"}

🛡️ RECOMMENDED ACTION:
${alert.analysis?.recommended_action || "Manual investigation required."}

#SecurityAlert #SOC`;

  try {
    const url = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
    await axios.post(url, {
      chat_id: telegramChatId,
      text: message
      // parse_mode sengaja dihilangkan agar teks AI apapun tetap aman dikirim
    });
    res.json({ status: "success" });
  } catch (err: any) {
    console.error("Telegram API Error:", err.response?.data || err.message);
    res.status(500).json({ error: "Gagal mengirim laporan ke Telegram." });
  }
});

// Export aplikasi untuk di-handle oleh Vercel Serverless
export default app;
