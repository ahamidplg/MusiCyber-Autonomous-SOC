import React, { useState, useEffect } from "react";
import { 
  Shield, 
  AlertTriangle, 
  Terminal, 
  Activity, 
  CheckCircle, 
  Search,
  Zap,
  Bot,
  RefreshCw,
  LogOut,
  Send,
  Settings as SettingsIcon,
  User,
  History,
  Info,
  ChevronRight,
  ExternalLink
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import axios from "axios";
import { analyzeAlert, AnalysisResponse } from "./ai_agent";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { auth, loginWithGoogle, db } from "./firebase";
import { onAuthStateChanged, User as FirebaseUser, signOut } from "firebase/auth";
import { doc, getDoc, setDoc, collection, addDoc, serverTimestamp } from "firebase/firestore";

// Tambahkan blok ini di bawah area import
axios.interceptors.request.use((config) => {
  const currentUser = auth.currentUser;
  if (currentUser) {
    config.headers['x-user-id'] = currentUser.uid;
  }
  return config;
}, (error) => {
  return Promise.reject(error);
});

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface AppSettings {
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

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
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
    wazuhUrl: "",
    wazuhUser: "",
    wazuhPass: "",
    wazuhIndexerUrl: "",
    wazuhIndexerUser: "admin",
    wazuhIndexerPass: "",
    telegramToken: "",
    telegramChatId: "",
    geminiModel: "gemini-3-flash-preview"
  });

  const [isCheckingConnection, setIsCheckingConnection] = useState(false);
  const [showDeploymentGuide, setShowDeploymentGuide] = useState(false);
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
    if (user) {
      fetchAlerts();
      fetchAgents();
      const interval = setInterval(() => {
        fetchAlerts();
        fetchAgents();
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [user]);

  const fetchAgents = async () => {
    try {
      const response = await axios.get("/api/agents");
      if (Array.isArray(response.data)) {
        setAgents(response.data);
      }
    } catch (err) {
      console.warn("Failed to fetch agents");
    }
  };

  const checkConnection = async () => {
    setIsCheckingConnection(true);
    addLog("[SYSTEM] Testing SIEM connectivity...");
    try {
      const response = await axios.post("/api/config/test", settings);
      if (response.data.status === "success") {
        addLog(`[SUCCESS] Connected to ${response.data.manager}. All channels green.`);
      } else {
        addLog(`[ERROR] ${response.data.message}`);
      }
    } catch (err: any) {
      addLog(`[ERROR] SIEM unreachable: ${err.message}`);
    } finally {
      setIsCheckingConnection(false);
    }
  };

  const loadUserSettings = async (uid: string) => {
    const path = `users/${uid}/settings/main`;
    try {
      const docRef = doc(db, "users", uid, "settings", "main");
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        setSettings(prev => ({
          ...prev,
          ...data
        }));
        syncConfigToBackend({ ...settings, ...data } as AppSettings);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, path);
    }
  };

  const saveSettings = async () => {
    if (!user) return;
    const path = `users/${user.uid}/settings/main`;
    try {
      const docRef = doc(db, "users", user.uid, "settings", "main");
      const payload = {
        ...settings,
        updatedAt: new Date().toISOString(),
        updatedBy: user.uid
      };
      await setDoc(docRef, payload);
      syncConfigToBackend(settings);
      addLog("[SYSTEM] Settings saved and synced with Agent.");
      setShowSettings(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  };

  const syncConfigToBackend = async (cfg: AppSettings) => {
    try {
      await axios.post("/api/config", cfg);
    } catch (err) {
      console.error("Backend sync failed");
    }
  };

  const fetchAlerts = async () => {
    try {
      const response = await axios.get("/api/alerts");
      if (Array.isArray(response.data)) {
        setAlerts(response.data);
      } else {
        addLog("[ERROR] Backend returned invalid data format.");
      }
    } catch (err) {
      addLog("[ERROR] Failed to fetch alerts from backend.");
    }
  };

  const logToFirestore = async (alertId: string, action: string, reasoning: string) => {
    if (!user) return;
    const path = "audit_logs";
    try {
      await addDoc(collection(db, "audit_logs"), {
        alertId,
        action,
        reasoning,
        timestamp: serverTimestamp(),
        actor: user.uid,
        actorEmail: user.email
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const safeAlerts = Array.isArray(alerts) ? alerts : [];
  const safeLogs = Array.isArray(logs) ? logs : [];

  const addLog = (msg: string) => {
    setLogs(prev => [...(Array.isArray(prev) ? prev.slice(-15) : []), `${new Date().toLocaleTimeString()} ${msg}`]);
  };

  const runAnalysis = async (alert: any) => {
    if (alert.analysis) return;
    setIsAnalyzing(true);
    addLog(`[AGENT] Starting autonomous analysis for ${alert.id}...`);
    try {
      const result = await analyzeAlert(alert.raw_log);
      await axios.patch(`/api/alerts/${alert.id}`, { 
        status: "Analyzed",
        analysis: result 
      });
      addLog(`[AGENT] Analysis complete for ${alert.id}. Severity: ${result.severity}`);
      await logToFirestore(alert.id, "AI_ANALYSIS", result.summary);
      fetchAlerts();
    } catch (err) {
      addLog(`[ERROR] AI Reasoning failed for ${alert.id}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const sendTelegramReport = async (alert: any) => {
    if (!alert.analysis) return;
    addLog(`[SOC] Sending incident report for ${alert.id} to Telegram...`);
    try {
      await axios.post(`/api/alerts/${alert.id}/report`);
      addLog(`[SUCCESS] Report dispatched via Telegram.`);
    } catch (err: any) {
      const errMsg = err.response?.data?.error || "Telegram delivery failed.";
      addLog(`[ERROR] ${errMsg}`);
    }
  };

  const handleResolve = async (id: string) => {
    try {
      await axios.patch(`/api/alerts/${id}`, { status: "Resolved" });
      addLog(`[SOC] Alert ${id} marked as RESOLVED.`);
      await logToFirestore(id, "RESOLVE", "Incident manually resolved by analyst.");
      fetchAlerts();
      setSelectedAlert(null);
    } catch (err) {
      addLog("[ERROR] Failed to update alert status.");
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0B0F1A] flex items-center justify-center">
        <RefreshCw className="text-blue-500 animate-spin" size={40} />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0B0F1A] flex items-center justify-center p-6 grid-bg">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full bg-[#131B2D] border-panel rounded-2xl p-8 text-center shadow-2xl"
        >
          <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-600/20">
            <Shield className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2 uppercase tracking-tight italic font-serif">MusiCyber AI Agent</h1>
          <p className="text-slate-400 text-sm mb-8">Autonomous Security Incident Response Orchestrator. Integrated with your Wazuh infrastructure.</p>
          
          <button 
            onClick={loginWithGoogle}
            className="w-full py-4 bg-white text-[#0B0F1A] font-bold rounded-xl flex items-center justify-center gap-3 hover:bg-slate-100 transition-all active:scale-[0.98]"
          >
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/nps/google.svg" className="w-5 h-5" alt="Google" />
            Sign in with Google
          </button>

          <p className="mt-8 text-[10px] uppercase tracking-widest text-slate-500 font-mono">
            SECURE ACCESS ONLY_
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0F1A] text-slate-200 grid-bg font-sans selection:bg-blue-600/30 overflow-hidden flex flex-col">
      {/* Header */}
      <header className="h-16 border-b border-white/10 bg-[#0B0F1A]/80 backdrop-blur-md flex items-center justify-between px-6 z-10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center shadow-lg shadow-blue-600/20">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-lg font-bold tracking-tight text-white uppercase">
            MusiCyber <span className="text-blue-400">SOC AI</span>
          </h1>
        </div>
        
        <div className="flex items-center gap-6 text-[10px] font-medium uppercase tracking-widest">
          <div className="hidden lg:flex items-center gap-4 text-slate-500">
            <span>Wazuh: <span className={cn(settings.wazuhUrl ? "text-green-500" : "text-amber-500")}>{settings.wazuhUrl ? "Active" : "Wait"}</span></span>
            <div className="h-3 w-[1px] bg-white/10"></div>
            <span>Telegram: <span className={cn(settings.telegramToken ? "text-green-500" : "text-amber-500")}>{settings.telegramToken ? "Online" : "Offline"}</span></span>
            <div className="h-3 w-[1px] bg-white/10"></div>
            <span>Auth: <span className="text-blue-400">{user.email?.split("@")[0]}</span></span>
          </div>
          <div className="flex items-center gap-4 text-blue-400">
            <button 
              onClick={() => setShowSettings(true)}
              className="p-2 hover:bg-white/5 rounded-full transition-colors"
            >
              <SettingsIcon size={16} />
            </button>
            <button 
              onClick={() => signOut(auth)}
              className="p-2 hover:bg-white/5 rounded-full transition-colors"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-12 gap-4 p-4 overflow-hidden">
        {/* Left Sidebar */}
        <section className="col-span-3 space-y-4 flex flex-col overflow-hidden">
          <div className="border-panel bg-[#131B2D] p-4 rounded-lg shrink-0">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-4">Security Metrics</h3>
            <div className="grid grid-cols-2 gap-3 mb-6">
              <div className="p-3 bg-slate-900/50 rounded border border-white/5">
                <p className="text-[9px] text-slate-500 uppercase mb-1">Total Signals</p>
                <p className="text-xl font-bold text-white font-mono">{safeAlerts.length}</p>
              </div>
              <div className="p-3 bg-slate-900/50 rounded border border-white/5">
                <p className="text-[9px] text-slate-500 uppercase mb-1">AI Verified</p>
                <p className="text-xl font-bold text-blue-400 font-mono">{safeAlerts.filter(a => a.status === "Analyzed").length}</p>
              </div>
            </div>

            <div className="flex justify-between items-center mb-4">
              <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Active Assets ({agents.length})</h3>
              <button 
                onClick={() => setShowDeploymentGuide(true)}
                className="text-[9px] bg-blue-600/20 text-blue-400 px-2 py-1 rounded hover:bg-blue-600/40 transition-all font-bold uppercase"
              >
                + Deploy
              </button>
            </div>
            <div className="space-y-1 max-h-40 overflow-y-auto custom-scrollbar">
              {agents.length === 0 ? (
                <p className="text-[10px] text-slate-600 italic">No agents connected.</p>
              ) : (
                agents.map(agent => (
                  <div key={agent.id} className="flex items-center justify-between p-2 bg-white/5 rounded text-[10px]">
                    <div className="flex items-center gap-2">
                       <div className={cn("w-1.5 h-1.5 rounded-full", agent.status === "active" ? "bg-green-500" : "bg-red-500")} />
                       <span className="text-slate-300 font-mono">{agent.name}</span>
                    </div>
                    <span className="text-slate-500">{agent.ip}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="border-panel bg-[#131B2D] flex-1 rounded-lg p-4 flex flex-col overflow-hidden">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-4">Live Alert Feed</h3>
            <div className="space-y-2 overflow-y-auto flex-1 pr-1 custom-scrollbar">
              {safeAlerts.slice().reverse().map((alert) => (
                <div 
                  key={alert.id}
                  onClick={() => setSelectedAlert(alert)}
                  className={cn(
                    "text-[11px] p-3 rounded border-l-2 cursor-pointer transition-all border-white/5",
                    selectedAlert?.id === alert.id ? "bg-blue-600/20 border-blue-500" : "bg-slate-900/30 hover:bg-slate-800/50 border-slate-700",
                    alert.severity === "Critical" && "bg-red-900/20 border-red-500"
                  )}
                >
                  <div className="flex justify-between mb-1">
                    <p className={cn(
                      "font-mono font-bold",
                      alert.severity === "Critical" ? "text-red-400" : "text-slate-300"
                    )}>{alert.id}</p>
                    <span className="text-[9px] opacity-40">{new Date(alert.timestamp).toLocaleTimeString([], {hour: "2-digit", minute:"2-digit"})}</span>
                  </div>
                  <p className="text-slate-400 line-clamp-1 truncate">{alert.rule.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Center */}
        <section className="col-span-6 overflow-hidden">
          <div className="border-panel bg-[#131B2D] rounded-lg p-6 h-full flex flex-col overflow-hidden relative">
            {selectedAlert ? (
              <AnimatePresence mode="wait">
                <motion.div 
                  key={selectedAlert.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex-1 flex flex-col overflow-hidden"
                >
                  <div className="flex justify-between items-start mb-6 shrink-0">
                    <div className="space-y-1">
                      <h2 className="text-2xl font-bold text-white tracking-tight">#{selectedAlert.id}</h2>
                      <p className="text-slate-400 text-[11px] uppercase tracking-widest font-mono">{selectedAlert.rule.description}</p>
                    </div>
                    <div className={cn(
                      "px-3 py-1 text-white text-[10px] font-bold rounded uppercase tracking-widest",
                      selectedAlert.severity === "Critical" ? "bg-red-600" : "bg-blue-600"
                    )}>
                      {selectedAlert.severity} SEVERITY
                    </div>
                  </div>

                  <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-hidden">
                    <div className="flex-1 border-panel bg-slate-950/80 rounded-lg p-5 font-mono text-[11px] leading-relaxed overflow-y-auto custom-scrollbar">
                      {selectedAlert.analysis ? (
                        <>
                          <div className="flex justify-between items-center mb-4">
                            <p className="text-blue-400 uppercase font-bold tracking-widest">[AGENT_REASONING_LOG]</p>
                            <button 
                              onClick={() => sendTelegramReport(selectedAlert)}
                              className="text-xs text-blue-400 hover:text-white flex items-center gap-1 uppercase font-bold"
                            >
                              <ExternalLink size={12} /> Telegram Report
                            </button>
                          </div>
                          
                          <div className="mb-6 text-slate-400 p-4 bg-white/5 rounded border border-white/5">
                            <p className="text-green-400 mb-2 uppercase font-bold text-[9px] tracking-[0.2em] underline">Root Cause Analysis</p>
                            <p className="text-slate-200 text-sm font-serif italic mb-4 leading-relaxed">
                              "{selectedAlert.analysis.summary}"
                            </p>
                            
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <p className="text-[9px] text-slate-500 uppercase font-bold mb-1">MITRE Technique</p>
                                <p className="text-blue-400 font-bold">{selectedAlert.analysis.mitre_attack}</p>
                              </div>
                              <div>
                                <p className="text-[9px] text-slate-500 uppercase font-bold mb-1">Confidence</p>
                                <p className="text-blue-400 font-bold">{(selectedAlert.analysis.confidence * 100).toFixed(1)}%</p>
                              </div>
                            </div>
                          </div>

                          <p className="text-red-400 mb-2 uppercase font-bold tracking-widest">[RESPONSE_DIRECTIVE]</p>
                          <div className="bg-red-500/10 p-4 border border-red-500/30 rounded text-red-200 font-bold italic shadow-lg shadow-red-500/5">
                             “{selectedAlert.analysis.recommended_action}”
                          </div>
                        </>
                      ) : (
                        <div className="h-full flex flex-col items-center justify-center opacity-30 text-center">
                          <Bot size={48} className={cn("mb-4", isAnalyzing && "animate-pulse text-blue-400")} />
                          <h4 className="uppercase font-bold tracking-widest">Awaiting Analysis</h4>
                          <p className="text-[10px] mt-2 max-w-[200px] leading-relaxed">Agent must ingest telemetry before mapping threat vectors.</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-6 flex gap-3 shrink-0">
                    <button 
                      onClick={() => !selectedAlert.analysis && runAnalysis(selectedAlert)}
                      disabled={isAnalyzing || !!selectedAlert.analysis}
                      className={cn(
                        "flex-1 py-4 font-bold text-[10px] uppercase tracking-widest rounded-xl transition-all shadow-xl",
                        selectedAlert.analysis ? "bg-slate-800 text-slate-500" : "bg-blue-600 text-white hover:bg-blue-500 shadow-blue-600/20"
                      )}
                    >
                      {isAnalyzing ? "Processing Reasoning Path..." : selectedAlert.analysis ? "Analysis Stored" : "Run AI Analysis"}
                    </button>
                    {selectedAlert.status !== "Resolved" && (
                      <button 
                        onClick={() => handleResolve(selectedAlert.id)}
                        className="px-6 py-4 bg-red-600 text-white font-bold text-[10px] uppercase rounded-xl hover:bg-red-500 transition-all shadow-xl shadow-red-600/20"
                      >
                        Resolve
                      </button>
                    )}
                  </div>
                </motion.div>
              </AnimatePresence>
            ) : (
              <div className="h-full flex flex-col items-center justify-center opacity-20 text-center px-12">
                <Search size={60} className="mb-6" />
                <h3 className="text-2xl font-bold text-white uppercase tracking-tighter mb-2">Monitor Active</h3>
                <p className="text-sm max-w-xs">Select a security event to begin the autonomous orchestration lifecycle.</p>
              </div>
            )}
          </div>
        </section>

        {/* Right Sidebar */}
        <section className="col-span-3 space-y-4 flex flex-col overflow-hidden">
          <div className="border-panel bg-[#131B2D] flex-1 rounded-lg flex flex-col overflow-hidden shadow-2xl">
            <div className="p-4 border-b border-white/10 flex items-center justify-between bg-slate-900/50">
              <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Telegram Intel</h3>
              <div className="w-2 h-2 bg-blue-500 rounded-full shadow-[0_0_8px_#3B82F6]"></div>
            </div>
            
            <div className="flex-1 p-4 flex flex-col justify-end gap-3 bg-slate-950/30 overflow-y-auto custom-scrollbar italic font-serif">
              <div className="bg-slate-800 text-slate-200 text-[11px] p-3 rounded-xl max-w-[90%] self-start border border-white/5">
                <p className="font-bold text-[9px] text-blue-400 mb-1">SYSTEM_UPDATE</p>
                Agent is calibrated. {settings.telegramToken ? "Command channel synced." : "Awaiting Telegram token configuration."}
              </div>
              {selectedAlert?.analysis && (
                <div className="bg-slate-800 text-slate-200 text-[11px] p-3 rounded-xl max-w-[90%] self-start border border-white/5">
                  <p className="font-bold text-[9px] text-blue-400 mb-1">INTEL_RESPONSE</p>
                  Alert {selectedAlert.id} identified as {selectedAlert.analysis.threat_type}. Ready for dispatch.
                </div>
              )}
            </div>

            <div className="p-3 border-t border-white/10 bg-slate-900 flex gap-2">
              <input 
                type="text" 
                placeholder="Agent Prompt..." 
                className="flex-1 bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-blue-500"
              />
              <button className="p-2 bg-blue-600 rounded-lg"><Send size={14} /></button>
            </div>
          </div>

          <div className="border-panel bg-[#131B2D] p-4 rounded-lg shrink-0 h-48 overflow-hidden flex flex-col">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Audit Logs</h3>
            <div className="font-mono text-[9px] space-y-1.5 text-slate-400 overflow-y-auto custom-scrollbar pr-2">
              {safeLogs.slice().reverse().map((log, i) => (
                <p key={i} className="border-l border-white/10 pl-2">{log}</p>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-[#0B0F1A]/80 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="w-full max-w-2xl bg-[#131B2D] border border-white/10 rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[80vh]"
            >
              <div className="p-6 border-b border-white/10 flex justify-between items-center bg-slate-900/50">
                <div className="flex items-center gap-3">
                  <SettingsIcon className="text-blue-500" size={20} />
                  <h2 className="text-xl font-bold text-white uppercase tracking-tight">Agent Configuration</h2>
                </div>
                <button onClick={() => setShowSettings(false)} className="text-slate-500 hover:text-white transition-colors">
                  <LogOut size={20} className="rotate-180" />
                </button>
              </div>

              <div className="p-8 overflow-y-auto custom-scrollbar space-y-8">
                {/* Wazuh Section */}
                <section className="space-y-4">
                  <div className="flex items-center justify-between gap-2 text-blue-400 font-bold uppercase text-[10px] tracking-widest">
                    <div className="flex items-center gap-2"><Activity size={14} /> SIEM Management (Wazuh API)</div>
                    <button 
                      onClick={checkConnection}
                      disabled={isCheckingConnection || !settings.wazuhUrl}
                      className="bg-blue-600/20 text-blue-400 px-3 py-1 rounded border border-blue-500/30 hover:bg-blue-600/40 disabled:opacity-50"
                    >
                      {isCheckingConnection ? "Checking..." : "Test Connection"}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase text-slate-500 font-bold ml-1">Manager API endpoint (55000)</label>
                      <input 
                        className="w-full bg-slate-900/80 border border-white/10 rounded-lg p-3 text-sm focus:outline-none focus:border-blue-500 transition-all font-mono"
                        placeholder="https://wazuh-manager:55000"
                        value={settings.wazuhUrl}
                        onChange={(e) => setSettings({...settings, wazuhUrl: e.target.value})}
                      />
                    </div>
                  </div>
                </section>

                <section className="space-y-4">
                  <div className="flex items-center gap-2 text-blue-400 font-bold uppercase text-[10px] tracking-widest">
                    <History size={14} /> Data Indexer (Wazuh Indexer)
                  </div>
                  <div className="grid grid-cols-1 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase text-slate-500 font-bold ml-1">Indexer URL (9200)</label>
                      <input 
                        className="w-full bg-slate-900/80 border border-white/10 rounded-lg p-3 text-sm focus:outline-none focus:border-blue-500 transition-all font-mono"
                        placeholder="https://34.101.88.182:9200"
                        value={settings.wazuhIndexerUrl}
                        onChange={(e) => setSettings({...settings, wazuhIndexerUrl: e.target.value})}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-[10px] uppercase text-slate-500 font-bold ml-1">Indexer User</label>
                        <input 
                          className="w-full bg-slate-900/80 border border-white/10 rounded-lg p-3 text-sm focus:outline-none focus:border-blue-500 transition-all font-mono"
                          placeholder="admin"
                          value={settings.wazuhIndexerUser}
                          onChange={(e) => setSettings({...settings, wazuhIndexerUser: e.target.value})}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] uppercase text-slate-500 font-bold ml-1">Indexer Password</label>
                        <input 
                          type="password"
                          className="w-full bg-slate-900/80 border border-white/10 rounded-lg p-3 text-sm focus:outline-none focus:border-blue-500 transition-all font-mono"
                          placeholder="••••••••"
                          value={settings.wazuhIndexerPass}
                          onChange={(e) => setSettings({...settings, wazuhIndexerPass: e.target.value})}
                        />
                      </div>
                    </div>
                  </div>
                </section>

                <div className="h-[1px] bg-white/5" />

                {/* Telegram Section */}
                <section className="space-y-4">
                  <div className="flex items-center justify-between gap-2 text-blue-400 font-bold uppercase text-[10px] tracking-widest">
                    <div className="flex items-center gap-2"><Send size={14} /> Bot Interface (Telegram)</div>
                    <button 
                      onClick={async () => {
                        addLog("[SYSTEM] Testing Telegram bot...");
                        try {
                          const res = await axios.post("/api/config/test/telegram", {
                            token: settings.telegramToken,
                            chatId: settings.telegramChatId
                          });
                          addLog(`[SUCCESS] ${res.data.message}`);
                        } catch (err: any) {
                          addLog(`[ERROR] Telegram Test Failed: ${err.response?.data?.message || err.message}`);
                        }
                      }}
                      disabled={!settings.telegramToken || !settings.telegramChatId}
                      className="bg-blue-600/20 text-blue-400 px-3 py-1 rounded border border-blue-500/30 hover:bg-blue-600/40 disabled:opacity-50"
                    >
                      Test Bot
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase text-slate-500 font-bold ml-1">Bot Token</label>
                      <input 
                        className="w-full bg-slate-900/80 border border-white/10 rounded-lg p-3 text-sm focus:outline-none focus:border-blue-500 transition-all font-mono"
                        placeholder="000000:ABC-DEF"
                        value={settings.telegramToken}
                        onChange={(e) => setSettings({...settings, telegramToken: e.target.value})}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase text-slate-500 font-bold ml-1">Admin Chat ID</label>
                      <input 
                        className="w-full bg-slate-900/80 border border-white/10 rounded-lg p-3 text-sm focus:outline-none focus:border-blue-500 transition-all font-mono"
                        placeholder="123456789"
                        value={settings.telegramChatId}
                        onChange={(e) => setSettings({...settings, telegramChatId: e.target.value})}
                      />
                      <p className="text-[9px] text-slate-500 italic ml-1">Send /start to your bot to get your ID</p>
                    </div>
                  </div>
                </section>

                <div className="h-[1px] bg-white/5" />

                {/* Agent Section */}
                <section className="space-y-4">
                  <div className="flex items-center gap-2 text-blue-400 font-bold uppercase text-[10px] tracking-widest">
                    <Bot size={14} /> Intelligence Core (Gemini)
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase text-slate-500 font-bold ml-1">Active reasoning model</label>
                    <select 
                      className="w-full bg-slate-900/80 border border-white/10 rounded-lg p-3 text-sm focus:outline-none focus:border-blue-500 transition-all font-mono appearance-none"
                      value={settings.geminiModel}
                      onChange={(e) => setSettings({...settings, geminiModel: e.target.value})}
                    >
                      <option value="gemini-3-flash-preview">Gemini 3 Flash Pro (Fast/Accurate)</option>
                      <option value="gemini-2.0-flash-exp">Gemini 2.0 Flash (Balanced)</option>
                    </select>
                  </div>
                </section>
              </div>

              <div className="p-6 border-t border-white/10 flex gap-4 bg-slate-900/50">
                <button 
                  onClick={saveSettings}
                  className="flex-1 py-3 bg-blue-600 text-white font-bold text-xs uppercase tracking-widest rounded-xl hover:bg-blue-500 transition-all"
                >
                  Confirm and Sync Settings
                </button>
                <button 
                  onClick={() => setShowSettings(false)}
                  className="px-8 py-3 bg-slate-700 text-white font-bold text-xs uppercase tracking-widest rounded-xl hover:bg-slate-600 transition-all"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showDeploymentGuide && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-[#0B0F1A]/90 backdrop-blur-md">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="w-full max-w-xl bg-[#131B2D] border border-white/10 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
            >
              <div className="p-6 border-b border-white/10 flex justify-between items-center bg-slate-900/50">
                <div className="flex items-center gap-3">
                  <Terminal className="text-blue-500" size={20} />
                  <h2 className="text-xl font-bold text-white uppercase tracking-tight">Deploy New Wazuh Agent</h2>
                </div>
                <button onClick={() => setShowDeploymentGuide(false)} className="text-slate-500 hover:text-white">
                  <LogOut size={20} className="rotate-180" />
                </button>
              </div>
              <div className="p-8 space-y-6">
                <p className="text-slate-400 text-sm">Deploying a Wazuh agent allows this AI orchestration engine to monitor your infrastructure in real-time.</p>
                
                <div className="space-y-4">
                  <div className="p-4 bg-slate-950 rounded-lg border border-white/5 font-mono text-xs">
                    <p className="text-blue-400 mb-2 uppercase font-bold text-[9px] tracking-widest">// Linux (Ubuntu/Debian) One-Liner</p>
                    <code className="text-slate-300 break-all">
                      wget https://packages.wazuh.com/4.x/apt/pool/main/w/wazuh-agent/wazuh-agent_4.7.2-1_amd64.deb && sudo WAZUH_MANAGER='{settings.wazuhUrl.replace(/https?:\/\//, "").replace(/:55000/, "")}' dpkg -i wazuh-agent_4.7.2-1_amd64.deb && sudo systemctl start wazuh-agent
                    </code>
                  </div>

                  <div className="p-4 bg-slate-950 rounded-lg border border-white/5 font-mono text-xs">
                    <p className="text-blue-400 mb-2 uppercase font-bold text-[9px] tracking-widest">// Quick Start Tip</p>
                    <ul className="list-disc list-inside space-y-2 text-slate-400">
                      <li>Ensure your Wazuh Manager port 1514 (UDP/TCP) is open.</li>
                      <li>The agent will automatically register using the manager address.</li>
                      <li>Check the "Active Assets" sidebar in 2-3 minutes.</li>
                    </ul>
                  </div>
                </div>
              </div>
              <div className="p-6 border-t border-white/10 flex bg-slate-900/50">
                <button 
                  onClick={() => setShowDeploymentGuide(false)}
                  className="flex-1 py-3 bg-blue-600 text-white font-bold text-xs uppercase tracking-widest rounded-xl hover:bg-blue-500 transition-all font-mono"
                >
                  Understood. Listening for new heartbeats_
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.05); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.1); }
        select { background-image: url("data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22white%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E"); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1em; }
      `}</style>
    </div>
  );
}
