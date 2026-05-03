import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import https from "https";

const app = express();
app.use(express.json());

// Agent HTTPS untuk mengabaikan self-signed cert Wazuh
const agent = new https.Agent({ rejectUnauthorized: false });

// Route: Get Agents dari Manager (Port 55000)
app.post("/api/agents", async (req, res) => {
  const { wazuhUrl, wazuhUser, wazuhPass } = req.body;
  try {
    const authRes = await axios.post(`${wazuhUrl}/security/user/authenticate?raw=true`, {}, {
      auth: { username: wazuhUser, password: wazuhPass },
      httpsAgent: agent
    });
    const token = authRes.data;
    const agentsRes = await axios.get(`${wazuhUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent: agent
    });
    res.json(agentsRes.data.data.affected_items);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Route: Get Alerts dari Indexer (Port 9200)
app.post("/api/alerts", async (req, res) => {
  const { wazuhIndexerUrl, wazuhIndexerUser, wazuhIndexerPass } = req.body;
  try {
    const response = await axios.post(`${wazuhIndexerUrl}/wazuh-alerts*/_search`, {
      sort: [{ "timestamp": { "order": "desc" } }],
      size: 15,
      query: { range: { "rule.level": { "gte": 5 } } }
    }, {
      auth: { username: wazuhIndexerUser, password: wazuhIndexerPass },
      httpsAgent: agent
    });
    
    const hits = response.data.hits?.hits || [];
    res.json(hits.map((hit: any) => ({
      id: hit._id,
      timestamp: hit._source.timestamp,
      rule: hit._source.rule,
      agent: hit._source.agent,
      raw_log: hit._source.full_log || hit._source.rule.description
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default app;
