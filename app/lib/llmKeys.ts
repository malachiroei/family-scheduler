/**
 * Resolve LLM API keys from every env name this project has used.
 * NEXT_PUBLIC_* values are also read with bracket access so Vercel runtime
 * env still works if Next inlined an empty value at build time.
 */
const clean = (value: unknown) => String(value ?? "").trim().replace(/^["']|["']$/g, "");

const readEnv = (name: string, buildTime?: string) => clean(buildTime) || clean(process.env[name]);

/** Static refs so Next can inline public keys; runtime fallbacks cover Vercel. */
export const resolveGeminiApiKey = () =>
  readEnv("GEMINI_API_KEY", process.env.GEMINI_API_KEY) ||
  readEnv("NEXT_PUBLIC_GEMINI_API_KEY", process.env.NEXT_PUBLIC_GEMINI_API_KEY) ||
  readEnv("GOOGLE_GENERATIVE_AI_API_KEY", process.env.GOOGLE_GENERATIVE_AI_API_KEY) ||
  readEnv("GOOGLE_API_KEY", process.env.GOOGLE_API_KEY) ||
  readEnv("NEXT_PUBLIC_GOOGLE_GENERATIVE_AI_API_KEY", process.env.NEXT_PUBLIC_GOOGLE_GENERATIVE_AI_API_KEY) ||
  readEnv("NEXT_PUBLIC_GOOGLE_API_KEY", process.env.NEXT_PUBLIC_GOOGLE_API_KEY);

export const resolveOpenAIApiKey = () =>
  readEnv("OPENAI_API_KEY", process.env.OPENAI_API_KEY) ||
  readEnv("NEXT_PUBLIC_OPENAI_API_KEY", process.env.NEXT_PUBLIC_OPENAI_API_KEY);

/** Copy a public Gemini key onto GEMINI_API_KEY so GoogleGenAI can pick it up. */
export const applyGeminiKeyToProcessEnv = (apiKey = resolveGeminiApiKey()) => {
  if (apiKey && !clean(process.env.GEMINI_API_KEY)) {
    process.env.GEMINI_API_KEY = apiKey;
  }
  return apiKey;
};
