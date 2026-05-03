import React, { useState, useEffect } from "react";
import { Shield, Activity, Search, Bot, RefreshCw, LogOut, Send, Settings as SettingsIcon, ExternalLink, Terminal } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import axios from "axios";
import { analyzeAlert } from "./ai_agent";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { auth, loginWithGoogle, db } from "./firebase";
import { onAuthStateChanged, User as FirebaseUser, signOut } from "firebase/auth";
import { doc, getDoc, setDoc, collection, query, where, getDocs } from "firebase/firestore";

function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

interface AppSettings {
  wazuhUrl: string; wazuhUser: string; wazuhPass: string; wazuhIndexerUrl: string;
  wazuhIndexerUser: string; wazuhIndexerPass: string; telegramToken: string;
  telegramChatId: string; geminiModel: string;
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [selectedAlert, setSelectedAlert] = useState<any | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [logs, setLogs] = useState<string[]>(["[SYSTEM] SOC Dashboard initialized."]);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({
    wazuhUrl: "", wazuhUser: "", wazuhPass: "", wazuhIndexerUrl: "",
    wazuhIndexerUser: "admin", wazuhIndexerPass: "", telegramToken: "", telegramChatId: "", geminiModel: "gemini-3-flash-preview"
  });
  const [agents, setAgents] = useState<any[]>([]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
      if (u) loadUserSettings(u.uid);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (user && settings.wazuhUrl && settings.wazuhIndexerUrl) {
      const runPoll = async () => { await fetchAlerts(); await fetchAgents(); };
      runPoll();
      const interval = setInterval(runPoll, 15000);
      return () => clearInterval(interval);
    }
  }, [user, settings]);

  const addLog = (msg: string) => setLogs(p => [...p.slice(-10), `${new Date().toLocaleTimeString()} ${msg}`]);

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
      
      // Frontend menyimpan ke Firestore (Menghindari Permission Denied di Backend)
      for (const alert of liveAlerts) {
        await setDoc(doc(db, "wazuh_alerts", alert.id), { ...alert, userId: user.uid }, { merge: true });
      }

      const q = query(collection(db, "wazuh_alerts"), where("userId", "==", user.uid));
      const snap = await getDocs(q);
      setAlerts(snap.docs.map(d => d.data()).sort((a,b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 50));
    } catch (err: any) { addLog(`[ERROR] Alert Sync: ${err.response?.status || "404/Network"}`); }
  };

  const runAnalysis = async (alert: any) => {
    if (alert.analysis || !user) return;
    setIsAnalyzing(true);
    try {
      const result = await analyzeAlert(alert.raw_log);
      await setDoc(doc(db, "wazuh_alerts", alert.id), { status: "Analyzed", analysis: result }, { merge: true });
      addLog(`[AGENT] Analisis selesai.`);
      fetchAlerts();
    } catch (err) { addLog(`[ERROR] AI Engine timeout.`); } 
    finally { setIsAnalyzing(false); }
  };

  if (authLoading) return <div className="min-h-screen bg-[#0B0F1A] flex items-center justify-center"><RefreshCw className="text-blue-500 animate-spin"/></div>;

  if (!user) return (
    <div className="min-h-screen bg-[#0B0F1A] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-[#131B2D] border border-white/10 rounded-2xl p-8 text-center">
        <Shield className="w-16 h-16 text-blue-600 mx-auto mb-6"/>
        <h1 className="text-2xl font-bold text-white mb-8">MusiCyber SOC AI</h1>
        <button onClick={loginWithGoogle} className="w-full py-4 bg-white text-black font-bold rounded-xl flex items-center justify-center gap-3">
          Sign in with Google
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0B0F1A] text-slate-200 flex flex-col">
      <header className="h-16 border-b border-white/10 flex items-center justify-between px-6 bg-[#0B0F1A]/80 backdrop-blur-md">
        <div className="flex items-center gap-3"><Shield className="text-blue-600"/><h1 className="font-bold uppercase">MusiCyber SOC AI</h1></div>
        <div className="flex items-center gap-4">
          <SettingsIcon className="cursor-pointer text-blue-400" onClick="{()"> setShowSettings(true)} />
          <LogOut className="cursor-pointer text-red-400" onClick="{()"> signOut(auth)} />
        </div>
      </header>

      <main className="flex-1 grid grid-cols-12 gap-4 p-4 overflow-hidden">
        <section className="col-span-3 border border-white/10 bg-[#131B2D] rounded-lg p-4 flex flex-col overflow-hidden">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase mb-4">Live Alert Feed</h3>
          <div className="flex-1 overflow-y-auto space-y-2">
            {alerts.map(a => (
              <div key={a.id} onClick={() => setSelectedAlert(a)} className={cn("p-3 rounded border-l-2 cursor-pointer bg-slate-900/30 border-slate-700", selectedAlert?.id === a.id && "border-blue-500 bg-blue-600/10")}>
                <p className="text-[10px] font-mono text-slate-400">{a.id}</p>
                <p className="text-[11px] font-bold line-clamp-1">{a.rule.description}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="col-span-6 border border-white/10 bg-[#131B2D] rounded-lg p-6 overflow-hidden flex flex-col">
          {selectedAlert ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              <h2 className="text-xl font-bold mb-4">{selectedAlert.id}</h2>
              <div className="flex-1 bg-black/40 rounded p-4 font-mono text-[11px] overflow-y-auto">
                {selectedAlert.analysis ? (
                  <div className="space-y-4">
                    <p className="text-blue-400">[ANALYSIS]: {selectedAlert.analysis.summary}</p>
                    <div className="p-3 bg-red-600/10 border border-red-600/20 text-red-200 italic">{selectedAlert.analysis.recommended_action}</div>
                  </div>
                ) : <p className="opacity-30">Awaiting AI Analysis...</p>}
              </div>
              <button disabled={isAnalyzing || selectedAlert.analysis} onClick={() => runAnalysis(selectedAlert)} className="mt-4 py-3 bg-blue-600 rounded-xl font-bold uppercase text-xs">
                {isAnalyzing ? "Analyzing..." : selectedAlert.analysis ? "Analysis Ready" : "Run AI Analysis"}
              </button>
            </div>
          ) : <div className="h-full flex items-center justify-center opacity-20"><Search size="{40}"/></div>}
        </section>

        <section className="col-span-3 flex flex-col gap-4">
          <div className="flex-1 border border-white/10 bg-[#131B2D] rounded-lg p-4 overflow-hidden flex flex-col">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase mb-2">Audit Logs</h3>
            <div className="flex-1 overflow-y-auto font-mono text-[9px] text-slate-500">
              {logs.slice().reverse().map((l, i) => <p key={i} className="mb-1">{l}</p>)}
            </div>
          </div>
        </section>
      </main>

      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
          <div className="bg-[#131B2D] p-8 rounded-2xl w-full max-w-xl border border-white/10">
            <h2 className="text-xl font-bold mb-6">Agent Configuration</h2>
            <div className="space-y-4">
              <input className="w-full bg-slate-900 border border-white/10 p-3 rounded text-sm" placeholder="Manager API (55000)" value={settings.wazuhUrl} onChange={e => setSettings({...settings, wazuhUrl: e.target.value})} />
              <div className="grid grid-cols-2 gap-4">
                <input className="bg-slate-900 border border-white/10 p-3 rounded text-sm" placeholder="API User" value={settings.wazuhUser} onChange={e => setSettings({...settings, wazuhUser: e.target.value})} />
                <input type="password" className="bg-slate-900 border border-white/10 p-3 rounded text-sm" placeholder="API Password" value={settings.wazuhPass} onChange={e => setSettings({...settings, wazuhPass: e.target.value})} />
              </div>
              <input className="w-full bg-slate-900 border border-white/10 p-3 rounded text-sm" placeholder="Indexer URL (9200)" value={settings.wazuhIndexerUrl} onChange={e => setSettings({...settings, wazuhIndexerUrl: e.target.value})} />
              <div className="grid grid-cols-2 gap-4">
                <input className="bg-slate-900 border border-white/10 p-3 rounded text-sm" placeholder="Indexer User" value={settings.wazuhIndexerUser} onChange={e => setSettings({...settings, wazuhIndexerUser: e.target.value})} />
                <input type="password" className="bg-slate-900 border border-white/10 p-3 rounded text-sm" placeholder="Indexer Pass" value={settings.wazuhIndexerPass} onChange={e => setSettings({...settings, wazuhIndexerPass: e.target.value})} />
              </div>
            </div>
            <div className="mt-8 flex gap-4">
              <button onClick={saveSettings} className="flex-1 py-3 bg-blue-600 rounded-xl font-bold uppercase text-xs">Confirm & Sync</button>
              <button onClick={() => setShowSettings(false)} className="px-6 py-3 bg-slate-700 rounded-xl font-bold uppercase text-xs">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
