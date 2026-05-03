import React, { useState, useEffect } from "react";
import { Shield, Activity, Search, Bot, RefreshCw, LogOut, Send, Settings as SettingsIcon, ExternalLink, Terminal } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import axios from "axios";
import { analyzeAlert } from "./ai_agent";
import { auth, loginWithGoogle, db } from "./firebase";
import { onAuthStateChanged, User as FirebaseUser, signOut } from "firebase/auth";
import { doc, getDoc, setDoc, collection, query, where, getDocs } from "firebase/firestore";

interface AppSettings {
  wazuhUrl: string; wazuhUser: string; wazuhPass: string; wazuhIndexerUrl: string;
  wazuhIndexerUser: string; wazuhIndexerPass: string; telegramToken: string;
  telegramChatId: string; geminiModel: string;
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [selectedAlert, setSelectedAlert] = useState<any | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [logs, setLogs] = useState<string[]>(["[SYSTEM] Dashboard initialized."]);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({
    wazuhUrl: "", wazuhUser: "", wazuhPass: "", wazuhIndexerUrl: "",
    wazuhIndexerUser: "admin", wazuhIndexerPass: "", telegramToken: "", telegramChatId: "", geminiModel: "gemini-3-flash-preview"
  });
  const [agents, setAgents] = useState<any[]>([]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) loadUserSettings(u.uid);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (user && settings.wazuhUrl && settings.wazuhIndexerUrl) {
      const poll = async () => { await fetchAlerts(); await fetchAgents(); };
      poll();
      const interval = setInterval(poll, 15000);
      return () => clearInterval(interval);
    }
  }, [user, settings]);

  const loadUserSettings = async (uid: string) => {
    const snap = await getDoc(doc(db, "users", uid, "settings", "main"));
    if (snap.exists()) setSettings(snap.data() as AppSettings);
  };

  const fetchAgents = async () => {
    try {
      const res = await axios.post("/api/agents", settings);
      if (Array.isArray(res.data)) setAgents(res.data);
    } catch (err) {}
  };

  const fetchAlerts = async () => {
    if (!user) return;
    try {
      const res = await axios.post("/api/alerts", settings);
      const liveAlerts = Array.isArray(res.data) ? res.data : [];
      
      // Simpan ke Firestore dari Frontend untuk menghindari permission denied di Backend
      for (const alert of liveAlerts) {
        await setDoc(doc(db, "wazuh_alerts", alert.id), { ...alert, userId: user.uid }, { merge: true });
      }

      const q = query(collection(db, "wazuh_alerts"), where("userId", "==", user.uid));
      const snap = await getDocs(q);
      setAlerts(snap.docs.map(d => d.data()).sort((a,b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 50));
    } catch (err: any) { 
        setLogs(p => [...p, `[ERROR] Sync failed: ${err.response?.status || "Check Connection"}`]);
    }
  };

  if (!user) return (
    <div className="min-h-screen bg-[#0B0F1A] flex items-center justify-center">
      <button onClick={loginWithGoogle} className="py-4 px-8 bg-white text-black font-bold rounded-xl">Sign in with Google</button>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0B0F1A] text-slate-200 flex flex-col">
      <header className="h-16 border-b border-white/10 flex items-center justify-between px-6">
        <h1 className="font-bold">MUSICIBER SOC AI</h1>
        <div className="flex gap-4">
          <SettingsIcon onClick={() => setShowSettings(true)} className="cursor-pointer" />
          <LogOut onClick={() => signOut(auth)} className="cursor-pointer" />
        </div>
      </header>

      <main className="flex-1 grid grid-cols-12 gap-4 p-4 overflow-hidden">
        <div className="col-span-3 border border-white/10 bg-[#131B2D] p-4 rounded-lg overflow-y-auto">
          <h3 className="text-xs font-bold mb-4">Live Alerts</h3>
          {alerts.map(a => (
            <div key={a.id} onClick={() => setSelectedAlert(a)} className="p-2 mb-2 bg-slate-900 rounded cursor-pointer border-l-2 border-slate-700 hover:border-blue-500">
              <p className="text-[10px] opacity-50">{a.id}</p>
              <p className="text-xs font-bold truncate">{a.rule.description}</p>
            </div>
          ))}
        </div>
        
        <div className="col-span-9 border border-white/10 bg-[#131B2D] p-6 rounded-lg">
          {selectedAlert ? (
            <div>
              <h2 className="text-xl font-bold mb-4">{selectedAlert.id}</h2>
              <pre className="bg-black/50 p-4 rounded text-[10px] overflow-auto max-h-96">{JSON.stringify(selectedAlert, null, 2)}</pre>
            </div>
          ) : <div className="h-full flex items-center justify-center opacity-20"><Search size={40} /></div>}
        </div>
      </main>

      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6">
          <div className="bg-[#131B2D] p-8 rounded-2xl w-full max-w-xl border border-white/10">
            <h2 className="text-xl font-bold mb-6">Agent Configuration</h2>
            <div className="grid gap-4">
              <input className="w-full bg-slate-900 p-3 rounded" placeholder="Manager URL" value={settings.wazuhUrl} onChange={e => setSettings({...settings, wazuhUrl: e.target.value})} />
              <input className="w-full bg-slate-900 p-3 rounded" placeholder="Indexer URL" value={settings.wazuhIndexerUrl} onChange={e => setSettings({...settings, wazuhIndexerUrl: e.target.value})} />
              <div className="flex gap-4">
                <button onClick={async () => {
                  await setDoc(doc(db, "users", user.uid, "settings", "main"), settings);
                  setShowSettings(false);
                }} className="flex-1 py-3 bg-blue-600 rounded-xl font-bold">Save Settings</button>
                <button onClick={() => setShowSettings(false)} className="px-6 py-3 bg-slate-700 rounded-xl">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
