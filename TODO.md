# Open Source TODO

## Features / Roadmap

- [x] 支持拉取任意历史日期的日志。（2026-07 已做）
  - `GET /memories/day` 按 `memory_events.event_date`（缺失时回退 `created_at` 日期）返回某 owner 某天的长期记忆。
  - 用户端 `/app` 按日期浏览时：`conversation_turns` 为空的历史日自动改渲染记忆卡片；`GET /memories/calendar` 提供日历亮点。

## Must Do Before Public Release

- [x] Rotate/retire Parse credentials that were previously committed; the Parse integration was removed.
  - Historical commits contained a Parse application id and master key in scripts.
  - Treat those credentials as compromised even though the current source no longer includes the old Parse integration scripts.
- [x] Rewrite Git history before pushing to a public remote.（2026-07-07 已重开并清理旧对象）
  - Use `git filter-repo` or BFG to remove historical Parse credentials.
  - After rewriting, re-run a secret scan across all refs, not just `HEAD`.
- [x] Choose and add a license.（MIT 已完成）
  - Add `LICENSE`.
  - Add matching `license` metadata to `package.json` if this project will be published as a package.
- [ ] Add remaining public repo hygiene file: `SECURITY.md`.（`.env.example` / `CONTRIBUTING.md` 已完成）
  - `.env.example`
  - `SECURITY.md`
  - `CONTRIBUTING.md`
  - Optional: `CODE_OF_CONDUCT.md`
- [ ] Decide package/publication metadata.
  - Rename `package.json` from `xfeel-v2` if needed.
  - Decide whether `private: true` should remain.
  - Add repository, description, author, and keywords metadata.
- [x] Make CI green and explicit.（`bun run typecheck` + `bun test` + GitHub Actions）
  - Keep `bun test` as the baseline.
  - Fix or scope `tsc --noEmit` so typecheck has a stable public command.
  - Add CI workflow after the commands are reliable.

## Data And Privacy

- [ ] Rename or split the `real` eval harness and fixture names.
  - Current fixture contents are sanitized, but filenames such as `recall-real-queries.json` still imply private production data.
  - Prefer `recall-synthetic-queries.json` / `precision-synthetic-queries.json` or keep private fixtures in a separate non-public repo.
- [ ] Re-review docs for private operational context.
  - Replace internal model/provider notes with generic OpenAI-compatible/Ollama examples.
  - Remove outdated `v2` references where they confuse the public story.
- [ ] Ensure release artifacts exclude local data.
  - Do not include `data/*.db`, `data/backups/`, `data/context/`, `data/compare/`, or `data/ab-test/` in archives, Docker images, or GitHub releases.
- [ ] Decide whether dashboard and diary endpoints need auth by default.
  - `/diaries`, dashboard views, and analytics can expose raw user text in self-hosted deployments.
- [x] 网页接口鉴权中间件（对外/多用户前必做）。（已落地并继续加固）
  - `onRequest` 校验 JWT/admin token；`preHandler` 校验请求中的 `owner_id`/`user_id`/`family_id` 必须属于登录家庭。
  - 2026-07 加固：`?token=` 查询参数与 media-scope 短 token 只能读 `GET /media/:id`（长期会话 JWT 不再进 URL）；`GET /web/media-token` 签发 24h 只读媒体 token。

## Repo Cleanup

- [ ] Remove or untrack local tool config.
  - `.claude/settings.json` is currently tracked and should likely be local-only.
- [x] Add automated secret scanning.（CI 使用 gitleaks）
  - At minimum run a one-shot scan before public release.
  - Prefer CI or pre-commit coverage for future changes.
- [ ] Audit one-time repair and experiment scripts.
  - Old Parse migration and model A/B scripts have been removed from the public tree.
  - Consider moving any remaining private repair scripts to `scripts/private/` or a separate private repo.
  - Keep only generally useful public examples in this repo.
