import React, { useState, useEffect } from "react";
import { 
  Shield, Activity, Search, Bot, RefreshCw, LogOut, Send, 
  Settings as SettingsIcon, History, Terminal 
} from "lucide-react";
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
  wazuhUrl: string; wazuhUser: string; wazuhPass: string; 
  wazuhIndexerUrl: string; wazuhIndexerUser: string; wazuhIndexerPass: string; 
  telegramToken: string; telegramChatId: string; geminiModel: string;
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [selectedAlert, setSelectedAlert] = useState<any | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [logs, setLogs] = useState<string[]>(["[SYSTEM] MusiCyber SOC initialized."]);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({
    wazuhUrl: "", wazuhUser: "", wazuhPass: "", 
    wazuhIndexerUrl: "", wazuhIndexerUser: "admin", wazuhIndexerPass: "", 
    telegramToken: "", telegramChatId: "", geminiModel: "gemini-3-flash-preview"
  });
  const [agents, setAgents] = useState<any[]>([]);

  // 1. Monitor Status Login
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
      if (u) loadUserSettings(u.uid);
    });
    return () => unsubscribe();
  }, []);

  // 2. Loop Pengambilan Data (Hanya jalan jika login & settings siap)
  useEffect(() => {
    if (user && settings.wazuhUrl && settings.wazuhIndexerUrl) {
      const poll = async () => {
        await fetchAlerts();
        await fetchAgents();
      };
      poll();
      const interval = setInterval(poll, 15000); // Polling setiap 15 detik
      return () => clearInterval(interval);
    }
  }, [user, settings]);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev.slice(-10), `${new Date().toLocaleTimeString()} ${msg}`]);
  };

  const loadUserSettings = async (uid: string) => {
    try {
      const snap = await getDoc(doc(db, "users", uid, "settings", "main"));
      if (snap.exists()) setSettings(snap.data() as AppSettings);
    } catch (err) { console.error("Gagal muat settings", err); }
  };

  const saveSettings = async () => {
    if (!user) return;
    try {
      await setDoc(doc(db, "users", user.uid, "settings", "main"), settings);
      addLog("[SUCCESS] Konfigurasi berhasil disimpan.");
      setShowSettings(false);
    } catch (err) { addLog("[ERROR] Gagal simpan ke database."); }
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
      // Step A: Tarik data live dari Wazuh lewat Backend Proxy
      const res = await axios.post("/api/alerts", settings);
      const liveAlerts = Array.isArray(res.data) ? res.data : [];
      
      // Step B: Simpan ke Firestore (Bypass error permission-denied di backend)
      if (liveAlerts.length > 0) {
        for (const alert of liveAlerts) {
          const alertRef = doc(db, "wazuh_alerts", alert.id);
          await setDoc(alertRef, { ...alert, userId: user.uid }, { merge: true });
        }
      }

      // Step C: Tampilkan data dari Firestore (Multi-tenant isolation)
      const q = query(collection(db, "wazuh_alerts"), where("userId", "==", user.uid));
      const snap = await getDocs(q);
      const dbAlerts = snap.docs.map(d => d.data())
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 50);
      
      setAlerts(dbAlerts);
    } catch (err: any) {
      addLog(`[ERROR] Sync Gagal: ${err.response?.status || "Network Error"}`);
    }
  };

  const runAnalysis = async (alert: any) => {
    if (alert.analysis || !user) return;
    setIsAnalyzing(true);
    addLog(`[AI] Menganalisis ancaman ${alert.id}...`);
    try {
      const result = await analyzeAlert(alert.raw_log);
      await setDoc(doc(db, "wazuh_alerts", alert.id), { status: "Analyzed", analysis: result }, { merge: true });
      addLog(`[AI] Analisis Selesai: ${result.severity}`);
      fetchAlerts();
      setSelectedAlert(prev => prev?.id === alert.id ? { ...prev, analysis: result } : prev);
    } catch (err) { addLog("[ERROR] AI Engine Timeout."); }
    finally { setIsAnalyzing(false); }
  };

  if (authLoading) return <div className="min-h-screen bg-[#0B0F1A] flex items-center justify-center"><RefreshCw className="animate-spin text-blue-500" /></div>;

  if (!user) return (
    <div className="min-h-screen bg-[#0B0F1A] flex items-center justify-center p-6">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="max-w-md w-full bg-[#131B2D] border border-white/10 rounded-2xl p-8 text-center shadow-2xl">
        <Shield className="w-16 h-16 text-blue-600 mx-auto mb-6" />
        <h1 className="text-2xl font-bold text-white mb-2 uppercase tracking-tighter">MusiCyber SOC AI</h1>
        <p className="text-slate-400 text-sm mb-8 italic">Independent Security Intelligence</p>
        <button onClick={loginWithGoogle} className="w-full py-4 bg-white text-black font-bold rounded-xl hover:bg-slate-200 transition-all">Sign in with Google</button>
      </motion.div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0B0F1A] text-slate-200 flex flex-col font-sans">
      {/* Header */}
      <header className="h-16 border-b border-white/10 flex items-center justify-between px-6 bg-[#0B0F1A]/80 backdrop-blur-md">
        <div className="flex items-center gap-3"><Shield className="text-blue-600" size={24}/><h1 className="font-bold tracking-widest uppercase">SOC <span className="text-blue-500">AI</span></h1></div>
        <div className="flex items-center gap-6">
          <div className="hidden md:flex gap-4 text-[10px] font-mono text-slate-500">
            <span>SIEM: <span className={settings.wazuhUrl ? "text-green-500" : "text-red-500"}>{settings.wazuhUrl ? "READY" : "OFF"}</span></span>
            <span>USER: <span className="text-blue-400">{user.email?.split("@")[0]}</span></span>
          </div>
          <SettingsIcon className="cursor-pointer hover:text-blue-400" onClick={() => setShowSettings(true)} />
          <LogOut className="cursor-pointer hover:text-red-400" onClick={() => signOut(auth)} />
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 grid grid-cols-12 gap-4 p-4 overflow-hidden">
        {/* Alerts Sidebar */}
        <section className="col-span-3 border border-white/10 bg-[#131B2D] rounded-lg flex flex-col overflow-hidden">
          <div className="p-4 border-b border-white/5 bg-slate-900/50"><h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Live Alerts</h3></div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
            {alerts.length === 0 && <p className="text-[10px] text-slate-600 text-center mt-10">Menunggu data Indexer...</p>}
            {alerts.map(a => (
              <div key={a.id} onClick={() => setSelectedAlert(a)} className={cn("p-3 rounded border-l-2 cursor-pointer transition-all bg-slate-900/30 border-slate-700 hover:bg-slate-800", selectedAlert?.id === a.id && "border-blue-500 bg-blue-600/10")}>
                <div className="flex justify-between text-[9px] mb-1"><span className="font-mono text-slate-500">{a.id}</span><span className="opacity-40">{new Date(a.timestamp).toLocaleTimeString()}</span></div>
                <p className="text-[11px] font-bold line-clamp-2">{a.rule.description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Center Panel */}
        <section className="col-span-6 border border-white/10 bg-[#131B2D] rounded-lg overflow-hidden flex flex-col relative">
          {selectedAlert ? (
            <div className="flex-1 flex flex-col p-6 overflow-hidden">
              <div className="mb-6"><h2 className="text-xl font-bold text-white mb-1 tracking-tight">{selectedAlert.id}</h2><p className="text-xs text-blue-400 font-mono uppercase tracking-widest">{selectedAlert.rule.description}</p></div>
              <div className="flex-1 bg-black/40 rounded-lg p-5 font-mono text-[11px] overflow-y-auto leading-relaxed border border-white/5 custom-scrollbar">
                {selectedAlert.analysis ? (
                  <div className="space-y-6">
                    <div><p className="text-blue-500 mb-2 font-bold">[AI_ROOT_CAUSE]</p><p className="text-slate-300 italic">"{selectedAlert.analysis.summary}"</p></div>
                    <div className="p-4 bg-red-600/10 border border-red-600/30 rounded text-red-200">
                      <p className="text-[9px] font-bold text-red-500 mb-2 underline">RECOMMENDED_ACTION</p>
                      {selectedAlert.analysis.recommended_action}
                    </div>
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center opacity-30"><Bot size={40} className="mb-4" /><p className="uppercase tracking-widest">Awaiting AI Ingestion...</p></div>
                )}
              </div>
              <button disabled={isAnalyzing || selectedAlert.analysis} onClick={() => runAnalysis(selectedAlert)} className={cn("mt-6 py-4 rounded-xl font-bold uppercase text-[10px] tracking-widest transition-all", selectedAlert.analysis ? "bg-slate-800 text-slate-500" : "bg-blue-600 text-white hover:bg-blue-500")}>
                {isAnalyzing ? "Processing Reasoning..." : selectedAlert.analysis ? "Analysis Stored" : "Execute AI Analysis"}
              </button>
            </div>
          ) : <div className="h-full flex flex-center items-center justify-center opacity-20"><Search size={60} /></div>}
        </section>

        {/* Right Panel */}
        <section className="col-span-3 flex flex-col gap-4">
          <div className="bg-[#131B2D] border border-white/10 rounded-lg p-4"><h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-4">Agents ({agents.length})</h3>
            <div className="space-y-2 max-h-40 overflow-y-auto custom-scrollbar">
              {agents.map(ag => (
                <div key={ag.id} className="flex items-center justify-between p-2 bg-white/5 rounded text-[10px]">
                  <div className="flex items-center gap-2"><div className={cn("w-1.5 h-1.5 rounded-full", ag.status === "active" ? "bg-green-500" : "bg-red-500")} /><span>{ag.name}</span></div>
                  <span className="opacity-40 font-mono">{ag.ip}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex-1 border border-white/10 bg-[#131B2D] rounded-lg p-4 flex flex-col overflow-hidden">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Audit Logs</h3>
            <div className="flex-1 overflow-y-auto font-mono text-[9px] text-slate-500 space-y-2 custom-scrollbar">
              {logs.slice().reverse().map((l, i) => <p key={i} className="border-l border-white/10 pl-2">{l}</p>)}
            </div>
          </div>
        </section>
      </main>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="bg-[#131B2D] border border-white/10 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl">
              <div className="p-6 border-b border-white/5 bg-slate-900/50 flex justify-between items-center"><h2 className="font-bold uppercase tracking-widest">Agent Config</h2><LogOut className="cursor-pointer rotate-180" onClick={() => setShowSettings(false)} /></div>
              <div className="p-8 space-y-6 overflow-y-auto max-h-[70vh] custom-scrollbar">
                <div className="space-y-4">
                  <p className="text-[10px] font-bold text-blue-500 uppercase tracking-[0.2em]">Manager API (55000)</p>
                  <input className="w-full bg-slate-900 border border-white/10 p-3 rounded-lg text-sm" placeholder="https://IP:55000" value={settings.wazuhUrl} onChange={e => setSettings({...settings, wazuhUrl: e.target.value})} />
                  <div className="grid grid-cols-2 gap-4">
                    <input className="bg-slate-900 border border-white/10 p-3 rounded-lg text-sm" placeholder="User" value={settings.wazuhUser} onChange={e => setSettings({...settings, wazuhUser: e.target.value})} />
                    <input type="password" className="bg-slate-900 border border-white/10 p-3 rounded-lg text-sm" placeholder="Pass" value={settings.wazuhPass} onChange={e => setSettings({...settings, wazuhPass: e.target.value})} />
                  </div>
                </div>
                <div className="space-y-4">
                  <p className="text-[10px] font-bold text-blue-500 uppercase tracking-[0.2em]">Indexer API (9200)</p>
                  <input className="w-full bg-slate-900 border border-white/10 p-3 rounded-lg text-sm" placeholder="https://IP:9200" value={settings.wazuhIndexerUrl} onChange={e => setSettings({...settings, wazuhIndexerUrl: e.target.value})} />
                  <div className="grid grid-cols-2 gap-4">
                    <input className="bg-slate-900 border border-white/10 p-3 rounded-lg text-sm" placeholder="User" value={settings.wazuhIndexerUser} onChange={e => setSettings({...settings, wazuhIndexerUser: e.target.value})} />
                    <input type="password" className="bg-slate-900 border border-white/10 p-3 rounded-lg text-sm" placeholder="Pass" value={settings.wazuhIndexerPass} onChange={e => setSettings({...settings, wazuhIndexerPass: e.target.value})} />
                  </div>
                </div>
              </div>
              <div className="p-6 bg-slate-900/50 flex gap-4">
                <button onClick={saveSettings} className="flex-1 py-3 bg-blue-600 rounded-xl font-bold uppercase text-[10px] tracking-widest">Confirm & Sync</button>
                <button onClick={() => setShowSettings(false)} className="px-8 py-3 bg-slate-700 rounded-xl font-bold uppercase text-[10px]">Cancel</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <style>{`.custom-scrollbar::-webkit-scrollbar{width:4px}.custom-scrollbar::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.05);border-radius:10px}`}</style>
    </div>
  );
}
