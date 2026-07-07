import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { resolveLLMConfig } = await import("./llm.ts?actual=1");

describe("resolveLLMConfig", () => {
  const originalEnv = { ...process.env };
  let home = "";

  beforeEach(() => {
    home = join(tmpdir(), `xfeel-codex-home-${crypto.randomUUID()}`);
    process.env.CODEX_HOME = join(home, ".codex");
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_API_KEY;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  test("codex config takes precedence over xfeel-specific environment variables", () => {
    writeCodexConfig(home, {
      config: `
model_provider = "custom"
model = "gpt-5.5"

[model_providers.custom]
base_url = "https://codex.example/v1"
requires_openai_auth = true
`,
      auth: { OPENAI_API_KEY: "codex-key" },
    });
    process.env.LLM_BASE_URL = "https://env.example";
    process.env.LLM_MODEL = "env-model";
    process.env.LLM_API_KEY = "env-key";

    expect(resolveLLMConfig()).toMatchObject({
      baseUrl: "https://codex.example/v1",
      model: "gpt-5.5",
      apiKey: "codex-key",
    });
  });

  test("falls back to codex config without exposing the key", () => {
    writeCodexConfig(home, {
      config: `
model_provider = "custom"
model = "gpt-5.5"

[model_providers.custom]
base_url = "https://api.example.test/v1"
requires_openai_auth = true
`,
      auth: { OPENAI_API_KEY: "fake-codex-key" },
    });

    expect(resolveLLMConfig()).toMatchObject({
      baseUrl: "https://api.example.test/v1",
      model: "gpt-5.5",
      apiKey: "fake-codex-key",
    });
  });

  test("uses local defaults when codex config cannot be read", () => {
    expect(resolveLLMConfig()).toMatchObject({
      baseUrl: "http://localhost:11434",
      model: "gemma3:12b",
      apiKey: undefined,
    });
  });
});

function writeCodexConfig(home: string, input: { config: string; auth: { OPENAI_API_KEY: string } }) {
  const codexDir = process.env.CODEX_HOME || join(home, ".codex");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, "config.toml"), input.config.trimStart());
  writeFileSync(join(codexDir, "auth.json"), JSON.stringify(input.auth));
}
