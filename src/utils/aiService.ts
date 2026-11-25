/**
 * OpenAI-compatible AI Structuring & Summarization Service
 * Ported from FileLensProTestBundle (supports NVIDIA NIM, OpenAI, Gemini, DeepSeek, Groq, LM Studio).
 */

export interface AiProviderPreset {
  id: string;
  label: string;
  endpoint: string;
  defaultModel: string;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    defaultModel: 'meta/llama-3.1-70b-instruct',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'gemini',
    label: 'Google Gemini (OpenAI Compat)',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    defaultModel: 'gemini-2.5-flash',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'groq',
    label: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    id: 'local',
    label: 'Local LM Studio / Ollama',
    endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
    defaultModel: 'local-model',
  },
];

export interface AiConfig {
  providerId: string;
  endpoint: string;
  apiKey: string;
  model: string;
}

const STORAGE_KEY = 'fl_ai_config_v1';

export function loadAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AiConfig>;
      const preset = AI_PROVIDER_PRESETS.find((p) => p.id === parsed.providerId) ?? AI_PROVIDER_PRESETS[0];
      return {
        providerId: parsed.providerId || preset.id,
        endpoint: parsed.endpoint || preset.endpoint,
        apiKey: parsed.apiKey || '',
        model: parsed.model || preset.defaultModel,
      };
    }
  } catch {
    // ignore storage errors
  }
  const def = AI_PROVIDER_PRESETS[0];
  return {
    providerId: def.id,
    endpoint: def.endpoint,
    apiKey: '',
    model: def.defaultModel,
  };
}

export function saveAiConfig(cfg: AiConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // ignore storage errors
  }
}

export async function structureOcrTextWithAi(
  ocrText: string,
  format: 'markdown' | 'csv' | 'summary' = 'markdown'
): Promise<string> {
  const cfg = loadAiConfig();
  if (!cfg.endpoint) {
    throw new Error('Configure an AI endpoint in Settings first');
  }
  if (!cfg.apiKey && cfg.providerId !== 'local') {
    throw new Error('Add your AI API Key in Settings -> AI Structuring');
  }

  const instruction =
    format === 'csv'
      ? 'Extract all structured fields, dates, amounts, names, and table rows from this document text into clean CSV format (no code fences).'
      : format === 'summary'
        ? 'Summarize this document into clear bullet points highlighting key dates, names, amounts, and action items.'
        : 'Structure this OCR text into clean Markdown with headings, key-value fields, and Markdown tables where appropriate.';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.15,
      max_tokens: 1800,
      messages: [
        { role: 'system', content: 'You are a precise document intelligence extractor.' },
        { role: 'user', content: `${instruction}\n\nDocument text:\n${ocrText.slice(0, 12000)}` },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`AI request failed (${res.status}): ${errText.slice(0, 120)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty response from AI provider');
  return content;
}
