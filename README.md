# MusiCyber: Autonomous Blue Team AI Agent
### *The Intelligent Bridge Between Wazuh and Rapid Incident Response*

MusiCyber is an advanced Security Orchestration, Automation, and Response (SOAR) platform designed specifically for the Wazuh ecosystem. It leverages Google's Gemini Pro AI to transform raw security logs into actionable intelligence, delivering real-time incident reports directly to security teams via Telegram.

---

## 🚀 Key Features

*   **Real-time Wazuh Integration**: Seamlessly connects to your Wazuh Manager API to monitor agents and security events.
*   **AI-Powered Threat Analysis**: Every alert is passed through Gemini Pro, which provides:
    *   **Contextual Summaries**: Explains *why* an alert triggered in plain language.
    *   **MITRE ATT&CK® Mapping**: Automatically identifies the tactical category of the threat.
    *   **Step-by-Step Remediation**: Provides specific commands and actions for the Blue Team to take.
*   **Zero-Trust Dashboard**: A high-tech, "Cyberpunk" themed SOC dashboard for monitoring active signals and agent health.
*   **Telegram Dispatcher**: Instantly notifies stakeholders of critical threats with full AI analysis attached.
*   **Simulated Mode**: Don't have a live Wazuh environment? The engine can generate realistic attack scenarios (Brute force, SQLi, rootkits) for training and demonstration.

---

## 🛠️ How It Works

1.  **Ingestion**: The agent queries the Wazuh API for new high-severity alerts.
2.  **Enrichment**: The raw JSON alert is sent to the Gemini AI engine.
3.  **Reasoning**: Gemini analyzes the source IP, target agent, rule description, and event data.
4.  **Reporting**: A formatted report is generated and pushed to the SOC team's Telegram bot.

---

## ⚙️ Setup Guide

### 1. Telegram Bot Configuration
1.  Message `@BotFather` on Telegram to create a new bot.
2.  Copy your **Bot Token**.
3.  Message your new bot and send `/start`.
4.  The bot will reply with your **Admin Chat ID**.

### 2. Wazuh API Credentials
Ensure your Wazuh API is accessible. You will need:
*   Wazuh Manager URL (e.g., `https://your-wazuh-manager:55000`)
*   API Username (Default: `wazuh`)
*   API Password

### 3. Application Configuration
1.  Launch the MusiCyber app.
2.  Navigate to the **Settings** panel (User Profile icon).
3.  Enter your Wazuh credentials and Telegram details.
4.  Click **"Test Bot"** to verify connectivity.
5.  Click **"Apply Active Configuration"** to start the engine.

---

## 🛡️ About the Ambassador Program
As a Wazuh Ambassador project, MusiCyber aims to lower the barrier to entry for advanced SOC operations. By combining the world's most popular open-source XDR with cutting-edge Generative AI, we empower small security teams to act with the speed and precision of a global enterprise.

---

## 👨‍💻 Developed By
*   **AI Agent**: MusiCyber Autonomous Engine
*   **Powered By**: Wazuh Open Source Security & Google Gemini Pro AI
