import path from "node:path";

/** Everything read from the environment, in one place. See .env.example. */
export interface Config {
  dataDir: string;
  anthropicApiKey?: string;
  claudeModel: string;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId: string;
  elevenLabsModel: string;
  runwayApiKey?: string;
  runwayEnabled: boolean;
  runwayMaxClips: number;
  epcEmail?: string;
  epcApiKey?: string;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  reviewer: string;
  /** Chrome for Remotion. Unset: Remotion downloads its own headless shell on first render. */
  browserExecutable?: string;
  /** Force mock providers even when keys are present (tests, offline runs). */
  mock: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  return {
    dataDir: path.resolve(env.PP_DATA_DIR ?? "data"),
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    claudeModel: env.CLAUDE_MODEL ?? "claude-opus-5-5",
    elevenLabsApiKey: env.ELEVENLABS_API_KEY || undefined,
    // A British English voice from the ElevenLabs library; set your own brand voice here.
    elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb",
    elevenLabsModel: env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2",
    runwayApiKey: env.RUNWAYML_API_SECRET || undefined,
    runwayEnabled: env.RUNWAY_ENABLED === "true",
    runwayMaxClips: Number(env.RUNWAY_MAX_CLIPS ?? 3),
    epcEmail: env.EPC_API_EMAIL || undefined,
    epcApiKey: env.EPC_API_KEY || undefined,
    supabaseUrl: env.SUPABASE_URL || undefined,
    supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY || undefined,
    reviewer: env.PP_REVIEWER ?? "krish",
    browserExecutable: env.REMOTION_BROWSER_EXECUTABLE || undefined,
    mock: env.PP_MOCK === "true",
    ...overrides,
  };
}
