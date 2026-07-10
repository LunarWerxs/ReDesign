// Preloaded before every test file (see bunfig.toml [test].preload). Sets fake
// key pools BEFORE anything reads them, so the whole suite runs entirely
// offline (mock provider + fake keys) and spends no API quota. No real .env
// is loaded here.
process.env.ANTHROPIC_API_KEYS = "sk-ant-aaa1,sk-ant-aaa2,sk-ant-aaa3";
process.env.GEMINI_FLASH_API_KEYS = "AIza-f1,AIza-f2,AIza-f3,AIza-f4,AIza-f5";
process.env.DEEPSEEK_API_KEYS = "sk-d1,sk-d2,sk-d3,sk-d4,sk-d5";
process.env.OPENAI_API_KEYS = "sk-proj-o1,sk-proj-o2";
process.env.COOLDOWN_RATE_LIMIT_SEC = "60";
