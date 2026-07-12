const path = require("node:path");

const root = __dirname;

module.exports = {
  apps: [
    {
      name: "xfeel-ollama",
      script: path.join(root, "scripts/ensure-ollama.sh"),
      interpreter: "/bin/sh",
      cwd: root,
      autorestart: true,
      restart_delay: 2000,
      env: {
        OLLAMA_HOST: "127.0.0.1:11434",
        OLLAMA_BIN: process.env.OLLAMA_BIN || "/usr/local/bin/ollama",
      },
    },
    {
      name: "xfeel-v3-ingest",
      script: path.join(root, "scripts/start-ingest.sh"),
      interpreter: "/bin/sh",
      cwd: root,
      autorestart: true,
      restart_delay: 2000,
      env: {
        OLLAMA_BASE_URL: "http://127.0.0.1:11434",
        XFEEL_EMBEDDING_MODEL: "qwen3-embedding:0.6b",
      },
    },
  ],
};
