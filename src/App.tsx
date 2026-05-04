import React, { useState, useEffect } from "react";
import { 
  Shield, Activity, Search, Bot, RefreshCw, LogOut, Send, 
  Settings as SettingsIcon, History, Terminal, ExternalLink 
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
  const [logs, setLogs] = useState<string[]>(["[SYSTEM] SOC Dashboard initialized.", "[NETWORK] Listening for Wazuh alerts..."]);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({
    wazuhUrl: "", wazuhUser: "", wazuhPass: "", 
    wazuhIndexerUrl: "", wazuhIndexerUser: "admin", wazuhIndexerPass: "", 
    telegramToken: "", telegramChatId: "", geminiModel: "gemini-3-flash-preview"
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
      const poll = async () => {
        await fetchAlerts();
        await fetchAgents();
      };
      poll();
      const interval = setInterval(poll, 15000);
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
      addLog("[SUCCESS] Konfigurasi disinkronkan.");
      setShowSettings(false);
    } catch (err) { addLog("[ERROR] Gagal simpan konfigurasi."); }
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
      
      if (liveAlerts.length > 0) {
        for (const alert of liveAlerts) {
          const alertRef = doc(db, "wazuh_alerts", alert.id);
          await setDoc(alertRef, { ...alert, userId: user.uid }, { merge: true });
        }
      }

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
    } catch (err) { addLog("[ERROR] AI Reasoning Timeout."); }
    finally { setIsAnalyzing(false); }
  };

  const sendTelegramReport = async (alert: any) => {
    if (!alert.analysis) return;
    addLog(`[SOC] Mengirim laporan ke Telegram...`);
    try {
      await axios.post(`/api/alerts/report`, { config: settings, alert });
      addLog(`[SUCCESS] Laporan terkirim.`);
    } catch (err: any) { addLog(`[ERROR] Telegram API Error.`); }
  };

  const handleResolve = async (id: string) => {
    try {
      await setDoc(doc(db, "wazuh_alerts", id), { status: "Resolved" }, { merge: true });
      addLog(`[SOC] Alert ${id} diselesaikan.`);
      fetchAlerts();
      setSelectedAlert(null);
    } catch (err) {}
  };

  if (authLoading) return <div className="min-h-screen bg-[#0B0F1A] flex items-center justify-center"><RefreshCw className="animate-spin text-blue-500" /></div>;

  if (!user) return (
    <div className="min-h-screen bg-[#0B0F1A] flex items-center justify-center p-6 grid-bg">
      <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="max-w-md w-full bg-[#131B2D] border border-white/10 rounded-2xl p-8 text-center shadow-2xl">
        <Shield className="w-16 h-16 text-blue-600 mx-auto mb-6" />
        <h1 className="text-2xl font-bold text-white mb-2 uppercase tracking-tighter">MUSICYBER SOC AI</h1>
        <p className="text-slate-400 text-sm mb-8">Independent Security Intelligence Platform</p>
        <button onClick={loginWithGoogle} className="w-full py-4 bg-white text-[#0B0F1A] font-bold rounded-xl hover:bg-slate-200 transition-all">Sign in with Google</button>
      </motion.div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0B0F1A] text-slate-200 flex flex-col font-sans selection:bg-blue-600/30 grid-bg">
      {/* Header */}
      <header className="h-16 border-b border-white/10 flex items-center justify-between px-6 bg-[#0B0F1A]/80 backdrop-blur-md z-10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center shadow-lg shadow-blue-600/20"><Shield className="w-5 h-5 text-white" /></div>
          <h1 className="font-bold tracking-widest uppercase text-white text-lg">MUSICYBER <span className="text-blue-500">SOC AI</span></h1>
        </div>
        <div className="flex items-center gap-6">
          <div className="hidden md:flex gap-4 text-[10px] font-mono text-slate-500 uppercase tracking-widest items-center">
            <span>WAZUH: <span className={settings.wazuhUrl ? "text-green-500 font-bold" : "text-amber-500"}>{settings.wazuhUrl ? "ACTIVE" : "WAIT"}</span></span>
            <div className="w-[1px] h-3 bg-white/10"></div>
            <span>TELEGRAM: <span className={settings.telegramToken ? "text-green-500 font-bold" : "text-amber-500"}>{settings.telegramToken ? "ONLINE" : "OFFLINE"}</span></span>
            <div className="w-[1px] h-3 bg-white/10"></div>
            <span>AUTH: <span className="text-blue-400 font-bold">{user.email?.split("@")[0].toUpperCase()}</span></span>
          </div>
          <SettingsIcon className="cursor-pointer text-blue-400 hover:text-white transition-colors" size={18} onClick={() => setShowSettings(true)} />
          <LogOut className="cursor-pointer text-blue-400 hover:text-red-400 transition-colors" size={18} onClick={() => signOut(auth)} />
        </div>
      </header>

      {/* Main Layout Grid */}
      <main className="flex-1 grid grid-cols-12 gap-4 p-4 overflow-hidden">
        
        {/* ================= LEFT COLUMN ================= */}
        <section className="col-span-3 space-y-4 flex flex-col overflow-hidden">
          {/* Metrics & Assets */}
          <div className="border border-white/5 bg-[#131B2D] p-4 rounded-lg shrink-0 shadow-lg">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-4">Security Metrics</h3>
            <div className="grid grid-cols-2 gap-3 mb-6">
              <div className="p-3 bg-slate-900/50 rounded border border-white/5">
                <p className="text-[9px] text-slate-500 uppercase mb-1 font-bold">Total Signals</p>
                <p className="text-xl font-bold text-white font-mono">{alerts.length}</p>
              </div>
              <div className="p-3 bg-slate-900/50 rounded border border-white/5">
                <p className="text-[9px] text-slate-500 uppercase mb-1 font-bold">AI Verified</p>
                <p className="text-xl font-bold text-blue-400 font-mono">{alerts.filter(a => a.status === "Analyzed").length}</p>
              </div>
            </div>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Active Assets ({agents.length})</h3>
              <button className="text-[9px] bg-blue-600/20 text-blue-400 px-2 py-1 rounded hover:bg-blue-600/40 font-bold uppercase transition-colors">+ Deploy</button>
            </div>
            <div className="space-y-1.5 max-h-32 overflow-y-auto custom-scrollbar">
              {agents.map(ag => (
                <div key={ag.id} className="flex items-center justify-between p-2 bg-white/5 rounded text-[10px]">
                  <div className="flex items-center gap-2"><div className={cn("w-1.5 h-1.5 rounded-full", ag.status === "active" ? "bg-green-500 shadow-[0_0_5px_#22c55e]" : "bg-red-500")} /><span className="text-slate-300 font-mono">{ag.name}</span></div>
                  <span className="opacity-40 font-mono">{ag.ip}</span>
                </div>
              ))}
            </div>
          </div>
          
          {/* Live Alert Feed */}
          <div className="flex-1 border border-white/5 bg-[#131B2D] rounded-lg flex flex-col overflow-hidden shadow-lg">
            <div className="p-4 border-b border-white/5 flex justify-between items-center font-bold">
              <h3 className="text-[10px] text-slate-500 uppercase tracking-widest">Live Alert Feed</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5 custom-scrollbar">
              {alerts.map(a => (
                <div key={a.id} onClick={() => setSelectedAlert(a)} className={cn("p-4 rounded cursor-pointer transition-all border-l-2", selectedAlert?.id === a.id ? "bg-blue-600/20 border-blue-500" : "bg-slate-900/30 border-slate-800 hover:bg-slate-800", a.rule.level >= 7 && !selectedAlert?.id && "bg-red-900/10 border-red-900")}>
                  <div className="flex justify-between text-[10px] mb-1.5 font-mono">
                    <span className={cn("font-bold", a.rule.level >= 7 ? "text-red-400" : "text-slate-400")}>{a.id.substring(0,8)}</span>
                    <span className="text-slate-500">{new Date(a.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                  </div>
                  <p className="text-[11px] font-bold line-clamp-2 text-slate-300">{a.rule.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ================= CENTER COLUMN ================= */}
        <section className="col-span-6 border border-white/5 bg-[#131B2D] rounded-lg flex flex-col relative shadow-xl p-6">
          {selectedAlert ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Alert Header */}
              <div className="flex justify-between items-start mb-6 shrink-0">
                <div>
                  <h2 className="text-2xl font-bold text-white mb-2 tracking-tight">#{selectedAlert.id}</h2>
                  <p className="text-[10px] text-slate-400 font-mono uppercase tracking-widest">{selectedAlert.rule.description}</p>
                </div>
                <div className={cn("px-3 py-1 text-white text-[10px] font-bold rounded uppercase tracking-widest", selectedAlert.rule.level >= 7 ? "bg-red-600" : "bg-blue-600")}>
                  {selectedAlert.rule.level >= 7 ? "CRITICAL SEVERITY" : "MEDIUM SEVERITY"}
                </div>
              </div>

              {/* Analysis Log Body */}
              <div className="flex-1 min-h-0 bg-slate-950/50 border border-white/5 rounded-lg p-6 font-mono text-[11px] overflow-y-auto custom-scrollbar">
                {selectedAlert.analysis ? (
                  <>
                    <div className="flex justify-between items-center mb-6">
                      <p className="text-blue-400 uppercase font-bold tracking-widest">[AGENT_REASONING_LOG]</p>
                      <button onClick={() => sendTelegramReport(selectedAlert)} className="text-[10px] text-blue-400 hover:text-white flex items-center gap-1.5 uppercase font-bold transition-colors">
                        <ExternalLink size={14} /> Telegram Report
                      </button>
                    </div>

                    <div className="mb-6">
                      <p className="text-green-500 mb-3 uppercase font-bold text-[9px] tracking-[0.2em] underline font-sans">Root Cause Analysis</p>
                      <p className="text-slate-200 text-sm font-serif italic mb-6 leading-relaxed">"{selectedAlert.analysis.summary}"</p>
                      
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-[9px] text-slate-500 uppercase font-bold mb-1">Mitre Technique</p>
                          <p className="text-blue-400 font-bold">{selectedAlert.analysis.mitre_attack || "T1110"}</p>
                        </div>
                        <div>
                          <p className="text-[9px] text-slate-500 uppercase font-bold mb-1">Confidence</p>
                          <p className="text-blue-400 font-bold">{(selectedAlert.analysis.confidence * 100).toFixed(1)}%</p>
                        </div>
                      </div>
                    </div>

                    <p className="text-red-400 mb-3 uppercase font-bold tracking-widest mt-8">[RESPONSE_DIRECTIVE]</p>
                    <div className="bg-red-500/10 p-4 border border-red-500/30 rounded text-red-200 font-bold italic shadow-lg">
                      {selectedAlert.analysis.recommended_action}
                    </div>
                  </>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center opacity-30">
                    <Bot size={48} className={cn("mb-4", isAnalyzing && "animate-pulse text-blue-500")} />
                    <p className="uppercase tracking-[0.2em] text-[10px] font-bold">{isAnalyzing ? "Processing Analysis..." : "Awaiting AI Ingestion..."}</p>
                  </div>
                )}
              </div>

              {/* Bottom Buttons */}
              <div className="mt-6 flex gap-3 shrink-0">
                <button disabled={isAnalyzing || selectedAlert.analysis} onClick={() => runAnalysis(selectedAlert)} className={cn("flex-1 py-4 rounded font-bold uppercase text-[11px] tracking-widest transition-all", selectedAlert.analysis ? "bg-blue-600/50 text-white/50 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-500")}>
                  Run AI Analysis
                </button>
                {selectedAlert.status !== "Resolved" && (
                  <button onClick={() => handleResolve(selectedAlert.id)} className="px-8 py-4 bg-red-600 text-white font-bold text-[11px] uppercase rounded hover:bg-red-500 transition-all">
                    Resolve
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center opacity-20 text-center">
              <Search size={64} className="mb-6" />
              <p className="text-sm">Select a security event to begin the autonomous<br/>orchestration lifecycle.</p>
            </div>
          )}
        </section>

        {/* ================= RIGHT COLUMN ================= */}
        <section className="col-span-3 space-y-4 flex flex-col overflow-hidden">
          {/* Telegram Intel */}
          <div className="flex-1 border border-white/5 bg-[#131B2D] rounded-lg flex flex-col overflow-hidden shadow-lg">
            <div className="p-4 border-b border-white/5 flex items-center justify-between">
              <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Telegram Intel</h3>
              <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
            </div>
            <div className="flex-1 p-4 flex flex-col justify-end gap-3 bg-slate-900/20 overflow-y-auto custom-scrollbar font-serif italic">
              <div className="bg-slate-800 text-slate-200 text-[11px] p-4 rounded-xl max-w-[90%] self-start border border-white/5 shadow-md">
                <p className="font-bold text-[9px] text-blue-400 mb-1.5 font-sans not-italic">SYSTEM_UPDATE</p>
                Agent is calibrated. Command channel synced.
              </div>
            </div>
            <div className="p-3 border-t border-white/5 flex gap-2">
              <input type="text" placeholder="Agent Prompt..." className="flex-1 bg-slate-900 border border-white/10 rounded px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-blue-500 font-mono"/>
              <button className="px-4 bg-blue-600 rounded text-white hover:bg-blue-500 flex items-center justify-center"><Send size={14} /></button>
            </div>
          </div>

          {/* Audit Logs */}
          <div className="h-48 border border-white/5 bg-[#131B2D] p-4 rounded-lg flex flex-col overflow-hidden shadow-lg shrink-0">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Audit Logs</h3>
            <div className="flex-1 overflow-y-auto font-mono text-[9px] text-slate-500 space-y-2 custom-scrollbar">
              {logs.slice().reverse().map((l, i) => <p key={i}> {l} </p>)}
            </div>
          </div>
        </section>
      </main>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-6">
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="bg-[#131B2D] border border-white/10 rounded-xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
              <div className="p-6 border-b border-white/5 bg-slate-900/50 flex justify-between items-center">
                <h2 className="font-bold uppercase tracking-[0.2em] text-xs">MusiCyber Agent Config</h2>
                <LogOut className="cursor-pointer rotate-180 hover:text-red-500 transition-colors" size={18} onClick={() => setShowSettings(false)} />
              </div>
              <div className="p-8 space-y-8 overflow-y-auto custom-scrollbar">
                <div className="space-y-4">
                  <p className="text-[10px] font-bold text-blue-500 uppercase tracking-[0.2em] flex items-center gap-2"><Activity size={14}/> Manager API (Port 55000)</p>
                  <input className="w-full bg-slate-900 border border-white/10 p-3 rounded text-sm focus:border-blue-500 font-mono" placeholder="https://34.101.88.182:55000" value={settings.wazuhUrl} onChange={e => setSettings({...settings, wazuhUrl: e.target.value})} />
                  <div className="grid grid-cols-2 gap-4">
                    <input className="bg-slate-900 border border-white/10 p-3 rounded text-sm font-mono" placeholder="Username" value={settings.wazuhUser} onChange={e => setSettings({...settings, wazuhUser: e.target.value})} />
                    <input type="password" className="bg-slate-900 border border-white/10 p-3 rounded text-sm" placeholder="Password" value={settings.wazuhPass} onChange={e => setSettings({...settings, wazuhPass: e.target.value})} />
                  </div>
                </div>
                <div className="space-y-4 border-t border-white/5 pt-6">
                  <p className="text-[10px] font-bold text-blue-500 uppercase tracking-[0.2em] flex items-center gap-2"><History size={14}/> Indexer API (Port 9200)</p>
                  <input className="w-full bg-slate-900 border border-white/10 p-3 rounded text-sm focus:border-blue-500 font-mono" placeholder="https://34.101.88.182:9200" value={settings.wazuhIndexerUrl} onChange={e => setSettings({...settings, wazuhIndexerUrl: e.target.value})} />
                  <div className="grid grid-cols-2 gap-4">
                    <input className="bg-slate-900 border border-white/10 p-3 rounded text-sm font-mono" placeholder="admin" value={settings.wazuhIndexerUser} onChange={e => setSettings({...settings, wazuhIndexerUser: e.target.value})} />
                    <input type="password" className="bg-slate-900 border border-white/10 p-3 rounded text-sm" placeholder="Indexer Password" value={settings.wazuhIndexerPass} onChange={e => setSettings({...settings, wazuhIndexerPass: e.target.value})} />
                  </div>
                </div>
                <div className="space-y-4 border-t border-white/5 pt-6">
                  <p className="text-[10px] font-bold text-blue-500 uppercase tracking-[0.2em] flex items-center gap-2"><Send size={14}/> Telegram Orchestration</p>
                  <div className="grid grid-cols-2 gap-4">
                    <input className="bg-slate-900 border border-white/10 p-3 rounded text-sm font-mono" placeholder="Bot Token" value={settings.telegramToken} onChange={e => setSettings({...settings, telegramToken: e.target.value})} />
                    <input className="bg-slate-900 border border-white/10 p-3 rounded text-sm font-mono" placeholder="Chat ID" value={settings.telegramChatId} onChange={e => setSettings({...settings, telegramChatId: e.target.value})} />
                  </div>
                </div>
              </div>
              <div className="p-6 bg-slate-900/50 flex gap-4">
                <button onClick={saveSettings} className="flex-1 py-3 bg-blue-600 rounded font-bold uppercase text-[10px] tracking-widest hover:bg-blue-500 transition-all">Confirm & Sync</button>
                <button onClick={() => setShowSettings(false)} className="px-8 py-3 bg-slate-700 rounded font-bold uppercase text-[10px] hover:bg-slate-600 transition-all">Cancel</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <style>{`.custom-scrollbar::-webkit-scrollbar{width:4px}.custom-scrollbar::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.05);border-radius:10px}.grid-bg{background-image: radial-gradient(rgba(255,255,255,0.02) 1px, transparent 0); background-size: 24px 24px;}`}</style>
    </div>
  );
}
