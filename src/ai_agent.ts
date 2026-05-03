import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface AnalysisResponse {
  threat_type: string;
  severity: "Low" | "Medium" | "High" | "Critical";
  confidence: number;
  summary: string;
  recommended_action: string;
  mitre_attack: string;
}

export async function analyzeAlert(rawLog: string): Promise<AnalysisResponse> {
  const prompt = `Analyze the following security log and provide a detailed threat assessment in JSON format.
  
  Log: ${rawLog}
  
  Required keys:
  - threat_type: e.g., Brute Force, Malware, SQL Injection
  - severity: Low, Medium, High, Critical
  - confidence: $ (0.0 to 1.0)
  - summary: Concise explanation of the threat and root cause
  - recommended_action: What the SOC analyst should do next
  - mitre_attack: Corresponding MITRE ATT&CK technique code (e.g., T1110)`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            threat_type: { type: Type.STRING },
            severity: { type: Type.STRING, enum: ["Low", "Medium", "High", "Critical"] },
            confidence: { type: Type.NUMBER },
            summary: { type: Type.STRING },
            recommended_action: { type: Type.STRING },
            mitre_attack: { type: Type.STRING },
          },
          required: ["threat_type", "severity", "confidence", "summary", "recommended_action", "mitre_attack"],
        },
      },
    });

    const text = response.text;
    if (!text) throw new Error("No response from AI");
    return JSON.parse(text) as AnalysisResponse;
  } catch (error) {
    console.error("AI Analysis failed:", error);
    throw error;
  }
}
