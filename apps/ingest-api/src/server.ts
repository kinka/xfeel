import Fastify, { type FastifyRequest } from "fastify";
import crypto from "node:crypto";
import cors from "@fastify/cors";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDB, closeDB } from "../../../packages/db/src/database";
import { initSchema } from "../../../packages/db/src/schema";
import { downloadAndStoreMedia, recordMediaCaption, getMediaAssetAbsPath, getMediaAsset, saveMediaBuffer } from "../../../packages/db/src/media-assets";
import { purgeMessage, purgeEvents } from "../../../packages/db/src/purge";
import { captionImageToDiary } from "../../../packages/extractors/src/vision";
import { processMessage } from "../../../packages/pipeline/src/pipeline";
import { recall, getStats, getTagStats, getEmotionStats, getTimelineStats, getEntityGraph } from "../../../packages/retrieval/src/recall";
import { queryEvents } from "../../../packages/retrieval/src/events-query";
import { TAG_GROUPS, ALL_TAGS } from "../../../packages/domain/src/tag-vocabulary";
import { PLUTCHIK_EMOTIONS, ALL_EMOTIONS } from "../../../packages/domain/src/emotion-vocabulary";
import {
  runBatchNormalization, getNormalizationStats,
  getEmotionHeatmap, getEmotionTrends, getLifePhases,
  comparePersons, getEntityTimeline, getAnalyticsSummary,
  getOwnerDailyMoods, getOwnerEmotionReview, type OwnerEmotionReview,
  getMilestones, peekMilestones, scheduleMilestoneRebuild,
} from "../../../packages/analyzer/src/index";
import { getLLM } from "../../../packages/ai-client/src/llm";
import { roleLLMConfig } from "../../../packages/ai-client/src/roles";
import {
  chatWithMemory, getConversationTurns, handleProductMessage, logWithContextualReply, recordConversationTurn,
  loadAmbientContext, loadUnderstandingContext, getLongTermProfile, getRecentProfile,
  applyUnderstandingFeedback, listUnderstandingFeedback, saveUnderstandingFeedback, understandingKey,
  type ConversationTurn,
} from "../../../packages/conversation/src/index";
import { getDailyArchives, runDailyArchive } from "../../../packages/archive/src/index";
import { dismissCare, getCareItem, listDeliverableCare, takeCareLineForWechat } from "../../../packages/care/src/index";
import { normalizeLocalDate } from "../../../packages/domain/src/local-date";
import {
  getFamilySummary, upsertFamilyOnboarding,
  autoProvisionFamilyForSpeaker, setSpeakerSelf, updateFamilyName,
  getSpeakerOnboardingState, markSpeakerReminded,
  createFamilyInvite, joinFamilyByInvite, getFamilyOwnerIds, addFamilyChild,
} from "../../../packages/db/src/family";
import {
  createWebLoginCode, claimWebLoginCode, getWebLoginStatus, redeemWebLoginCode, normalizeLoginCode,
  authorizeWebSessionForWechat,
} from "../../../packages/db/src/web-auth";
import { signWebToken, verifyWebToken, type WebTokenClaims } from "../../../packages/db/src/web-jwt";
import { hashId, logError, logInfo, logWarn, maskId, previewText, safeErrorMessage, textLogFields } from "../../../packages/observability/src/logging";
import {
  DEFAULT_EMBEDDING_KEEP_ALIVE,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_NUM_CTX,
  DEFAULT_OLLAMA_BASE_URL,
  warmOllamaEmbedding,
  type OllamaEmbeddingWarmupResult,
} from "../../../scripts/embedding-common";

const PORT = Number(process.env.PORT) || 8000;
const PLAYGROUND_DAD_OWNER_ID = process.env.XFEEL_DAD_OWNER_ID || "demo-dad-owner";
const PLAYGROUND_MOM_OWNER_ID = process.env.XFEEL_MOM_OWNER_ID || "demo-mom-owner";
let embeddingStartupStatus: OllamaEmbeddingWarmupResult | { ok: false; skipped: true; reason: string } = {
  ok: false,
  skipped: true,
  reason: "not_started",
};

export async function buildApp() {
  wechatRetryCache.clear();
  const app = Fastify({
    // pm2 logs 友好：JSON 结构化日志，level 可用 LOG_LEVEL 调（trace/debug/info/warn/error）。
    logger: {
      level: process.env.LOG_LEVEL || "info",
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
    },
    // 只有部署在受信反代（nginx 等）之后才设 XFEEL_TRUST_PROXY=1：开启后 req.ip 取
    // X-Forwarded-For 最后一跳；关闭时该头是客户端可随意伪造的，绝不能用于限流键。
    trustProxy: /^(1|true|yes|on)$/i.test(process.env.XFEEL_TRUST_PROXY || ""),
  });

  // 网页登录接口 IP 级频控：创建暗号和兑换暗号分别限流，防止对 6 位短暗号暴力枚举。
  interface RateLimitEntry { count: number; resetAt: number; }
  const loginStartRateLimit = new Map<string, RateLimitEntry>();
  const loginRedeemRateLimit = new Map<string, RateLimitEntry>();

  function getClientIp(req: FastifyRequest): string {
    return req.ip || "unknown";
  }

  function checkRateLimit(map: Map<string, RateLimitEntry>, key: string, maxAttempts: number, windowMs: number): boolean {
    const now = Date.now();
    const entry = map.get(key);
    if (!entry || now > entry.resetAt) {
      map.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= maxAttempts) return false;
    entry.count += 1;
    return true;
  }

  app.addContentTypeParser("text/xml", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("application/xml", { parseAs: "string" }, (_req, body, done) => done(null, body));
  await app.register(cors);

  // === 网页登录鉴权（JWT）===
  // 网页数据接口一律要求有效 JWT（localStorage + Authorization: Bearer，或 <img>/<a> 用 ?token= 传）。
  // 放行：登录页面本身、静态资源、登录流程、公众号回调、健康检查。
  // 本地脚本/测试可用 XFEEL_AUTH_DISABLED=1 整体旁路。
  // 认证：解析并校验凭证，把身份挂到 req.auth（admin / 登录者所在家庭的 owner 集合）。
  // 带 XFEEL_ADMIN_TOKEN 的请求即 admin，可看所有家庭（绕过隔离）。
  app.addHook("onRequest", (req, reply, done) => {
    if (authDisabled()) return done();
    const path = req.url.split("?")[0] || "/";
    if (isPublicPath(req.method, path)) return done();

    const extracted = extractRequestToken(req.headers.authorization, req.url);
    const token = extracted?.value ?? null;
    // URL 查询参数里的凭证会进日志/缓存/Referer，只允许它换取「读单张媒体」这一件事。
    const queryTokenAllowed = !extracted?.fromQuery || isMediaFetchPath(req.method, path);
    const adminToken = process.env.XFEEL_ADMIN_TOKEN?.trim();
    if (adminToken && token && token === adminToken) {
      if (!queryTokenAllowed) {
        reply.status(401).send({ error: "unauthorized", reason: "query_token_media_only" });
        return;
      }
      (req as AuthedRequest).auth = { admin: true, ownerIds: null };
      return done();
    }
    const claims = token ? verifyWebToken(token) : null;
    if (!claims) {
      reply.status(401).send({ error: "unauthorized", login: "/app" });
      return; // 不调用 done()：中止请求，不进入路由处理
    }
    // media-scope 短 token 只能读媒体，拿到手也换不来数据接口权限。
    if ((!queryTokenAllowed || claims.scope === "media") && !isMediaFetchPath(req.method, path)) {
      reply.status(401).send({ error: "unauthorized", reason: "token_scope" });
      return;
    }
    (req as AuthedRequest).auth = { admin: false, claims, ownerIds: new Set(getFamilyOwnerIds(claims.fam)) };
    done();
  });

  // 授权（多租户隔离）：body 已解析。admin 放行一切；全局分析面板仅 admin 可见；
  // 其余接口出现的 owner_id/user_id 必须属于登录者所在家庭，否则 403。
  app.addHook("preHandler", (req, reply, done) => {
    const auth = (req as AuthedRequest).auth;
    if (!auth || auth.admin) return done(); // 公开路由无 auth；admin 看所有
    const path = req.url.split("?")[0] || "/";
    if (isAdminOnlyPath(req.method, path)) {
      reply.status(403).send({ error: "forbidden", reason: "admin_only" });
      return;
    }
    for (const owner of collectOwnerCandidates(req)) {
      if (!auth.ownerIds || !auth.ownerIds.has(owner)) {
        reply.status(403).send({ error: "forbidden", reason: "owner_scope" });
        return;
      }
    }
    // family_id 同样是身份入参（resolveMessageIdentity 会优先用它定位家庭），必须与登录家庭一致。
    for (const fam of collectFamilyCandidates(req)) {
      if (fam !== auth.claims?.fam) {
        reply.status(403).send({ error: "forbidden", reason: "family_scope" });
        return;
      }
    }
    done();
  });

  // 兜底错误处理：任何未被 handler 捕获的异常都带 reqId + 堆栈 + 路由记录，方便 pm2 排查。
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = typeof err.statusCode === "number" && err.statusCode >= 400 ? err.statusCode : 500;
    req.log.error({ err, method: req.method, url: req.url, status }, "unhandled request error");
    return reply.status(status).send({ error: err.message });
  });
  // 慢请求标记：完成时记录方法/路由/状态码/耗时，便于定位卡顿（LLM 调用慢等）。
  app.addHook("onResponse", (req, reply, done) => {
    const ms = Math.round(reply.elapsedTime);
    const line = { method: req.method, url: req.url, status: reply.statusCode, ms };
    if (ms >= 5000 || reply.statusCode >= 500) req.log.warn(line, "request slow/failed");
    done();
  });

  // 初始化数据库
  const db = getDB();
  initSchema(db);
  app.log.info("Database initialized");

  // === 记忆管线 API ===

  /** POST /onboarding/family — 初始化/更新家庭成员、说话人和称呼映射 */
  app.post("/onboarding/family", async (req, reply) => {
    try {
      const summary = upsertFamilyOnboarding(req.body as any);
      return reply.send(summary);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(400).send({ error: msg });
    }
  });

  /** GET /onboarding/summary — 查看家庭初始化结果和当前账号视角 */
  app.get("/onboarding/summary", async (req, reply) => {
    const { family_id, speaker_profile_id, platform, external_user_id } = req.query as Record<string, string>;
    try {
      const summary = getFamilySummary({ family_id, speaker_profile_id, platform, external_user_id });
      if (!summary) return reply.status(404).send({ error: "family not found" });
      return reply.send(summary);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** POST /ingest — 摄取消息（完整管线） */
  app.post("/ingest", async (req, reply) => {
    const { text, owner_id, user_id, force, family_id, speaker_profile_id, platform } = req.body as {
      text: string;
      owner_id?: string;
      user_id?: string;
      force?: boolean;
      family_id?: string;
      speaker_profile_id?: string;
      platform?: string;
    };
    if (!text?.trim()) return reply.status(400).send({ error: "text is required" });

    try {
      const identity = resolveMessageIdentity({ owner_id, user_id, family_id, speaker_profile_id, platform });
      const result = await processMessage(text, {
        ownerId: identity.ownerId,
        userId: identity.ownerId,
        speakerId: identity.speakerId,
        speakerLabel: identity.speakerLabel,
        aliasContext: identity.aliasContext,
        force,
      });
      return reply.send(result);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      req.log.error({ err, owner: owner_id ?? user_id, text_preview: text.slice(0, 40) }, "ingest failed");
      return reply.status(500).send({ error: err.message });
    }
  });

  /** POST /ingest/batch — 批量摄取 */
  app.post("/ingest/batch", async (req, reply) => {
    const { messages, owner_id, user_id, force } = req.body as {
      messages: string[];
      owner_id?: string;
      user_id?: string;
      force?: boolean;
    };
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: "messages array is required" });
    }
    if (messages.length > 50) {
      return reply.status(400).send({ error: "max 50 messages per batch" });
    }

    const results = [];
    for (const text of messages) {
      try {
        const result = await processMessage(text, { ownerId: owner_id ?? user_id, force });
        results.push({ text: text.slice(0, 30), ...result });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ text: text.slice(0, 30), error: msg });
      }
    }

    return reply.send({
      total: messages.length,
      processed: results.filter(r => !r.error).length,
      errors: results.filter(r => r.error).length,
      results,
    });
  });

  /** POST /recall — 检索记忆 */
  app.post("/recall", async (req, reply) => {
    try {
      const result = recall(req.body as any);
      return reply.send(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** POST /conversation/turn — 记录一条对话，不立即抽取为长期记忆 */
  app.post("/conversation/turn", async (req, reply) => {
    const { content, text, owner_id, user_id, role, date, source, metadata } = req.body as {
      content?: string;
      text?: string;
      owner_id?: string;
      user_id?: string;
      role?: "user" | "assistant" | "system";
      date?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    };
    try {
      const turn = recordConversationTurn({
        content: content ?? text ?? "",
        owner_id,
        user_id,
        role,
        turn_date: date,
        source,
        metadata,
      });
      return reply.send(turn);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(400).send({ error: msg });
    }
  });

  /** POST /conversation/message — 产品闭环入口：记/查/总结今天/撤销/修正/普通聊天 */
  app.post("/conversation/message", async (req, reply) => {
    const { text, owner_id, user_id, date, limit, family_id, speaker_profile_id, platform } = req.body as {
      text: string;
      owner_id?: string;
      user_id?: string;
      date?: string;
      limit?: number;
      family_id?: string;
      speaker_profile_id?: string;
      platform?: string;
    };
    if (!text?.trim()) return reply.status(400).send({ error: "text is required" });
    const startedAt = Date.now();
    try {
      const identity = resolveRequestIdentity(req, { owner_id, user_id, family_id, speaker_profile_id, platform });
      const result = await handleProductMessage({
        text,
        owner_id: identity.ownerId,
        user_id: identity.ownerId,
        scope_owner_ids: identity.scopeOwnerIds,
        date,
        limit,
        speaker_id: identity.speakerId,
        speaker_label: identity.speakerLabel,
        aliasContext: identity.aliasContext,
      });
      // 产品主链路：记录意图/召回数/耗力/回复长度，pm2 里一行就能看清一次交互。
      req.log.info({
        owner: identity.ownerId,
        intent: result.intent,
        recalled: "events" in result ? result.events?.length ?? 0 : 0,
        reply_len: result.reply?.length ?? 0,
        ms: Date.now() - startedAt,
        text_preview: text.slice(0, 40),
      }, "conversation/message ok");
      return reply.send(result);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      req.log.error({ err, owner: owner_id ?? user_id, ms: Date.now() - startedAt, text_preview: text.slice(0, 40) }, "conversation/message failed");
      return reply.status(500).send({ error: err.message });
    }
  });

  /** GET /media/:id — 回看已落地的图片/媒体（按资产 id 取，避免路径穿越）。 */
  app.get("/media/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const asset = getMediaAsset(id);
    if (!asset) return reply.status(404).send({ error: "media not found" });
    // 多租户隔离：非 admin 只能取自己家庭的图片；不属于本家庭一律当 404（不泄露存在性）。
    const auth = (req as AuthedRequest).auth;
    if (auth && !auth.admin && !(asset.owner_id && auth.ownerIds?.has(asset.owner_id))) {
      return reply.status(404).send({ error: "media not found" });
    }
    try {
      const bytes = readFileSync(getMediaAssetAbsPath(asset));
      return reply.type(asset.mime || "application/octet-stream").send(bytes);
    } catch {
      return reply.status(410).send({ error: "media file missing" });
    }
  });

  /** POST /conversation/chat — 记录用户对话，召回记忆并生成回复 */
  app.post("/conversation/chat", async (req, reply) => {
    const { text, owner_id, user_id, date, limit } = req.body as {
      text: string;
      owner_id?: string;
      user_id?: string;
      date?: string;
      limit?: number;
    };
    if (!text?.trim()) return reply.status(400).send({ error: "text is required" });
    try {
      const result = await chatWithMemory({ text, owner_id, user_id, date, limit });
      return reply.send(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** POST /conversation/log — 记录日志，自动召回上下文并生成短回复 */
  app.post("/conversation/log", async (req, reply) => {
    const { text, owner_id, user_id, date, force, limit, family_id, speaker_profile_id, platform } = req.body as {
      text: string;
      owner_id?: string;
      user_id?: string;
      date?: string;
      force?: boolean;
      limit?: number;
      family_id?: string;
      speaker_profile_id?: string;
      platform?: string;
    };
    if (!text?.trim()) return reply.status(400).send({ error: "text is required" });
    try {
      const identity = resolveRequestIdentity(req, { owner_id, user_id, family_id, speaker_profile_id, platform });
      const result = await logWithContextualReply({
        text,
        owner_id: identity.ownerId,
        user_id: identity.ownerId,
        scope_owner_ids: identity.scopeOwnerIds,
        date,
        force,
        limit,
        speaker_id: identity.speakerId,
        speaker_label: identity.speakerLabel,
        aliasContext: identity.aliasContext,
      });
      return reply.send(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /conversation/turns — 查询当天对话 */
  app.get("/conversation/turns", async (req, reply) => {
    const { owner_id, user_id, date, limit, include_archived } = req.query as Record<string, string>;
    try {
      const turns = getConversationTurns({
        owner_id,
        user_id,
        date,
        limit: limit ? Number(limit) : undefined,
        include_archived: include_archived === "true",
      });
      // 附上每条 turn 关联的媒体（图片等），让 playground 对话流能显示原图。
      const ownerId = (owner_id || user_id || "").trim();
      const mediaByTurn = ownerId ? loadPlaygroundMedia(ownerId, turns.map(turn => turn.id)) : new Map();
      const enriched = turns.map(turn => ({ ...turn, media: mediaByTurn.get(turn.id) || [] }));
      return reply.send({ turns: enriched, total: turns.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /**
   * POST /conversation/turns/delete — 删除一条测试/错误对话（连带它派生的事件、向量、媒体、助手回复气泡）。
   * 传 turn_id（playground 用）或 message_id。日记 turn 会解析出其 pipeline_message_id 一并清干净。
   */
  app.post("/conversation/turns/delete", async (req, reply) => {
    const { turn_id, message_id, owner_id, user_id } = req.body as { turn_id?: string; message_id?: string; owner_id?: string; user_id?: string };
    try {
      let messageId = message_id?.trim();
      let resourceOwnerId: string | undefined;
      if (!messageId && turn_id?.trim()) {
        const turn = getDB().prepare("SELECT id, owner_id, metadata FROM conversation_turns WHERE id = ?").get(turn_id.trim()) as { id: string; owner_id?: string; metadata?: string } | undefined;
        if (!turn) return reply.status(404).send({ error: "turn not found" });
        resourceOwnerId = turn.owner_id?.trim() || undefined;
        let pipelineMessageId: string | undefined;
        try { pipelineMessageId = turn.metadata ? (JSON.parse(turn.metadata).pipeline_message_id as string | undefined) : undefined; } catch { /* ignore */ }
        messageId = pipelineMessageId || turn.id;
      }
      if (!messageId) return reply.status(400).send({ error: "turn_id or message_id is required" });
      const auth = (req as AuthedRequest).auth;
      if (auth && !auth.admin) {
        const owners = resourceOwnerId ? [resourceOwnerId] : ownersForPipelineMessage(messageId);
        if (!owners.length) return reply.status(404).send({ error: "message not found" });
        if (owners.some(owner => !auth.ownerIds?.has(owner))) {
          return reply.status(403).send({ error: "forbidden", reason: "owner_scope" });
        }
        resourceOwnerId = owners[0];
      } else if (!resourceOwnerId) {
        resourceOwnerId = (owner_id || user_id || "").trim() || undefined;
      }
      const plan = purgeMessage(messageId, { ownerId: resourceOwnerId });
      return reply.send({ ok: true, deleted: plan });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** POST /events/delete — 删除一条/多条抽取错误的记忆事件（不动对话）。body: { event_id } 或 { event_ids:[] }。 */
  app.post("/events/delete", async (req, reply) => {
    const { event_id, event_ids } = req.body as { event_id?: string; event_ids?: string[] };
    try {
      const ids = (event_ids && event_ids.length ? event_ids : event_id ? [event_id] : []).filter(Boolean);
      if (!ids.length) return reply.status(400).send({ error: "event_id or event_ids is required" });
      // 多租户隔离：非 admin 只能删自己家庭 owner 名下的事件。
      const auth = (req as AuthedRequest).auth;
      if (auth && !auth.admin) {
        const ph = ids.map(() => "?").join(",");
        const owners = getDB().prepare(`SELECT DISTINCT user_id FROM memory_events WHERE id IN (${ph})`).all(...ids) as Array<{ user_id: string | null }>;
        const foreign = owners.some(o => !(o.user_id && auth.ownerIds?.has(o.user_id)));
        if (foreign) return reply.status(403).send({ error: "forbidden", reason: "owner_scope" });
      }
      const result = purgeEvents(ids);
      return reply.send({ ok: true, deleted: result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /conversation/playground/diagnostics — Playground 当天 intent/extract 诊断 */
  app.get("/conversation/playground/diagnostics", async (req, reply) => {
    const { owner_id, user_id, date, limit } = req.query as Record<string, string>;
    try {
      const ownerId = (owner_id || user_id || resolvePlaygroundOwnerDefaults().dadOwnerId).trim();
      const turnDate = normalizeLocalDate(date);
      const turns = getConversationTurns({
        owner_id: ownerId,
        date: turnDate,
        limit: limit ? Number(limit) : 200,
        include_archived: true,
      });
      return reply.send({
        owner_id: ownerId,
        date: turnDate,
        diagnostics: buildPlaygroundDiagnostics(ownerId, turns),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /**
   * GET /conversation/playground/context — 某 owner 某天，回复时实际拼装的完整上下文：
   * L1 当天 ambient（今日对话摘要/近7天归档或滚动周报/开放事实）+ L2 近期状态 + L3 长期理解画像。
   * 用于调试召回/理解层是否合理，而不是只看单条 turn 的 intent/extract 诊断。
   */
  app.get("/conversation/playground/context", async (req, reply) => {
    const { owner_id, user_id, date } = req.query as Record<string, string>;
    const ownerId = (owner_id || user_id || "").trim();
    if (!ownerId) return reply.status(400).send({ error: "owner_id is required" });
    try {
      const turnDate = normalizeLocalDate(date);
      const ambient = loadAmbientContext({ owner_id: ownerId, date: turnDate });
      const understanding = loadUnderstandingContext({ owner_id: ownerId });
      const longTerm = getLongTermProfile(ownerId);
      const recent = getRecentProfile(ownerId);
      const rollingPath = ambient.weeklyContextPath;
      const rollingExists = Boolean(rollingPath && existsSync(rollingPath));
      return reply.send({
        owner_id: ownerId,
        date: turnDate,
        ambient: {
          assembled_text: ambient.text,
          archive_summaries: ambient.archiveSummaries,
          today_turn_snippets: ambient.todayTurnSnippets,
          open_facts: ambient.openFacts,
          rolling_weekly_context_path: rollingPath,
          rolling_weekly_context_used: rollingExists,
        },
        understanding: {
          assembled_text: understanding.text,
          has_long_term: understanding.hasLongTerm,
          has_recent: understanding.hasRecent,
          address_book: understanding.addressBook,
        },
        long_term_profile: longTerm && {
          version: longTerm.version,
          covers_from: longTerm.coversFrom,
          covers_to: longTerm.coversTo,
          evidence_count: longTerm.evidenceCount,
          source_model: longTerm.sourceModel,
          generated_at: longTerm.generatedAt,
          updated_at: longTerm.updatedAt,
          narrative: longTerm.content.narrative,
          understandings: longTerm.content.understandings,
          address_book: longTerm.content.addressBook,
          open_questions: longTerm.content.openQuestions,
        },
        recent_profile: recent && {
          version: recent.version,
          covers_from: recent.coversFrom,
          covers_to: recent.coversTo,
          evidence_count: recent.evidenceCount,
          source_model: recent.sourceModel,
          generated_at: recent.generatedAt,
          updated_at: recent.updatedAt,
          window_days: recent.content.windowDays,
          state_summary: recent.content.stateSummary,
          emotional_trend: recent.content.emotionalTrend,
          open_threads: recent.content.openThreads,
          notable_events: recent.content.notableEvents,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** POST /archive/daily/run — 对某天对话做总结归档并更新图谱事实层 */
  app.post("/archive/daily/run", async (req, reply) => {
    const { date, owner_id, user_id, force, dry_run } = req.body as {
      date?: string;
      owner_id?: string;
      user_id?: string;
      force?: boolean;
      dry_run?: boolean;
    };
    try {
      const result = await runDailyArchive({ date, owner_id, user_id, force, dry_run });
      return reply.send(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /archive/daily — 查询日终归档 */
  app.get("/archive/daily", async (req, reply) => {
    const { owner_id, user_id, date, limit } = req.query as Record<string, string>;
    try {
      const archives = getDailyArchives({
        owner_id,
        user_id,
        date,
        limit: limit ? Number(limit) : undefined,
      });
      return reply.send({ archives, total: archives.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /stats — 统计信息 */
  app.get("/stats", async (_req, reply) => {
    try {
      return reply.send(getStats());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /stats/tags — 标签统计 */
  app.get("/stats/tags", async (_req, reply) => {
    try {
      return reply.send(getTagStats());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /stats/emotions — 情绪统计 */
  app.get("/stats/emotions", async (_req, reply) => {
    try {
      return reply.send(getEmotionStats());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /stats/timeline — 时间线统计 ?period=day|week|month */
  app.get("/stats/timeline", async (req, reply) => {
    const { period = "day" } = req.query as Record<string, string>;
    try {
      return reply.send(getTimelineStats(period as "day" | "week" | "month"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /graph — 实体关系图谱数据 */
  app.get("/graph", async (_req, reply) => {
    try {
      return reply.send(getEntityGraph());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /vocabulary — 返回受控词表 */
  app.get("/vocabulary", async (_req, reply) => {
    return reply.send({
      tags: TAG_GROUPS,
      tags_flat: ALL_TAGS,
      emotions: PLUTCHIK_EMOTIONS,
      emotions_flat: ALL_EMOTIONS,
    });
  });

  /** GET /events — 事件列表 ?type&entity&tag&emotion&owner_id&since&until&limit&offset */
  app.get("/events", async (req, reply) => {
    const q = req.query as Record<string, string>;
    try {
      const result = queryEvents(getDB(), {
        type: q.type,
        entity: q.entity,
        tag: q.tag,
        emotion: q.emotion,
        owner: q.owner_id ?? q.user_id ?? q.owner,
        since: q.since,
        until: q.until,
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      });
      return reply.send(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(400).send({ error: msg });
    }
  });

  /** GET /events/:id — 单个事件 */
  app.get("/events/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDB();
    const row = db.prepare("SELECT * FROM memory_events WHERE id = ?").get(id) as Record<string, unknown> & { user_id?: string | null } | undefined;
    if (!row) return reply.status(404).send({ error: "not found" });
    const auth = (req as AuthedRequest).auth;
    if (auth && !auth.admin && !(row.user_id && auth.ownerIds?.has(row.user_id))) {
      return reply.status(404).send({ error: "not found" });
    }
    return reply.send(row);
  });

  /** GET /entities — 实体列表 */
  app.get("/entities", async (_req, reply) => {
    const db = getDB();
    const rows = db.prepare("SELECT * FROM entities ORDER BY mention_count DESC").all();
    return reply.send(rows);
  });

  /** GET /diaries — 日记列表 */
  app.get("/diaries", async (req, reply) => {
    const { limit = 20, offset = 0 } = req.query as Record<string, any>;
    const db = getDB();
    const rows = db.prepare("SELECT * FROM diaries ORDER BY diary_date DESC LIMIT ? OFFSET ?").all(Number(limit), Number(offset));
    const total = (db.prepare("SELECT COUNT(*) as c FROM diaries").get() as {c: number}).c;
    return reply.send({ diaries: rows, total });
  });

  /** GET /media/list — 照片墙：列出已落地的媒体（id 用于 /media/:id 取图），可按 owner 过滤。 */
  app.get("/media/list", async (req, reply) => {
    const { limit = 60, owner_id, kind } = req.query as Record<string, any>;
    const db = getDB();
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (owner_id) { conditions.push("owner_id = ?"); params.push(String(owner_id)); }
    if (kind) { conditions.push("kind = ?"); params.push(String(kind)); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT id, owner_id, kind, mime, caption, message_id, status, created_at
      FROM media_assets ${where}
      ORDER BY created_at DESC LIMIT ?
    `).all(...params, Number(limit));
    const total = (db.prepare(`SELECT COUNT(*) as c FROM media_assets ${where}`).get(...params) as { c: number }).c;
    return reply.send({ media: rows, total });
  });

  // === 事件归一化 API ===

  /** POST /normalize/run — 批量归一化（去重+因果拆分） */
  app.post("/normalize/run", async (req, reply) => {
    const { lookback_days, dry_run } = req.body as { lookback_days?: number; dry_run?: boolean };
    try {
      const result = await runBatchNormalization({ lookbackDays: lookback_days, dryRun: dry_run });
      return reply.send(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /normalize/stats — 归一化统计 */
  app.get("/normalize/stats", async (_req, reply) => {
    try {
      return reply.send(getNormalizationStats());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  // === 时序分析 API ===

  /** GET /analytics/heatmap — 月度情绪热力图 ?months=24 */
  app.get("/analytics/heatmap", async (req, reply) => {
    const { months } = req.query as Record<string, string>;
    try {
      return reply.send(getEmotionHeatmap(months ? Number(months) : undefined));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /analytics/trends — 核心情绪趋势线 ?top=6 */
  app.get("/analytics/trends", async (req, reply) => {
    const { top } = req.query as Record<string, string>;
    try {
      return reply.send(getEmotionTrends(top ? Number(top) : 6));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /analytics/phases — 生活阶段检测 */
  app.get("/analytics/phases", async (_req, reply) => {
    try {
      return reply.send(getLifePhases());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /analytics/compare — 多人情绪对比 */
  app.get("/analytics/compare", async (_req, reply) => {
    try {
      return reply.send(comparePersons());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /analytics/entity/:name — 实体时序演化 */
  app.get("/analytics/entity/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      return reply.send(getEntityTimeline(decodeURIComponent(name)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET /analytics/summary — 全局分析摘要 */
  app.get("/analytics/summary", async (_req, reply) => {
    try {
      return reply.send(getAnalyticsSummary());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** GET / — 默认进入 v3 对话闭环界面 */
  app.get("/", async (_req, reply) => {
    return reply.redirect("/app");
  });

  /** GET /app — 家庭记忆用户端（移动端优先；playground 保留为管理调试台）。 */
  app.get("/app", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(readWebAsset("app.html"));
  });

  /** GET /web/:file — 静态前端资源（auth.js / 公众号二维码等，公开可取，登录门本身要靠它） */
  app.get("/web/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    if (!/^[a-zA-Z0-9_.-]+\.(js|css|png)$/.test(file)) return reply.status(404).send({ error: "not found" });
    // 图片按二进制回，文本资源按 utf8 回
    if (file.endsWith(".png")) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(WEB_DIR, file));
      } catch {
        return reply.status(404).send({ error: "not found" });
      }
      return reply.type("image/png").send(bytes);
    }
    let body: string;
    try {
      body = readWebAsset(file);
    } catch {
      return reply.status(404).send({ error: "not found" });
    }
    const type = file.endsWith(".css") ? "text/css" : "application/javascript";
    return reply.type(`${type}; charset=utf-8`).send(body);
  });

  /** GET /dashboard — 实时图谱仪表盘 */
  app.get("/dashboard", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(readWebAsset("dashboard.html"));
  });

  /** GET /conversation/playground — 对话闭环测试界面 */
  app.get("/conversation/playground", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(buildConversationPlaygroundHtml());
  });

  /** GET /wechat — 原 xfeel 微信公众号 token 验证入口 */
  app.get("/wechat", async (req, reply) => {
    const { signature, timestamp, nonce, echostr } = req.query as Record<string, string>;
    if (!signature || !timestamp || !nonce || echostr === undefined) {
      return reply.status(400).type("text/plain; charset=utf-8").send("missing wechat verification params");
    }
    if (!isValidWechatSignature({ signature, timestamp, nonce })) {
      return reply.status(403).type("text/plain; charset=utf-8").send("invalid wechat signature");
    }
    return reply.type("text/plain; charset=utf-8").send(echostr);
  });

  /** POST /wechat — 原 xfeel 微信公众号 XML webhook；内部复用 v3 product loop */
  app.post("/wechat", async (req, reply) => {
    const startedAt = Date.now();
    const { signature, timestamp, nonce } = req.query as Record<string, string>;
    if (!signature || !timestamp || !nonce || !isValidWechatSignature({ signature, timestamp, nonce })) {
      req.log.warn({ event: "wechat_signature_rejected" }, "wechat_signature_rejected");
      return reply.status(403).type("text/plain; charset=utf-8").send("invalid wechat signature");
    }
    const payload = typeof req.body === "string" ? req.body : "";
    if (!payload.trim()) return reply.status(400).type("text/plain; charset=utf-8").send("empty wechat payload");

    try {
      const wxReq = parseWechatXml(payload);
      const retryStatus = getWechatRetryCacheStatus(wxReq);
      const inboundText = getWechatLogText(wxReq);
      req.log.info({
        event: "wechat_inbound",
        msg_type: wxReq.MsgType,
        msg_id: wxReq.MsgId,
        from_user_hash: hashId(wxReq.FromUserName),
        from_user_mask: maskId(wxReq.FromUserName),
        async_customer_service: hasWechatCustomerServiceCredentials(),
        retry_cache_hit: retryStatus.hit,
        retry_cache_attempts: retryStatus.attempts,
        retry_cache_has_result: retryStatus.hasResult,
        ...textLogFields("content", inboundText),
      }, "wechat_inbound");
      const xml = await getOrCreateWechatResponseXml(wxReq, async () => {
        const response = makeWechatTextResponse(wxReq, "消息我收到了");

        if (wxReq.MsgType === "text" && wxReq.Content?.trim()) {
          const account = handleAccountCommand({ platform: "weixin", external_user_id: wxReq.FromUserName, text: wxReq.Content });
          if (account.matched) {
            response.Content = account.reply;
            return renderWechatTextXml(response);
          }

          const identity = resolveMessageIdentity({
            owner_id: wxReq.FromUserName,
            user_id: wxReq.FromUserName,
            platform: "weixin",
          }, { autoProvision: true });
          if (!identity.bound) {
            response.Content = buildUnboundWeixinReply(wxReq.FromUserName);
            return renderWechatTextXml(response);
          }

          const onboardingHint = buildOnboardingHint(identity);
          if (hasWechatCustomerServiceCredentials()) {
            void sendWechatFinalReplyAfterProcessing(wxReq.FromUserName!, handleProductMessage({
              text: wxReq.Content,
              owner_id: identity.ownerId,
              user_id: identity.ownerId,
              scope_owner_ids: identity.scopeOwnerIds,
              speaker_id: identity.speakerId,
              speaker_label: identity.speakerLabel,
              aliasContext: identity.aliasContext,
            }).then(result => appendCareFollowUp(appendHint(result.reply || "消息我收到了", onboardingHint)!, identity.ownerId, result.intent)));
            response.Content = WECHAT_ASYNC_ACK_REPLY;
          } else {
            const result = await handleProductMessage({
              text: wxReq.Content,
              owner_id: identity.ownerId,
              user_id: identity.ownerId,
              scope_owner_ids: identity.scopeOwnerIds,
              speaker_id: identity.speakerId,
              speaker_label: identity.speakerLabel,
              aliasContext: identity.aliasContext,
            });
            response.Content = appendCareFollowUp(appendHint(result.reply || "消息我收到了", onboardingHint)!, identity.ownerId, result.intent);
          }
        } else if (wxReq.MsgType === "voice") {
          response.Content = wxReq.Recognition?.trim()
            ? (await handleWechatRecognizedVoice(wxReq)).reply
            : "✅ 已收到您的语音消息。";
        } else if (wxReq.MsgType === "image") {
          const identity = resolveMessageIdentity({
            owner_id: wxReq.FromUserName,
            user_id: wxReq.FromUserName,
            platform: "weixin",
          }, { autoProvision: true });
          if (!identity.bound) {
            response.Content = buildUnboundWeixinReply(wxReq.FromUserName);
          } else if (hasWechatCustomerServiceCredentials()) {
            // 下载+转写+抽取通常超过微信 5s 限制：有客服接口就先 ack，处理完异步推送。
            void sendWechatFinalReplyAfterProcessing(wxReq.FromUserName!, processWechatImageToReply(wxReq, identity));
            response.Content = WECHAT_ASYNC_ACK_REPLY;
          } else {
            response.Content = await processWechatImageToReply(wxReq, identity);
          }
        } else if (wxReq.MsgType === "event" && wxReq.Event === "subscribe") {
          response.Content = getWelcomeText();
        }

        return renderWechatTextXml(response);
      });

      const responseText = extractWechatResponseContent(xml);
      req.log.info({
        event: "wechat_response",
        msg_type: wxReq.MsgType,
        msg_id: wxReq.MsgId,
        from_user_hash: hashId(wxReq.FromUserName),
        async_ack: responseText === WECHAT_ASYNC_ACK_REPLY,
        empty_retry_hold: xml.length === 0,
        duration_ms: Date.now() - startedAt,
        ...textLogFieldsRedactingValues("reply", responseText, [wxReq.FromUserName]),
      }, "wechat_response");
      return reply.type("application/xml; charset=utf-8").send(xml);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      app.log.error({ event: "wechat_response", error: safeErrorMessage(e), duration_ms: Date.now() - startedAt }, "wechat_response_error");
      return reply.type("application/xml; charset=utf-8").send(renderWechatTextXml(makeWechatTextResponse(undefined, `处理消息时出错：${msg}`)));
    }
  });

  /** POST /web/login/start — 网页申请登录：生成暗号，由用户在公众号回复完成认领 */
  app.post("/web/login/start", async (req, reply) => {
    const ip = getClientIp(req);
    if (!checkRateLimit(loginStartRateLimit, ip, 10, 60_000)) {
      return reply.status(429).send({ error: "too_many_requests", retry_after_ms: 60_000 });
    }
    const { code, expiresAt } = createWebLoginCode();
    return reply.send({
      code,
      expires_at: expiresAt,
      hint: `在公众号回复「${code}」即可完成登录`,
    });
  });

  /** GET /web/login/status?code= — 网页轮询暗号状态（只读，不消费） */
  app.get("/web/login/status", async (req, reply) => {
    const { code } = req.query as Record<string, string>;
    if (!code?.trim()) return reply.status(400).send({ error: "code is required" });
    return reply.send({ status: getWebLoginStatus(code) });
  });

  /** POST /web/login/redeem — 暗号被认领后兑换 1 年 token */
  app.post("/web/login/redeem", async (req, reply) => {
    const { code } = req.body as { code?: string };
    if (!code?.trim()) return reply.status(400).send({ error: "code is required" });
    const ip = getClientIp(req);
    if (!checkRateLimit(loginRedeemRateLimit, ip, 30, 60_000)) {
      return reply.status(429).send({ error: "too_many_requests", retry_after_ms: 60_000 });
    }
    const result = redeemWebLoginCode(code);
    if (result.status === "locked") {
      return reply.status(429).send({ error: "locked", status: result.status, message: "暗号尝试次数过多，请重新获取" });
    }
    if (result.status !== "authorized") return reply.status(409).send({ status: result.status });
    return reply.send({
      status: result.status,
      token: result.token,
      expires_at: result.expiresAt,
      family_id: result.familyId,
      owner_id: result.ownerId,
      speaker_label: result.speakerLabel,
    });
  });

  /** GET /wechat/oauth/start — 公众号菜单入口：跳到微信网页授权，回调后自动登录 /app。 */
  app.get("/wechat/oauth/start", async (req, reply) => {
    const { next, invite } = req.query as { next?: string; invite?: string };
    const appId = getWechatAppId();
    if (!appId) return reply.status(500).type("text/plain; charset=utf-8").send("missing WECHAT_APP_ID");
    const webBase = getWebAppBaseUrl();
    const redirectUri = `${webBase}/wechat/oauth/callback`;
    const state = encodeWechatOAuthState({ next: sanitizeWechatOAuthNext(next), invite });
    const url = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
    url.searchParams.set("appid", appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "snsapi_base");
    url.searchParams.set("state", state);
    return reply.redirect(`${url.toString()}#wechat_redirect`);
  });

  /** GET /wechat/oauth/callback — 微信网页授权回调：code -> openid -> xfeel Web JWT。 */
  app.get("/wechat/oauth/callback", async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const appId = getWechatAppId();
    const secret = getWechatAppSecret();
    if (!appId || !secret) return reply.status(500).type("text/plain; charset=utf-8").send("missing WECHAT_APP_ID/WECHAT_APP_SECRET");
    if (!code?.trim()) return reply.status(400).type("text/plain; charset=utf-8").send("missing oauth code");

    const parsedState = decodeWechatOAuthState(state);
    const tokenUrl = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
    tokenUrl.searchParams.set("appid", appId);
    tokenUrl.searchParams.set("secret", secret);
    tokenUrl.searchParams.set("code", code.trim());
    tokenUrl.searchParams.set("grant_type", "authorization_code");

    try {
      const tokenRes = await fetch(tokenUrl);
      const tokenBody = await tokenRes.json().catch(() => ({})) as { openid?: string; errcode?: number; errmsg?: string };
      if (!tokenRes.ok || !tokenBody.openid) {
        throw new Error(`wechat oauth failed: ${tokenBody.errmsg || tokenBody.errcode || tokenRes.status}`);
      }
      const result = authorizeWebSessionForWechat({
        platform: "weixin",
        external_user_id: tokenBody.openid,
        invite_code: parsedState.invite,
      });
      if (result.status !== "authorized" || !result.token) throw new Error(`web session authorize failed: ${result.status}`);
      const nextPath = sanitizeWechatOAuthNext(parsedState.next) || "/app";
      const redirect = new URL(nextPath, getWebAppBaseUrl());
      redirect.searchParams.set("token", result.token);
      return reply.redirect(redirect.toString());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      req.log.error({ error: msg }, "wechat oauth callback failed");
      return reply.status(500).type("text/plain; charset=utf-8").send(`微信网页登录失败：${msg}`);
    }
  });

  /** GET /web/me — 登录者身份 + 本家庭可选 owner（前端据此填充选择器，只显示自己家人）。 */
  app.get("/web/me", async (req, reply) => {
    const auth = (req as AuthedRequest).auth;
    if (!auth) {
      // XFEEL_AUTH_DISABLED 本地旁路：按 admin 身份返回默认 owner，让 /app、playground 可直接调试。
      if (authDisabled()) {
        const groups = collectAllOwnerGroups();
        return reply.send({
          admin: true, owners: flattenOwnerGroups(groups), owner_groups: groups,
          owner_labels: collectOwnerLabels(), today: normalizeLocalDate(),
        });
      }
      return reply.status(401).send({ error: "unauthorized" });
    }
    if (auth.admin) {
      // admin 看全库：owners 按家庭分组返回，playground/dashboard 据此渲染「切换用户」选择器
      // （之前硬编码只有爸爸/妈妈两个演示 owner，孩子成员和其它家庭都选不到）
      const groups = collectAllOwnerGroups();
      return reply.send({
        admin: true, owners: flattenOwnerGroups(groups), owner_groups: groups,
        owner_labels: collectOwnerLabels(), today: normalizeLocalDate(),
      });
    }
    const familyId = auth.claims?.fam;
    const family = familyId ? getFamilySummary({ family_id: familyId }) : null;
    const owners: Array<{ id: string; label: string }> = [];
    const seen = new Set<string>();
    if (family) {
      // 优先按「有账号的说话人」列出（爸爸/妈妈…），排除不发言的孩子成员
      for (const sp of family.speakers) {
        if (sp.self_member_id && sp.self_label && !seen.has(sp.self_member_id)) {
          seen.add(sp.self_member_id);
          owners.push({ id: sp.self_member_id, label: sp.self_label });
        }
      }
      const def = family.settings.default_owner_id;
      if (def && !seen.has(def)) {
        seen.add(def);
        owners.push({ id: def, label: family.members.find(m => m.id === def)?.label || auth.claims?.label || "本人" });
      }
      if (!owners.length) {
        for (const m of family.members) if (!seen.has(m.id)) { seen.add(m.id); owners.push({ id: m.id, label: m.label }); }
      }
    }
    // 称呼与 onboarding 阶段读当前 DB 而非 JWT claims：设置称呼后无需重新登录就能生效
    const uid = auth.claims?.uid;
    const plat = auth.claims?.plat || "weixin";
    const onboarding = uid ? getSpeakerOnboardingState({ platform: plat, external_user_id: uid }) : null;
    const selfSpeaker = uid ? family?.speakers.find(s => s.platform === plat && s.external_user_id === uid) : undefined;
    return reply.send({
      admin: false, family_id: familyId,
      family_name: family?.family.name,
      speaker_label: selfSpeaker?.self_label || auth.claims?.label,
      onboarding_stage: onboarding?.stage,
      // 记录归属说话人本人（按人分池）：前端据此在浏览别人视角时把输入区设为只读
      self_owner_id: selfSpeaker?.self_member_id,
      owners,
      owner_labels: collectOwnerLabels(familyId), today: normalizeLocalDate(),
    });
  });

  /**
   * POST /web/profile/self — 网页端设置「我的称呼」（等价微信里的「我是爸爸」）。
   * 身份取自登录态 claims（openid），不信任 body；占位「本人」会被原地改名，owner 池连续不换池。
   */
  app.post("/web/profile/self", async (req, reply) => {
    const auth = (req as AuthedRequest).auth;
    if (!auth) return reply.status(401).send({ error: "unauthorized" });
    const uid = auth.claims?.uid;
    if (auth.admin || !uid) return reply.status(400).send({ error: "需要以家庭成员身份登录" });
    const { label } = req.body as { label?: string };
    const name = label?.trim() || "";
    if (!/^[一-龥A-Za-z·]{1,8}$/.test(name)) {
      return reply.status(400).send({ error: "称呼需为 1-8 个汉字或字母" });
    }
    try {
      const summary = setSpeakerSelf({
        platform: auth.claims?.plat || "weixin",
        external_user_id: uid,
        label: name,
        role: SELF_ROLE_WORDS[name] ?? "member",
      });
      req.log.info({ family: summary.family.id, label: name }, "web self label set");
      return reply.send({ ok: true, label: name });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /** POST /web/profile/family — 登录家庭成员修改本家庭展示名称。 */
  app.post("/web/profile/family", async (req, reply) => {
    const auth = (req as AuthedRequest).auth;
    if (!auth) return reply.status(401).send({ error: "unauthorized" });
    const { name, family_id } = req.body as { name?: string; family_id?: string };
    const familyId = auth.admin ? family_id?.trim() : auth.claims?.fam;
    if (!familyId) return reply.status(400).send({ error: auth.admin ? "family_id is required" : "需要以家庭成员身份登录" });
    const familyName = name?.trim().replace(/\s+/g, " ") || "";
    if (!/^[一-龥A-Za-z0-9· _-]{1,20}$/.test(familyName)) {
      return reply.status(400).send({ error: "家庭名称需为 1-20 个汉字、字母或数字" });
    }
    try {
      const summary = updateFamilyName({ family_id: familyId, name: familyName });
      req.log.info({ family: summary.family.id }, "web family name set");
      return reply.send({ ok: true, name: summary.family.name });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: msg });
    }
  });

  /**
   * GET /web/media-token — 签发短期只读媒体 token（scope=media），专供 <img src="/media/:id?token=…">。
   * 长期会话 JWT 从此不进 URL：查询参数里即使泄露，也只能读本家庭图片、且很快过期。
   */
  app.get("/web/media-token", async (req, reply) => {
    const auth = (req as AuthedRequest).auth;
    if (!auth) {
      if (authDisabled()) return reply.send({ token: null, admin: true }); // 本地旁路：不需要媒体 token
      return reply.status(401).send({ error: "unauthorized" });
    }
    if (auth.admin) return reply.send({ token: null, admin: true }); // admin 继续用自己的 token 取媒体
    const ttlMs = 24 * 60 * 60 * 1000;
    const { token, expiresAt } = signWebToken({
      fam: auth.claims?.fam,
      uid: auth.claims?.uid,
      plat: auth.claims?.plat,
      scope: "media",
    }, ttlMs);
    return reply.send({ token, expires_at: expiresAt });
  });

  /** GET /understanding — 用户可查看、审计并纠正系统当前对自己的长期理解。 */
  app.get("/understanding", async (req, reply) => {
    const { owner_id } = req.query as { owner_id?: string };
    const ownerId = owner_id?.trim() || "";
    if (!ownerId) return reply.status(400).send({ error: "owner_id is required" });
    if (!canManageOwnUnderstanding(req, ownerId)) return reply.status(403).send({ error: "forbidden", reason: "self_only" });
    const longTerm = getLongTermProfile(ownerId);
    const recent = getRecentProfile(ownerId);
    const feedback = listUnderstandingFeedback(ownerId);
    const feedbackByKey = new Map(feedback.map(item => [item.understandingKey, item]));
    const raw = (longTerm?.content.understandings || []).filter(item => item.status === "active");
    return reply.send({
      owner_id: ownerId,
      profile_version: longTerm?.version || 0,
      generated_at: longTerm?.generatedAt || null,
      recent: recent?.content || null,
      understandings: raw.map(item => {
        const key = understandingKey(item);
        const saved = feedbackByKey.get(key);
        const applied = applyUnderstandingFeedback(ownerId, [item])[0];
        return { key, ...item, statement: applied?.statement || item.statement,
          effective: Boolean(applied), feedback: saved ? { action: saved.action, replacement_statement: saved.replacementStatement,
            visibility: saved.visibility, updated_at: saved.updatedAt } : null };
      }),
    });
  });

  /** POST /understanding/feedback — 确认、否认、撤回或改写一条理解；立即影响后续回复。 */
  app.post("/understanding/feedback", async (req, reply) => {
    const body = req.body as { owner_id?: string; key?: string; action?: "confirm" | "reject" | "retract" | "correct";
      replacement_statement?: string; visibility?: "private" | "family" };
    const ownerId = body.owner_id?.trim() || "";
    if (!ownerId || !body.key || !body.action) return reply.status(400).send({ error: "owner_id, key and action are required" });
    if (!canManageOwnUnderstanding(req, ownerId)) return reply.status(403).send({ error: "forbidden", reason: "self_only" });
    const item = (getLongTermProfile(ownerId)?.content.understandings || []).find(candidate => understandingKey(candidate) === body.key);
    if (!item) return reply.status(404).send({ error: "understanding not found" });
    try {
      const feedback = saveUnderstandingFeedback({ ownerId, item, action: body.action,
        replacementStatement: body.replacement_statement, visibility: body.visibility });
      return reply.send({ ok: true, feedback });
    } catch (error) {
      return reply.status(400).send({ error: safeErrorMessage(error) });
    }
  });

  /**
   * GET /memories/day — 某 owner 某天的长期记忆事件。
   * 历史回放兜底：conversation_turns 只从近期开始有数据，更早的日子靠 memory_events.event_date 渲染。
   */
  app.get("/memories/day", async (req, reply) => {
    const { owner_id, user_id, date } = req.query as Record<string, string>;
    const ownerId = (owner_id || user_id || "").trim();
    if (!ownerId) return reply.status(400).send({ error: "owner_id is required" });
    const day = normalizeLocalDate(date);
    const rows = getDB().prepare(`
      SELECT id, summary, original_text, event_type, entities, emotion, tags, event_date, event_time, created_at
      FROM memory_events
      WHERE user_id = ?
        AND COALESCE(NULLIF(event_date, ''), substr(created_at, 1, 10)) = ?
        -- parse:Feeling / parse:Activity 等是供分析使用的派生事件，不是用户记录。
        AND source_layer != 'structured'
      ORDER BY COALESCE(event_time, created_at) ASC
    `).all(ownerId, day);
    return reply.send({ owner_id: ownerId, date: day, events: rows, total: rows.length });
  });

  /** GET /memories/calendar?owner_id&month=YYYY-MM — 该月每天的记录量（对话 + 记忆事件），供日历亮点。 */
  app.get("/memories/calendar", async (req, reply) => {
    const { owner_id, user_id, month } = req.query as Record<string, string>;
    const ownerId = (owner_id || user_id || "").trim();
    if (!ownerId) return reply.status(400).send({ error: "owner_id is required" });
    const m = /^\d{4}-\d{2}$/.test(month || "") ? month : normalizeLocalDate().slice(0, 7);
    const like = `${m}-%`;
    const days: Record<string, number> = {};
    const eventRows = getDB().prepare(`
      SELECT COALESCE(NULLIF(event_date, ''), substr(created_at, 1, 10)) AS d,
             COUNT(DISTINCT COALESCE(NULLIF(raw_message_id, ''), id)) AS c
      FROM memory_events
      WHERE user_id = ?
        AND source_layer != 'structured'
        AND COALESCE(NULLIF(event_date, ''), substr(created_at, 1, 10)) LIKE ?
      GROUP BY d
    `).all(ownerId, like) as Array<{ d: string; c: number }>;
    for (const row of eventRows) days[row.d] = (days[row.d] || 0) + row.c;
    const turnRows = getDB().prepare(`
      SELECT turn_date AS d, COUNT(*) AS c FROM conversation_turns
      WHERE owner_id = ? AND role = 'user' AND turn_date LIKE ? GROUP BY d
    `).all(ownerId, like) as Array<{ d: string; c: number }>;
    for (const row of turnRows) days[row.d] = (days[row.d] || 0) + row.c;
    // 情绪日历：每天主导情绪及其正负性，前端据此给亮点上色（数量点不携带情绪信息）
    const moods = getOwnerDailyMoods(ownerId, m);
    return reply.send({ owner_id: ownerId, month: m, days, moods });
  });

  /**
   * GET /emotions/review?owner_id&days=30 — owner 级情绪回顾（/app「情绪回顾」面板）。
   * 聚合是纯 SQL；解读文案用 reply LLM 生成（确定性兜底），按 owner+当天缓存避免重复调用。
   */
  app.get("/emotions/review", async (req, reply) => {
    const { owner_id, user_id, days } = req.query as Record<string, string>;
    const ownerId = (owner_id || user_id || "").trim();
    if (!ownerId) return reply.status(400).send({ error: "owner_id is required" });
    const review = getOwnerEmotionReview(ownerId, Number(days) || 30);
    const narrative = await buildEmotionNarrative(review);
    return reply.send({ ...review, narrative });
  });

  /**
   * GET /care/pending — 该 owner 当前可投递的跟进关怀（回声/担忧回访/安排跟进）。
   * /app 顶部跟进卡片的数据源；owner 归属由全局 preHandler 校验（须属于登录家庭）。
   */
  app.get("/care/pending", async (req, reply) => {
    const { owner_id, user_id } = req.query as Record<string, string>;
    const ownerId = (owner_id || user_id || "").trim();
    if (!ownerId) return reply.status(400).send({ error: "owner_id is required" });
    const items = listDeliverableCare({ owner_id: ownerId, limit: 5 });
    return reply.send({
      owner_id: ownerId,
      items: items.map(item => ({
        id: item.id,
        kind: item.kind,
        topic: item.topic,
        content: item.content,
        related_event_ids: item.related_event_ids,
        created_at: item.created_at,
      })),
    });
  });

  /** POST /care/dismiss — 关闭一条跟进卡片（用户点 ✕），微信侧也不会再问。 */
  app.post("/care/dismiss", async (req, reply) => {
    const { id, owner_id, user_id } = req.body as { id?: string; owner_id?: string; user_id?: string };
    const ownerId = (owner_id || user_id || "").trim();
    if (!id?.trim() || !ownerId) return reply.status(400).send({ error: "id and owner_id are required" });
    const item = getCareItem(id.trim());
    if (!item || item.owner_id !== ownerId) return reply.status(404).send({ error: "care item not found" });
    const dismissed = dismissCare({ id: id.trim(), owner_id: ownerId });
    return reply.send({ ok: dismissed });
  });

  /**
   * GET /milestones — 成长里程碑时间线（/app 里程碑视图数据源）。
   * 候选是确定性 SQL（legacy 只认"第一次/首次/学会"字样——旧规则误标教训），
   * 之上由 LLM 策展解决规则做不到的语义问题：负向过滤（"尚未成功"不是里程碑）、
   * 同能力去重（如厕训练 8 条只留最早达成那次）、长日记提炼短标题。
   * 结果存 milestone_snapshots，候选集指纹变了才重建；LLM 失败回退确定性列表。?rebuild=1 强制重建。
   */
  app.get("/milestones", async (req, reply) => {
    const { owner_id, user_id, rebuild } = req.query as Record<string, string>;
    const ownerId = (owner_id || user_id || "").trim();
    if (!ownerId) return reply.status(400).send({ error: "owner_id is required" });

    // stale-while-revalidate：请求路径绝不等 LLM。有快照就立刻回（旧的也先用），
    // 不新鲜时后台重建，前端看到 stale:true 会稍后自拉一次。?rebuild=1 才同步等策展。
    let snapshot: { items: Array<{ id: string; date: string; title: string; person?: string; event_type?: string }>; curated: boolean; generated_at: string };
    let stale = false;
    if (rebuild === "1") {
      snapshot = await getMilestones(ownerId, { rebuild: true });
    } else {
      const peek = peekMilestones(ownerId);
      if (peek?.fresh) {
        snapshot = peek;
      } else if (peek) {
        scheduleMilestoneRebuild(ownerId);
        snapshot = peek;
        stale = true;
      } else {
        // 首次访问：先给确定性列表（毫秒级），策展后台补
        snapshot = await getMilestones(ownerId, { curate: false });
        scheduleMilestoneRebuild(ownerId);
        stale = true;
      }
    }
    return reply.send({
      owner_id: ownerId,
      curated: snapshot.curated,
      stale,
      generated_at: snapshot.generated_at,
      milestones: snapshot.items.map(item => ({
        id: item.id,
        date: item.date,
        summary: item.title,
        person: item.person,
        event_type: item.event_type,
      })),
      total: snapshot.items.length,
    });
  });

  /**
   * POST /web/upload/image — 网页拍照/相册上传，与微信图片同一条链路：
   * 落地 media_assets → vision 转写成日记描述 → 走 product loop（分类/抽取/共情回复）。
   * body: { image_base64, mime?, owner_id, date? }。前端先压到长边 ~1600px 再传。
   */
  app.post("/web/upload/image", { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    const { image_base64, mime, owner_id, user_id, date, note } = req.body as {
      image_base64?: string; mime?: string; owner_id?: string; user_id?: string; date?: string; note?: string;
    };
    if (!image_base64?.trim()) return reply.status(400).send({ error: "image_base64 is required" });
    let buffer: Buffer;
    try {
      buffer = Buffer.from(image_base64.replace(/^data:[^;]*;base64,/, ""), "base64");
    } catch {
      return reply.status(400).send({ error: "invalid base64 image" });
    }
    if (!buffer.length) return reply.status(400).send({ error: "empty image" });
    if (buffer.length > 10 * 1024 * 1024) return reply.status(400).send({ error: "image too large (max 10MB)" });

    try {
      const identity = resolveRequestIdentity(req, { owner_id, user_id, platform: "weixin" });
      const imageMime = mime?.trim() || "image/jpeg";
      const asset = saveMediaBuffer({
        buffer,
        mime: imageMime,
        ownerId: identity.ownerId,
        kind: "image",
        sourcePlatform: "web",
      });
      const dataUrl = `data:${imageMime};base64,${buffer.toString("base64")}`;
      const { caption, degraded } = await captionImageToDiary({
        images: [{ url: dataUrl }],
        speakerLabel: identity.speakerLabel,
        note: note?.trim() || undefined,
        recentText: recentUserTextForImage(identity.ownerId),
      });
      if (degraded && !note?.trim()) {
        recordMediaCaption(asset.id, caption);
        return reply.send({
          ok: true, degraded: true, asset_id: asset.id,
          reply: "📷 图片收到啦，不过我这会儿没太看清内容，你想配一句话讲讲嘛？",
        });
      }
      const result = await handleProductMessage({
        text: caption,
        owner_id: identity.ownerId,
        user_id: identity.ownerId,
        scope_owner_ids: identity.scopeOwnerIds,
        date,
        speaker_id: identity.speakerId,
        speaker_label: identity.speakerLabel,
        aliasContext: identity.aliasContext,
        image_transcript: true,
      });
      const turnId = (result as { result?: { user_turn?: { id?: string } } }).result?.user_turn?.id;
      recordMediaCaption(asset.id, caption, turnId);
      return reply.send({ ok: true, degraded: false, asset_id: asset.id, caption, intent: result.intent, reply: result.reply, result });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      req.log.error({ err, owner: owner_id ?? user_id, bytes: buffer.length }, "web image upload failed");
      return reply.status(500).send({ error: err.message });
    }
  });

  /** GET /health — 健康检查 */
  app.get("/health", async () => {
    const db = getDB();
    const count = (db.prepare("SELECT COUNT(*) as c FROM memory_events").get() as { c: number }).c;
    return { status: "ok", events: count, embedding: embeddingStartupStatus };
  });

  return app;
}

interface MessageIdentityInput {
  owner_id?: string;
  user_id?: string;
  family_id?: string;
  speaker_profile_id?: string;
  platform?: string;
}

function resolveMessageIdentity(input: MessageIdentityInput, opts: { autoProvision?: boolean } = {}) {
  const platform = input.platform?.trim() || "weixin";
  const externalUserId = input.user_id?.trim() || input.owner_id?.trim();
  let family = getFamilySummary({
    family_id: input.family_id,
    speaker_profile_id: input.speaker_profile_id,
    platform,
    external_user_id: externalUserId,
  });
  // admin/网页调试台直接传成员 id 当 owner_id（不是 openid，查不到 speaker）：
  // 按 family_members 反查家庭，别丢家庭扇出（scope_owner_ids）和别名归一（aliasContext）。
  // 此时 owner 就是这个成员本身，不能再落回 default_owner_id（否则以妈妈视角发的消息会记进爸爸的池）。
  let memberOwnerId: string | undefined;
  if (!family && externalUserId) {
    const memberRow = getDB().prepare("SELECT id, family_id, label FROM family_members WHERE id = ?")
      .get(externalUserId) as { id: string; family_id: string; label: string } | undefined;
    if (memberRow) {
      family = getFamilySummary({ family_id: memberRow.family_id });
      memberOwnerId = memberRow.id;
    }
  }
  // 新用户（openid 没有 speaker_profile）：自动建单家庭并绑为占位 self，先让消息有归属再温和提醒。
  let provisioned = false;
  if (!family && opts.autoProvision && externalUserId) {
    autoProvisionFamilyForSpeaker({ platform, external_user_id: externalUserId });
    family = getFamilySummary({ platform, external_user_id: externalUserId });
    provisioned = Boolean(family);
  }
  const aliasContext = family?.aliasContext;
  // 按人分池：优先用该 speaker 自己的 self 成员当 owner，让每个家人各自一个记忆池；
  // self 缺失时回退到家庭默认 owner，再到显式传入的 owner_id / openid（与旧行为一致）。
  const ownerId = memberOwnerId || aliasContext?.selfMemberId || family?.settings.default_owner_id || input.owner_id?.trim() || externalUserId || aliasContext?.speakerProfileId;
  if (!ownerId) throw new Error("owner_id or user_id is required");
  // 家庭共享记忆：召回扇出域 = 全家会记录的成员（speaker）的 owner 池集合，含说话人自己。
  // 单成员家庭时退化为 [ownerId]，召回层会自动收敛回单 owner（无扇出）。
  const scopeOwnerIds = [...new Set([
    ownerId,
    ...((family?.speakers ?? []).map(s => s.self_member_id).filter((id): id is string => Boolean(id))),
  ])];
  return {
    ownerId,
    scopeOwnerIds,
    speakerId: input.speaker_profile_id?.trim() || aliasContext?.speakerProfileId || externalUserId || ownerId,
    // 成员 id 直连路径没有 speaker 绑定：说话人称呼取该成员自己的 label（抽取归因"我"要用）。
    speakerLabel: aliasContext?.selfLabel
      || (memberOwnerId ? family?.members.find(m => m.id === memberOwnerId)?.label : undefined),
    aliasContext,
    bound: Boolean(family && aliasContext),
    provisioned,
    externalUserId,
    platform,
  };
}

interface PlaygroundPipelineDiagnostic {
  message_id: string;
  stage: string;
  status: string;
  error?: string;
  result: unknown;
  created_at?: string;
  updated_at?: string;
}

interface PlaygroundMemoryEventDiagnostic {
  id: string;
  raw_message_id?: string;
  event_index?: number;
  original_span?: string;
  event_date?: string;
  summary?: string;
  original_text?: string;
  event_type?: string;
  entities: unknown;
  emotion: unknown;
  tags: unknown;
  open_facts: unknown;
  event_time?: string;
  confidence?: number;
  source?: string;
  source_layer?: string;
  source_archive_id?: string;
  user_id?: string;
  created_at?: string;
  updated_at?: string;
}

function buildPlaygroundDiagnostics(ownerId: string, turns: ConversationTurn[]) {
  const messageIds = new Set<string>();
  const eventIds = new Set<string>();

  for (const turn of turns) {
    const metadata = turn.metadata || {};
    const pipelineMessageId = stringValue(metadata.pipeline_message_id);
    if (pipelineMessageId) messageIds.add(pipelineMessageId);
    for (const id of stringArray(metadata.current_event_ids)) eventIds.add(id);
    for (const id of stringArray(metadata.recalled_event_ids)) eventIds.add(id);
  }

  const pipelineByMessageId = loadPlaygroundPipelineStatuses([...messageIds]);
  const mediaByTurnId = loadPlaygroundMedia(ownerId, turns.map(turn => turn.id));
  const events = loadPlaygroundMemoryEvents(ownerId, [...messageIds], [...eventIds]);
  const eventById = new Map(events.map(event => [event.id, event]));
  const eventsByMessageId = new Map<string, PlaygroundMemoryEventDiagnostic[]>();
  for (const event of events) {
    if (!event.raw_message_id) continue;
    const group = eventsByMessageId.get(event.raw_message_id) || [];
    group.push(event);
    eventsByMessageId.set(event.raw_message_id, group);
  }

  return turns.map(turn => {
    const metadata = turn.metadata || {};
    const pipelineMessageId = stringValue(metadata.pipeline_message_id);
    const currentEventIds = stringArray(metadata.current_event_ids);
    const recalledEventIds = stringArray(metadata.recalled_event_ids);
    const currentEvents = uniquePlaygroundEvents([
      ...(pipelineMessageId ? eventsByMessageId.get(pipelineMessageId) || [] : []),
      ...currentEventIds.map(id => eventById.get(id)),
    ]);
    const recalledEvents = uniquePlaygroundEvents(recalledEventIds.map(id => eventById.get(id)));

    return {
      turn_id: turn.id,
      role: turn.role,
      source: turn.source,
      intent: inferPlaygroundIntent(turn),
      content: turn.content,
      turn_date: turn.turn_date,
      created_at: turn.created_at,
      archive_id: turn.archive_id,
      metadata,
      pipeline_message_id: pipelineMessageId,
      pipeline: pipelineMessageId ? pipelineByMessageId.get(pipelineMessageId) || null : null,
      current_event_ids: currentEventIds,
      current_events: currentEvents,
      recalled_event_ids: recalledEventIds,
      recalled_events: recalledEvents,
      media: mediaByTurnId.get(turn.id) || [],
    };
  });
}

/** 加载与这些 turn 关联的媒体资产（media_assets.message_id = turn.id），按 turn 分组，供 playground 显示原图。 */
function loadPlaygroundMedia(ownerId: string, turnIds: string[]): Map<string, Array<{ id: string; caption?: string; mime?: string; kind?: string }>> {
  const map = new Map<string, Array<{ id: string; caption?: string; mime?: string; kind?: string }>>();
  const ids = turnIds.filter(Boolean);
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDB().prepare(`
    SELECT id, message_id, caption, mime, kind FROM media_assets
    WHERE owner_id = ? AND message_id IN (${placeholders})
    ORDER BY created_at ASC
  `).all(ownerId, ...ids) as Array<{ id: string; message_id: string; caption?: string; mime?: string; kind?: string }>;
  for (const row of rows) {
    const group = map.get(row.message_id) || [];
    group.push({ id: row.id, caption: row.caption, mime: row.mime, kind: row.kind });
    map.set(row.message_id, group);
  }
  return map;
}

function inferPlaygroundIntent(turn: ConversationTurn) {
  const mode = stringValue(turn.metadata?.mode);
  if (mode) return mode;
  if (turn.source === "log") return "log";
  if (turn.source === "contextual_log_reply") return "log_reply";
  return turn.source || turn.role;
}

function loadPlaygroundPipelineStatuses(messageIds: string[]) {
  const result = new Map<string, PlaygroundPipelineDiagnostic>();
  if (!messageIds.length) return result;

  const rows = getDB().prepare(`
    SELECT message_id, stage, status, error, result, created_at, updated_at
    FROM pipeline_status
    WHERE message_id IN (${sqlPlaceholders(messageIds)})
  `).all(...messageIds) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const messageId = String(row.message_id || "");
    if (!messageId) continue;
    result.set(messageId, {
      message_id: messageId,
      stage: String(row.stage || ""),
      status: String(row.status || ""),
      error: stringValue(row.error),
      result: parseJsonField(row.result, null),
      created_at: stringValue(row.created_at),
      updated_at: stringValue(row.updated_at),
    });
  }
  return result;
}

function loadPlaygroundMemoryEvents(ownerId: string, messageIds: string[], eventIds: string[]) {
  const eventById = new Map<string, PlaygroundMemoryEventDiagnostic>();
  const db = getDB();

  if (messageIds.length) {
    const rows = db.prepare(`
      SELECT ${PLAYGROUND_EVENT_COLUMNS}
      FROM memory_events
      WHERE raw_message_id IN (${sqlPlaceholders(messageIds)})
        AND (user_id = ? OR user_id IS NULL)
      ORDER BY COALESCE(event_time, event_date, created_at) ASC, COALESCE(event_index, 0) ASC
    `).all(...messageIds, ownerId) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const event = normalizePlaygroundMemoryEvent(row);
      eventById.set(event.id, event);
    }
  }

  if (eventIds.length) {
    const rows = db.prepare(`
      SELECT ${PLAYGROUND_EVENT_COLUMNS}
      FROM memory_events
      WHERE id IN (${sqlPlaceholders(eventIds)})
      ORDER BY COALESCE(event_time, event_date, created_at) ASC, COALESCE(event_index, 0) ASC
    `).all(...eventIds) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const event = normalizePlaygroundMemoryEvent(row);
      eventById.set(event.id, event);
    }
  }

  return [...eventById.values()];
}

const PLAYGROUND_EVENT_COLUMNS = [
  "id",
  "raw_message_id",
  "event_index",
  "original_span",
  "event_date",
  "summary",
  "original_text",
  "event_type",
  "entities",
  "emotion",
  "tags",
  "open_facts",
  "event_time",
  "confidence",
  "source",
  "source_layer",
  "source_archive_id",
  "user_id",
  "created_at",
  "updated_at",
].join(", ");

function normalizePlaygroundMemoryEvent(row: Record<string, unknown>): PlaygroundMemoryEventDiagnostic {
  return {
    id: String(row.id || ""),
    raw_message_id: stringValue(row.raw_message_id),
    event_index: numberValue(row.event_index),
    original_span: stringValue(row.original_span),
    event_date: stringValue(row.event_date),
    summary: stringValue(row.summary),
    original_text: stringValue(row.original_text),
    event_type: stringValue(row.event_type),
    entities: parseJsonField(row.entities, []),
    emotion: parseJsonField(row.emotion, {}),
    tags: parseJsonField(row.tags, []),
    open_facts: parseJsonField(row.open_facts, []),
    event_time: stringValue(row.event_time),
    confidence: numberValue(row.confidence),
    source: stringValue(row.source),
    source_layer: stringValue(row.source_layer),
    source_archive_id: stringValue(row.source_archive_id),
    user_id: stringValue(row.user_id),
    created_at: stringValue(row.created_at),
    updated_at: stringValue(row.updated_at),
  };
}

function uniquePlaygroundEvents(events: Array<PlaygroundMemoryEventDiagnostic | undefined>) {
  const seen = new Set<string>();
  const result: PlaygroundMemoryEventDiagnostic[] = [];
  for (const event of events) {
    if (!event?.id || seen.has(event.id)) continue;
    seen.add(event.id);
    result.push(event);
  }
  return result;
}

function sqlPlaceholders(values: string[]) {
  return values.map(() => "?").join(", ");
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim()))];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJsonField(value: unknown, fallback: unknown) {
  if (typeof value !== "string") return value ?? fallback;
  if (!value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function resolvePlaygroundOwnerDefaults() {
  const envDadOwnerId = process.env.XFEEL_DAD_OWNER_ID?.trim();
  const envMomOwnerId = process.env.XFEEL_MOM_OWNER_ID?.trim();
  let dadOwnerId = envDadOwnerId || PLAYGROUND_DAD_OWNER_ID;
  let momOwnerId = envMomOwnerId || PLAYGROUND_MOM_OWNER_ID;

  try {
    const familyId = process.env.XFEEL_FAMILY_ID?.trim();
    const family = (familyId ? getFamilySummary({ family_id: familyId }) : null) || getFamilySummary({});
    if (family) {
      const dadMemberId = findPlaygroundMemberId(family, "爸爸");
      const momMemberId = findPlaygroundMemberId(family, "妈妈");
      if (!envDadOwnerId) dadOwnerId = dadMemberId || family.settings.default_owner_id || dadOwnerId;
      if (!envMomOwnerId) momOwnerId = momMemberId || momOwnerId;
    }
  } catch {
    // Playground should still render even if family settings are not initialized yet.
  }

  return { dadOwnerId, momOwnerId };
}

function findPlaygroundMemberId(family: NonNullable<ReturnType<typeof getFamilySummary>>, label: string) {
  return family.members.find(member => member.label === label)?.id
    || family.speakers.find(speaker => speaker.self_label === label)?.self_member_id;
}

function escapeHtmlAttribute(value: string) {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]!));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function textLogFieldsRedactingValues(name: string, value: unknown, values: Array<unknown>): Record<string, unknown> {
  const text = String(value ?? "");
  const previewSource = redactKnownValues(text, values);
  return {
    [`${name}_len`]: text.length,
    [`${name}_hash`]: hashId(text),
    [`${name}_preview`]: previewText(previewSource),
  };
}

function redactKnownValues(text: string, values: Array<unknown>) {
  let redacted = text;
  for (const value of values) {
    const raw = String(value ?? "").trim();
    if (raw.length < 3) continue;
    redacted = redacted.split(raw).join(maskId(raw) || "[masked_id]");
  }
  return redacted;
}

/** 自动开户后仍未确认身份时附带的轻提醒，每 24h 最多一次（首条必发） */
const ONBOARDING_HINT_TEXT =
  "（悄悄说：回复「我是爸爸」或「我是妈妈」就能告诉我你是谁，我会把你说的“我”对应好；家人之后也能一起共享这份家庭记忆。）";

function buildUnboundWeixinReply(_externalUserId?: string) {
  return [
    "我这边没认出你的账号，暂时没法把这条记到你的家庭记忆里。",
    "请稍后再试，或回复「我是爸爸」「我是妈妈」让我先认识你。",
  ].join("\n");
}

const SELF_ROLE_WORDS: Record<string, string> = {
  "爸爸": "parent", "爸": "parent", "父亲": "parent", "老爸": "parent",
  "妈妈": "parent", "妈": "parent", "母亲": "parent", "老妈": "parent",
  "爷爷": "elder", "奶奶": "elder", "外公": "elder", "外婆": "elder", "姥姥": "elder", "姥爷": "elder",
};

/**
 * 解析自报身份命令。
 * - 「我是X / 叫我X」只在 X 是已知称谓时触发，避免「我是认真的」这类正常句子误判。
 * - 「绑定X」是显式命令，允许任意短名。
 */
function parseSelfDeclaration(text: string): { label: string; role: string } | null {
  const trimmed = text.trim();
  const soft = trimmed.match(/^(?:我是|叫我)\s*([一-龥A-Za-z·]{1,8})$/);
  if (soft) {
    const name = soft[1]!.trim();
    return name in SELF_ROLE_WORDS ? { label: name, role: SELF_ROLE_WORDS[name]! } : null;
  }
  const explicit = trimmed.match(/^绑定\s*([一-龥A-Za-z·]{1,8})$/);
  if (explicit) {
    const name = explicit[1]!.trim();
    return { label: name, role: SELF_ROLE_WORDS[name] ?? "member" };
  }
  return null;
}

/** 网页版入口（OAuth 回跳与帮助文案用），生产环境必须设置 XFEEL_WEB_URL */
function getWebAppBaseUrl(): string {
  return (process.env.XFEEL_WEB_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
}

interface WechatOAuthState {
  next?: string;
  invite?: string;
}

function encodeWechatOAuthState(state: WechatOAuthState): string {
  const compact: WechatOAuthState = {};
  const next = sanitizeWechatOAuthNext(state.next);
  if (next) compact.next = next;
  const invite = state.invite?.trim().toUpperCase();
  if (invite && /^[A-Z0-9]{4,12}$/.test(invite)) compact.invite = invite;
  return Buffer.from(JSON.stringify(compact)).toString("base64url");
}

function decodeWechatOAuthState(raw: string | undefined): WechatOAuthState {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(Buffer.from(raw.trim(), "base64url").toString("utf8")) as WechatOAuthState;
    return {
      next: sanitizeWechatOAuthNext(parsed.next),
      invite: typeof parsed.invite === "string" ? parsed.invite.trim().toUpperCase() : undefined,
    };
  } catch {
    return {};
  }
}

function sanitizeWechatOAuthNext(next: string | undefined): string | undefined {
  const value = next?.trim();
  if (!value || !value.startsWith("/")) return undefined;
  if (value.startsWith("//") || value.includes("\\") || value.includes("\n") || value.includes("\r")) return undefined;
  return value.slice(0, 240);
}

/** 可用指令说明，"帮助" 与新关注欢迎语共用 */
function getHelpText(): string {
  return [
    "我能帮你记录和回忆家里的日常 😊",
    "· 直接说事就会帮你记，比如「今天阿星有点发烧」，发照片也可以",
    "· 告诉我你是谁：回复「我是爸爸」或「我是妈妈」",
    "· 告诉我孩子的称呼：回复「孩子叫阿星」",
    "· 邀请家人一起用：回复「邀请」拿邀请码，家人回复「加入 + 邀请码」",
    "· 想回忆：直接问，比如「上周阿星看医生了吗」",
    `· 网页版：打开 ${getWebAppBaseUrl()} ，翻日历、看照片、补记录都更方便`,
    "随时回复「帮助」可再看这份说明。",
  ].join("\n");
}

function getWelcomeText(): string {
  return `欢迎关注～\n${getHelpText()}`;
}

type AccountCommandResult =
  | { matched: false }
  | { matched: true; intent: "bind" | "invite" | "join" | "web_login" | "help"; reply: string; summary?: unknown };

/** 处理账号/家庭类命令：帮助、网页登录暗号、自报身份、发起邀请、凭码加入。命中则直接回复，不进入记忆管线。 */
function handleAccountCommand(input: { platform: string; external_user_id?: string; text: string }): AccountCommandResult {
  const externalUserId = input.external_user_id?.trim();
  if (!externalUserId) return { matched: false };
  const platform = input.platform || "weixin";
  const text = input.text.trim();

  if (/^(帮助|帮助说明|使用说明|怎么用|指令|help|\?|？)$/i.test(text)) {
    return { matched: true, intent: "help", reply: getHelpText() };
  }

  // 网页登录暗号 = 6 位纯数字：优先识别并认领（裸 6 位数字视为登录暗号；加入家庭走「加入 XXXXXX」不撞车）。
  if (normalizeLoginCode(text)) {
    const claim = claimWebLoginCode({ platform, external_user_id: externalUserId, code: text });
    if (claim.ok) {
      return { matched: true, intent: "web_login", reply: "网页登录已确认 ✅ 回到网页就能继续啦。" };
    }
    const reason = claim.reason === "expired" ? "这个登录暗号过期了"
      : claim.reason === "already_used" ? "这个登录暗号已经用过了"
      : claim.reason === "already_claimed" ? "这个登录暗号刚被确认过了"
      : claim.reason === "locked" ? "这个登录暗号尝试次数过多，已被临时锁定"
      : "没找到这个登录暗号";
    return { matched: true, intent: "web_login", reply: `${reason}，请回到网页重新获取一个。` };
  }

  const decl = parseSelfDeclaration(text);
  if (decl) {
    const summary = setSpeakerSelf({ platform, external_user_id: externalUserId, label: decl.label, role: decl.role });
    return {
      matched: true,
      intent: "bind",
      summary,
      reply: `好嘞，记住啦——这个微信对应「${decl.label}」。以后你说的“我”，我都会算到${decl.label}头上。`,
    };
  }

  // 「孩子叫X / 宝宝叫X / 女儿叫X」——登记孩子成员，让抽取能把「X」归一到这个小家伙
  const childMatch = text.match(/^(?:孩子|宝宝|娃|女儿|儿子)(?:叫|是)\s*([一-龥A-Za-z·]{1,8})$/);
  if (childMatch) {
    const added = addFamilyChild({ platform, external_user_id: externalUserId, label: childMatch[1]! });
    if (!added) {
      return { matched: true, intent: "bind", reply: "先随便记一条让我认识你，再告诉我孩子的称呼～" };
    }
    return {
      matched: true,
      intent: "bind",
      reply: added.created
        ? `好嘞，认识「${added.label}」啦！以后你们提到${added.label}，我都知道说的是这个小家伙。`
        : `「${added.label}」我已经认识啦～`,
    };
  }

  if (/^邀请(家人|家庭成员|成员)?$/.test(text)) {
    const invite = createFamilyInvite({ platform, external_user_id: externalUserId });
    if (!invite) {
      return { matched: true, intent: "invite", reply: "你还没有自己的家庭记忆，先随便记一条，我就会帮你建好，然后再来发「邀请」～" };
    }
    return {
      matched: true,
      intent: "invite",
      summary: invite,
      reply: `邀请码：${invite.code}（7 天内有效，家人都能用）\n让家人关注后回复「加入 ${invite.code}」，就能一起共享这份家庭记忆。`,
    };
  }

  const joinMatch = text.match(/^加入\s*([A-Za-z0-9]{4,8})$/);
  if (joinMatch) {
    const result = joinFamilyByInvite({ platform, external_user_id: externalUserId, code: joinMatch[1]! });
    if (!result.ok) {
      const reason = result.reason === "expired" ? "这个邀请码过期了"
        : result.reason === "already_used" ? "这个邀请码已经被用过了"
        : result.reason === "already_in_family" ? "你已经在这个家庭里啦"
        : "没找到这个邀请码";
      return { matched: true, intent: "join", reply: `${reason}，可以让家人重新发一次「邀请」拿个新码。` };
    }
    const name = result.family?.family.name || "家庭";
    return {
      matched: true,
      intent: "join",
      summary: result,
      reply: `已加入「${name}」🎉 现在你们共享同一份家庭记忆了。回复「我是爸爸」之类告诉我你是谁，称呼就更准啦。`,
    };
  }

  return { matched: false };
}

/**
 * 给「自动开户但还没确认身份」的用户拼接一条新手提醒，并做幂等节流。
 * 返回 undefined 表示这次不提醒（已确认身份 / 24h 内已提醒过）。
 */
function buildOnboardingHint(identity: ReturnType<typeof resolveMessageIdentity>): string | undefined {
  if (!identity.bound || !identity.externalUserId) return undefined;
  const state = getSpeakerOnboardingState({ platform: identity.platform, external_user_id: identity.externalUserId });
  if (!state || state.stage !== "auto") return undefined;
  const dayMs = 24 * 60 * 60 * 1000;
  const recentlyReminded = Boolean(state.remindedAt) && Date.now() - Date.parse(state.remindedAt!) < dayMs;
  if (!identity.provisioned && recentlyReminded) return undefined;
  markSpeakerReminded(state.speakerId);
  return ONBOARDING_HINT_TEXT;
}

function appendHint(reply: string | undefined, hint?: string): string | undefined {
  if (!hint) return reply;
  return `${reply ?? ""}\n\n${hint}`;
}

/**
 * 情绪回顾的解读文案：reply LLM 生成一两句温和的观察（不说教、不比较家人、不下诊断），
 * 失败退化为确定性模板。按 owner+当天+天数缓存，一天最多一次 LLM 调用。
 */
const emotionNarrativeCache = new Map<string, string>();

async function buildEmotionNarrative(review: OwnerEmotionReview): Promise<string> {
  if (review.total === 0) return "这段时间还没有情绪记录，随手记点什么，慢慢就能看到自己的底色了。";
  const cacheKey = `${review.owner_id}|${review.to}|${review.days}|${review.total}`;
  const cached = emotionNarrativeCache.get(cacheKey);
  if (cached) return cached;

  const topText = review.top.slice(0, 5).map(t => `${t.emotion}${t.count}次`).join("、");
  const fallback = `最近${review.days}天记下了 ${review.total} 个情绪片段：${topText}。`;
  let narrative = fallback;
  try {
    const out = await getLLM(roleLLMConfig("reply")).chatJSON<{ text?: string }>(
      [
        `这位家人最近 ${review.days} 天（${review.from} ~ ${review.to}）的情绪记录统计：`,
        `总计 ${review.total} 条；正面 ${review.valence.positive}、负面 ${review.valence.negative}、中性 ${review.valence.neutral}。`,
        `出现最多的情绪：${topText}。`,
        `按周走势（旧→新，正/负）：${review.weeks.map(w => `${w.positive}/${w.negative}`).join(" → ")}`,
        "",
        "请写一两句温和的观察，像家里人回看这段日子随口说的话。",
        "硬性要求：只基于数字说话不编造事件；不说教不给建议清单；不比较或评判任何家庭成员；不下心理诊断；不超过60个字。",
        '输出 JSON：{"text":"..."}',
      ].join("\n"),
      "你是 xfeel 的家庭记忆助手。只输出 JSON。",
    );
    const text = out.text?.trim();
    if (text && text.length <= 100) narrative = text;
  } catch (error) {
    logWarn("emotion_narrative_fallback", { error: safeErrorMessage(error) });
  }
  // 缓存兜底文案也没关系：total 变化会换 key，第二天自动失效
  emotionNarrativeCache.set(cacheKey, narrative);
  if (emotionNarrativeCache.size > 500) {
    const firstKey = emotionNarrativeCache.keys().next().value;
    if (firstKey) emotionNarrativeCache.delete(firstKey);
  }
  return narrative;
}

/**
 * 跟进式关怀搭便车：微信没有主动推送通道（客服接口未开通），
 * 就借用户下一条消息的被动回复，在末尾带一句离线预计算好的跟进/回声。
 * 纯 SQL 查表（LLM 重活都在生产侧做完），不吃 15 秒预算；每 owner 每天最多一条。
 * 只挂在 log/chat 上：用户在查旧账（recall/recap）或做操作（undo/archive）时插话很突兀。
 */
function appendCareFollowUp(reply: string, ownerId: string | undefined, intent?: string): string {
  if (!ownerId) return reply;
  if (intent && intent !== "log" && intent !== "chat") return reply;
  try {
    const item = takeCareLineForWechat({ owner_id: ownerId });
    if (!item) return reply;
    logInfo("care_wechat_piggyback", { care_id: item.id, kind: item.kind, intent });
    return `${reply}\n\n${item.content}`;
  } catch (error) {
    logWarn("care_wechat_piggyback_failed", { error: safeErrorMessage(error) });
    return reply;
  }
}

// token / skew 必须在校验时读取，不能在模块作用域捕获：
// bun 全量跑测试时 server.ts 可能被别的文件先 import，那时 WECHAT_TOKEN 还没被本文件的测试 set 上，
// 捕获成空串后所有签名都会被 if (!token) return false 拒掉（单独跑本文件测试是绿的）。
const WECHAT_RETRY_CACHE_TTL_MS = 30_000;
const WECHAT_RETRY_HOLD_TIMEOUT_MS = Number(process.env.WECHAT_RETRY_HOLD_TIMEOUT_MS || 6_000);
const WECHAT_FINAL_RETRY_REPLY_TIMEOUT_MS = Number(process.env.WECHAT_FINAL_RETRY_REPLY_TIMEOUT_MS || 3_800);
const WECHAT_DISPLAYABLE_ATTEMPT = Number(process.env.WECHAT_DISPLAYABLE_ATTEMPT || 3);
const WECHAT_SLOW_PROCESSING_REPLY = "我收到了，只是处理得比较久。";
const WECHAT_ASYNC_ACK_REPLY = process.env.WECHAT_ASYNC_ACK_REPLY || "收到，我先处理，稍后把结果发给你。";
const wechatRetryCache = new Map<string, { content: string; startedAt: number; attempts: number; promise: Promise<string>; result?: string }>();

interface WechatSignatureInput {
  signature: string;
  timestamp: string;
  nonce: string;
}

function wechatToken(): string {
  return process.env.WECHAT_TOKEN?.trim() || "";
}

function wechatSignatureMaxSkewSeconds(): number {
  const value = Number(process.env.WECHAT_SIGNATURE_MAX_SKEW_SECONDS || 300);
  return Number.isFinite(value) && value > 0 ? value : 300;
}

function isValidWechatSignature({ signature, timestamp, nonce }: WechatSignatureInput) {
  const token = wechatToken();
  if (!token || !/^\d{10}$/.test(timestamp) || !nonce || !/^[a-f\d]{40}$/i.test(signature)) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)
    || Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > wechatSignatureMaxSkewSeconds()) return false;
  const digest = crypto
    .createHash("sha1")
    .update([token, timestamp, nonce].sort().join(""))
    .digest("hex");
  // 长度不同时 timingSafeEqual 会抛 RangeError；正则已限制为 40 hex，这里再保险一次。
  if (digest.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(signature, "hex"));
}

interface WechatRequestXml {
  ToUserName?: string;
  FromUserName?: string;
  CreateTime?: string;
  MsgType?: string;
  Content?: string;
  MsgId?: string;
  MediaId?: string;
  PicUrl?: string;
  Format?: string;
  Recognition?: string;
  Event?: string;
  EventKey?: string;
}

interface WechatTextResponse {
  ToUserName: string;
  FromUserName: string;
  CreateTime: number;
  MsgType: "text";
  Content: string;
}

function parseWechatXml(xml: string): WechatRequestXml {
  const fields = ["ToUserName", "FromUserName", "CreateTime", "MsgType", "Content", "MsgId", "MediaId", "PicUrl", "Format", "Recognition", "Event", "EventKey"];
  const result: WechatRequestXml = {};
  for (const field of fields) {
    const match = xml.match(new RegExp(`<${field}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${field}>`));
    if (match) result[field as keyof WechatRequestXml] = unescapeXml(match[1].trim());
  }
  if (!result.FromUserName || !result.ToUserName || !result.MsgType) {
    throw new Error("invalid wechat xml payload");
  }
  return result;
}

function makeWechatTextResponse(wxReq: WechatRequestXml | undefined, content: string): WechatTextResponse {
  return {
    ToUserName: wxReq?.FromUserName || "",
    FromUserName: wxReq?.ToUserName || "",
    CreateTime: Math.floor(Date.now() / 1000),
    MsgType: "text",
    Content: content || "消息我收到了",
  };
}

function renderWechatTextXml(response: WechatTextResponse) {
  return [
    "<xml>",
    `  <ToUserName><![CDATA[${response.ToUserName}]]></ToUserName>`,
    `  <FromUserName><![CDATA[${response.FromUserName}]]></FromUserName>`,
    `  <CreateTime>${response.CreateTime}</CreateTime>`,
    `  <MsgType><![CDATA[${response.MsgType}]]></MsgType>`,
    `  <Content><![CDATA[${response.Content.replace(/]]>/g, "]]]]><![CDATA[>")}]]></Content>`,
    "</xml>",
  ].join("\n");
}

function unescapeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function getWechatRetryContent(wxReq: WechatRequestXml) {
  if (wxReq.MsgType === "text") return wxReq.Content?.trim() || "";
  if (wxReq.MsgType === "voice") return wxReq.Recognition?.trim() || wxReq.MediaId || "";
  return wxReq.MsgId || "";
}

function getWechatLogText(wxReq: WechatRequestXml) {
  if (wxReq.MsgType === "text") return wxReq.Content?.trim() || "";
  if (wxReq.MsgType === "voice") return wxReq.Recognition?.trim() || "";
  return "";
}

function getWechatRetryKey(wxReq: WechatRequestXml) {
  const content = getWechatRetryContent(wxReq);
  const fingerprint = crypto
    .createHash("sha256")
    .update([wxReq.FromUserName || "", wxReq.MsgType || "", content].join("\u0000"))
    .digest("hex");
  return { key: fingerprint, content };
}

function cleanupWechatRetryCache(now = Date.now()) {
  for (const [key, entry] of wechatRetryCache.entries()) {
    if (now - entry.startedAt > WECHAT_RETRY_CACHE_TTL_MS) wechatRetryCache.delete(key);
  }
}

function getWechatRetryCacheStatus(wxReq: WechatRequestXml) {
  cleanupWechatRetryCache();
  const { key, content } = getWechatRetryKey(wxReq);
  if (!content) return { hit: false, attempts: 0, hasResult: false };
  const existing = wechatRetryCache.get(key);
  return {
    hit: Boolean(existing && existing.content === content && Date.now() - existing.startedAt <= WECHAT_RETRY_CACHE_TTL_MS),
    attempts: existing?.attempts ?? 0,
    hasResult: Boolean(existing?.result),
  };
}

function extractWechatResponseContent(xml: string) {
  if (!xml) return "";
  const match = xml.match(/<Content>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/Content>/);
  return match ? unescapeXml(match[1]!.trim()) : "";
}

async function getOrCreateWechatResponseXml(wxReq: WechatRequestXml, create: () => Promise<string>) {
  cleanupWechatRetryCache();
  const { key, content } = getWechatRetryKey(wxReq);
  if (!content) return await waitForWechatResult(create(), WECHAT_FINAL_RETRY_REPLY_TIMEOUT_MS, renderWechatTextXml(makeWechatTextResponse(wxReq, WECHAT_SLOW_PROCESSING_REPLY)));

  const existing = wechatRetryCache.get(key);
  if (existing && existing.content === content && Date.now() - existing.startedAt <= WECHAT_RETRY_CACHE_TTL_MS) {
    existing.attempts += 1;
    if (existing.result) return existing.result;
    const isDisplayableAttempt = existing.attempts >= WECHAT_DISPLAYABLE_ATTEMPT;
    const timeoutMs = isDisplayableAttempt ? WECHAT_FINAL_RETRY_REPLY_TIMEOUT_MS : WECHAT_RETRY_HOLD_TIMEOUT_MS;
    const fallback = isDisplayableAttempt ? renderWechatTextXml(makeWechatTextResponse(wxReq, WECHAT_SLOW_PROCESSING_REPLY)) : "";
    return await waitForWechatResult(existing.promise, timeoutMs, fallback);
  }

  const entry: { content: string; startedAt: number; attempts: number; promise: Promise<string>; result?: string } = {
    content,
    startedAt: Date.now(),
    attempts: 1,
    promise: Promise.resolve().then(create),
  };
  entry.promise = entry.promise
    .then(result => {
      entry.result = result;
      return result;
    })
    .catch(error => {
      wechatRetryCache.delete(key);
      logError("wechat_retry_async_processing_failed", {
        from_user_hash: hashId(wxReq.FromUserName),
        from_user_mask: maskId(wxReq.FromUserName),
        msg_type: wxReq.MsgType,
        msg_id: wxReq.MsgId,
        error: safeErrorMessage(error),
      });
      return renderWechatTextXml(makeWechatTextResponse(wxReq, "消息我收到了，但处理时出错。"));
    });
  wechatRetryCache.set(key, entry);
  return await waitForWechatResult(entry.promise, WECHAT_RETRY_HOLD_TIMEOUT_MS, "");
}

async function waitForWechatResult(promise: Promise<string>, timeoutMs: number, fallback = "") {
  const timeout = new Promise<string>(resolve => {
    setTimeout(() => resolve(fallback), timeoutMs);
  });
  return await Promise.race([promise, timeout]);
}

function getWechatAppId() {
  return process.env.WECHAT_APP_ID || process.env.WEIXIN_APP_ID || "";
}

function getWechatAppSecret() {
  return process.env.WECHAT_APP_SECRET || process.env.WEIXIN_APP_SECRET || "";
}

function hasWechatCustomerServiceCredentials() {
  return Boolean(getWechatAppId() && getWechatAppSecret());
}

async function sendWechatFinalReplyAfterProcessing(openid: string, finalReply: Promise<string>) {
  const startedAt = Date.now();
  logInfo("wechat_final_reply_start", {
    openid_hash: hashId(openid),
    openid_mask: maskId(openid),
  });
  try {
    const content = await finalReply;
    await sendWechatCustomerServiceText(openid, content);
    logInfo("wechat_final_reply_success", {
      openid_hash: hashId(openid),
      duration_ms: Date.now() - startedAt,
      ...textLogFieldsRedactingValues("reply", content, [openid]),
    });
  } catch (error) {
    logError("wechat_final_reply_failure", {
      openid_hash: hashId(openid),
      openid_mask: maskId(openid),
      duration_ms: Date.now() - startedAt,
      error: safeErrorMessage(error),
    });
  }
}

async function sendWechatCustomerServiceText(openid: string, content: string) {
  const startedAt = Date.now();
  logInfo("wechat_customer_service_send_start", {
    openid_hash: hashId(openid),
    openid_mask: maskId(openid),
    ...textLogFieldsRedactingValues("content", content, [openid]),
  });
  const appId = getWechatAppId();
  const secret = getWechatAppSecret();
  try {
    if (!appId || !secret) {
      logWarn("wechat_customer_service_send_skipped", {
        openid_hash: hashId(openid),
        reason: "missing_app_credentials",
        duration_ms: Date.now() - startedAt,
      });
      return { skipped: true as const };
    }
    const tokenRes = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`);
    const tokenBody = await tokenRes.json() as { access_token?: string; errmsg?: string };
    if (!tokenRes.ok || !tokenBody.access_token) throw new Error(`wechat token request failed: ${tokenBody.errmsg || tokenRes.status}`);
    const sendRes = await fetch(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(tokenBody.access_token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ touser: openid, msgtype: "text", text: { content } }),
    });
    const sendBody = await sendRes.json().catch(() => ({})) as { errcode?: number; errmsg?: string };
    if (!sendRes.ok || (sendBody.errcode ?? 0) !== 0) throw new Error(`wechat custom send failed: ${sendBody.errmsg || sendRes.status}`);
    logInfo("wechat_customer_service_send_success", {
      openid_hash: hashId(openid),
      duration_ms: Date.now() - startedAt,
      errcode: sendBody.errcode ?? 0,
    });
    return { skipped: false as const };
  } catch (error) {
    logError("wechat_customer_service_send_failure", {
      openid_hash: hashId(openid),
      openid_mask: maskId(openid),
      duration_ms: Date.now() - startedAt,
      error: safeErrorMessage(error),
    });
    throw error;
  }
}

async function handleWechatRecognizedVoice(wxReq: WechatRequestXml) {
  const text = wxReq.Recognition?.trim();
  if (!text) return { reply: "✅ 已收到您的语音消息。" };
  const identity = resolveMessageIdentity({
    owner_id: wxReq.FromUserName,
    user_id: wxReq.FromUserName,
    platform: "weixin",
  }, { autoProvision: true });
  if (!identity.bound) return { reply: buildUnboundWeixinReply(wxReq.FromUserName) };

  const onboardingHint = buildOnboardingHint(identity);
  const result = await handleProductMessage({
    text,
    owner_id: identity.ownerId,
    user_id: identity.ownerId,
    scope_owner_ids: identity.scopeOwnerIds,
    speaker_id: identity.speakerId,
    speaker_label: identity.speakerLabel,
    aliasContext: identity.aliasContext,
  });
  return { reply: appendHint(result.reply || "消息我收到了", onboardingHint)! };
}

/**
 * 微信图片消息：下载 PicUrl 并落地持久化 → vision 转写成中文日记描述 →
 * 把描述当普通文字走 product loop（复用分类/抽取/共情回复）。
 * 转写失败时不入库，只回一句引导用户补充文字。返回给用户看的回复文本。
 */
async function processWechatImageToReply(wxReq: WechatRequestXml, identity: ReturnType<typeof resolveMessageIdentity>): Promise<string> {
  const onboardingHint = buildOnboardingHint(identity);
  const picUrl = wxReq.PicUrl?.trim();
  if (!picUrl) return appendHint("📷 图片收到啦，但我没拿到图像地址，能再发一次吗？", onboardingHint)!;

  let asset;
  try {
    asset = await downloadAndStoreMedia({
      url: picUrl,
      ownerId: identity.ownerId,
      kind: "image",
      sourcePlatform: "weixin",
      sourceMediaId: wxReq.MediaId,
    });
  } catch (error) {
    logWarn("wechat_image_download_failed", {
      from_user_hash: hashId(wxReq.FromUserName),
      msg_id: wxReq.MsgId,
      error: safeErrorMessage(error),
    });
    return appendHint("📷 图片我收到了，但下载没成功，能麻烦再发一次吗？", onboardingHint)!;
  }

  // 用落地的字节构造 data URL，避免 LLM 网关再去拉可能已失效的微信 PicUrl。
  const dataUrl = `data:${asset.mime || "image/jpeg"};base64,${readFileSync(getMediaAssetAbsPath(asset)).toString("base64")}`;
  const { caption, degraded } = await captionImageToDiary({
    images: [{ url: dataUrl }],
    speakerLabel: identity.speakerLabel,
    recentText: recentUserTextForImage(identity.ownerId),
  });
  logInfo("wechat_image_captioned", {
    from_user_hash: hashId(wxReq.FromUserName),
    asset_id: asset.id,
    degraded,
    ...textLogFields("caption", caption),
  });

  if (degraded) {
    recordMediaCaption(asset.id, caption);
    return appendHint("📷 图片收到啦，不过我这会儿没太看清内容，你想配一句话讲讲嘛？", onboardingHint)!;
  }

  const result = await handleProductMessage({
    text: caption,
    owner_id: identity.ownerId,
    user_id: identity.ownerId,
    scope_owner_ids: identity.scopeOwnerIds,
    speaker_id: identity.speakerId,
    speaker_label: identity.speakerLabel,
    aliasContext: identity.aliasContext,
    image_transcript: true,
  });

  const turnId = (result as { result?: { user_turn?: { id?: string } } }).result?.user_turn?.id;
  recordMediaCaption(asset.id, caption, turnId);

  return appendHint(result.reply || "📷 收到啦", onboardingHint)!;
}

async function runEmbeddingStartupCheck(log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }) {
  if (process.env.XFEEL_EMBEDDING_STARTUP_CHECK === "false" || process.env.XFEEL_EMBEDDING_STARTUP_CHECK === "0") {
    embeddingStartupStatus = { ok: false, skipped: true, reason: "disabled_by_env" };
    log.info({
      model: DEFAULT_EMBEDDING_MODEL,
      base_url: DEFAULT_OLLAMA_BASE_URL,
    }, "ollama embedding startup check skipped");
    return;
  }

  embeddingStartupStatus = await warmOllamaEmbedding({
    model: DEFAULT_EMBEDDING_MODEL,
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
    keepAlive: DEFAULT_EMBEDDING_KEEP_ALIVE,
    numCtx: DEFAULT_EMBEDDING_NUM_CTX,
  });

  const fields = {
    model: embeddingStartupStatus.model,
    base_url: embeddingStartupStatus.baseUrl,
    ok: embeddingStartupStatus.ok,
    keep_alive: embeddingStartupStatus.keepAlive,
    num_ctx: embeddingStartupStatus.numCtx,
    dimension: embeddingStartupStatus.dimension,
    loaded: embeddingStartupStatus.loaded,
    context_length: embeddingStartupStatus.contextLength,
    size_vram: embeddingStartupStatus.sizeVram,
    expires_at: embeddingStartupStatus.expiresAt,
    elapsed_ms: embeddingStartupStatus.elapsedMs,
    error: embeddingStartupStatus.error,
  };
  if (embeddingStartupStatus.ok) log.info(fields, "ollama embedding startup check ok");
  else log.warn(fields, "ollama embedding startup check failed");
}

async function main() {
  const app = await buildApp();
  await runEmbeddingStartupCheck(app.log);

  // 启动
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`🚀 xfeel API running on http://localhost:${PORT}`);
  console.log(``);
  console.log(`   === 记忆管线 ===`);
  console.log(`   POST /ingest        — 摄取消息`);
  console.log(`   POST /ingest/batch  — 批量摄取`);
  console.log(`   POST /recall        — 检索记忆`);
  console.log(`   POST /conversation/message — 产品闭环入口（记/查/总结/撤销/修正）`);
  console.log(`   POST /conversation/chat — 对话并召回记忆`);
  console.log(`   POST /conversation/log  — 记录日志并上下文回应`);
  console.log(`   GET/POST /wechat — 原 xfeel 微信公众号入口（XML 兼容）`);
  console.log(`   GET  /conversation/turns — 对话列表`);
  console.log(`   GET  /app — 家庭记忆用户端（移动端优先）`);
  console.log(`   GET  /memories/day — 某天长期记忆（历史回放兜底）`);
  console.log(`   GET  /memories/calendar — 月度记录热度（日历亮点）`);
  console.log(`   POST /web/upload/image — 网页图片上传（转写→product loop）`);
  console.log(`   GET  /conversation/playground — 管理调试台`);
  console.log(`   GET  /conversation/playground/diagnostics — Playground intent/extract 诊断`);
  console.log(`   POST /archive/daily/run — 日终归档`);
  console.log(`   GET  /archive/daily — 归档列表`);
  console.log(`   GET  /events        — 事件列表`);
  console.log(`   GET  /events/:id    — 单个事件`);
  console.log(`   GET  /entities      — 实体列表`);
  console.log(`   GET  /diaries       — 日记列表`);
  console.log(``);
  console.log(`   === 事件归一化 ===`);
  console.log(`   POST /normalize/run   — 批量归一化`);
  console.log(`   GET  /normalize/stats — 归一化统计`);
  console.log(``);
  console.log(`   === 时序分析 ===`);
  console.log(`   GET  /analytics/summary  — 全局摘要`);
  console.log(`   GET  /analytics/heatmap  — 情绪热力图`);
  console.log(`   GET  /analytics/trends   — 情绪趋势`);
  console.log(`   GET  /analytics/phases   — 生活阶段`);
  console.log(`   GET  /analytics/compare  — 多人对比`);
  console.log(`   GET  /analytics/entity/:name — 实体演化`);
  console.log(``);
  console.log(`   === 统计 ===`);
  console.log(`   GET  /stats         — 统计信息`);
  console.log(`   GET  /stats/tags    — 标签统计`);
  console.log(`   GET  /stats/emotions — 情绪统计`);
  console.log(`   GET  /stats/timeline — 时间线`);
  console.log(`   GET  /graph         — 实体图谱`);
  console.log(`   GET  /vocabulary    — 受控词表`);
  console.log(`   GET  /health        — 健康检查`);
}
if (import.meta.main) {
  main().catch(console.error);
}

/**
 * 前端页面以独立 .html 文件维护（apps/ingest-api/src/web/），避免内嵌在 TS 模板字符串里
 * 反复踩转义陷阱（\" / \' / 反引号）。每次请求实时读取，改完文件刷新即可，无需重启。
 */
const WEB_DIR = join(import.meta.dir, "web");
function readWebAsset(name: string): string {
  return readFileSync(join(WEB_DIR, name), "utf8");
}

/** 无需登录即可访问的路由：登录页面本身、静态资源、登录流程、公众号回调、健康检查。 */
function isPublicPath(method: string, path: string): boolean {
  if (method === "GET") {
    if (path === "/" || path === "/app" || path === "/dashboard" || path === "/conversation/playground") return true;
    if (path === "/health" || path === "/wechat") return true;
    if (path === "/wechat/oauth/start" || path === "/wechat/oauth/callback") return true;
    if (/^\/web\/[a-zA-Z0-9_.-]+\.(?:js|css|png|jpe?g|svg|webp|gif|ico)$/.test(path)) return true; // 静态资源（auth.js、二维码等）
    if (path === "/web/login/status") return true;                       // 登录轮询
  }
  if (method === "POST") {
    if (path === "/wechat") return true; // 公众号服务器回调，带不了我们的 JWT
    if (path === "/web/login/start" || path === "/web/login/redeem") return true;
  }
  return false;
}

/** 从 Authorization: Bearer 头或 ?token= 查询参数取出凭证串（<img>/<a> 无法带头，走查询参数）。 */
function extractRequestToken(authHeader: string | undefined, url: string): { value: string; fromQuery: boolean } | null {
  const bearer = authHeader && /^Bearer\s+/i.test(authHeader) ? authHeader.replace(/^Bearer\s+/i, "").trim() : "";
  if (bearer) return { value: bearer, fromQuery: false };
  const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const fromQuery = qs ? new URLSearchParams(qs).get("token") : null;
  return fromQuery && fromQuery.trim() ? { value: fromQuery.trim(), fromQuery: true } : null;
}

/** 读单张媒体的路径（GET /media/:id）。查询参数 token 和 media-scope token 只放行这里。 */
function isMediaFetchPath(method: string, path: string): boolean {
  return method === "GET" && /^\/media\/[^/]+$/.test(path) && path !== "/media/list";
}

function authDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.XFEEL_AUTH_DISABLED || "");
}

function canManageOwnUnderstanding(req: unknown, ownerId: string): boolean {
  if (authDisabled()) return true;
  const auth = (req as AuthedRequest).auth;
  return Boolean(auth?.admin || (auth?.claims?.sub && auth.claims.sub === ownerId));
}

/** 登录者身份：admin（看所有家庭）或普通家庭成员（ownerIds = 自己家庭的 owner 集合）。 */
export interface RequestAuth {
  admin: boolean;
  claims?: WebTokenClaims;
  ownerIds: Set<string> | null; // admin 为 null（不限）
}
type AuthedRequest = { auth?: RequestAuth };

/**
 * 全局聚合/分析面板：底层函数全库扫描、无 owner 过滤，无法按家庭收窄，故仅 admin 可见。
 * 普通家庭用户走 playground 的按 owner 隔离接口。
 */
function isAdminOnlyPath(method: string, path: string): boolean {
  if (method === "GET") {
    if (path === "/stats" || path.startsWith("/stats/")) return true;
    if (path === "/graph" || path === "/entities" || path === "/events" || path === "/diaries") return true;
    if (path === "/media/list") return true;
    if (path.startsWith("/analytics/")) return true;
    if (path === "/normalize/stats" || path === "/onboarding/summary") return true;
  }
  if (method === "POST") {
    if (path === "/normalize/run" || path === "/onboarding/family") return true;
    if (path === "/ingest" || path === "/ingest/batch") return true;
  }
  return false;
}

/** 收集请求里出现的 owner 归属键（query + JSON body 的 owner_id/user_id），用于隔离校验。 */
function collectOwnerCandidates(req: { query?: unknown; body?: unknown }): string[] {
  const out: string[] = [];
  const pick = (src: unknown) => {
    if (!src || typeof src !== "object" || Array.isArray(src)) return;
    const obj = src as Record<string, unknown>;
    for (const key of ["owner_id", "user_id"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
    const scope = obj.scope_owner_ids;
    if (Array.isArray(scope)) {
      for (const owner of scope) if (typeof owner === "string" && owner.trim()) out.push(owner.trim());
    }
  };
  pick(req.query);
  pick(req.body);
  return out;
}

/** 找出一个 pipeline message 实际涉及的 owner，供按资源 ID 删除时做授权。 */
function ownersForPipelineMessage(messageId: string): string[] {
  const db = getDB();
  const rows = db.prepare(`
    SELECT owner_id AS owner FROM conversation_turns
    WHERE id = ? OR json_extract(metadata, '$.pipeline_message_id') = ?
    UNION
    SELECT user_id AS owner FROM memory_events WHERE raw_message_id = ?
  `).all(messageId, messageId, messageId) as Array<{ owner?: string | null }>;
  return [...new Set(rows.map(row => row.owner?.trim()).filter((owner): owner is string => Boolean(owner)))];
}

/**
 * 发图前几分钟内用户刚说过的话（给 vision 转写当上下文，如先说「新买的车」再发车照）。
 * 排除图片转写本身，避免上一张图的转写污染下一张。
 */
function recentUserTextForImage(ownerId: string, windowMs = 3 * 60 * 1000): string {
  const since = new Date(Date.now() - windowMs).toISOString();
  const rows = getDB().prepare(`
    SELECT content, metadata FROM conversation_turns
    WHERE owner_id = ? AND role = 'user' AND created_at >= ?
    ORDER BY created_at DESC LIMIT 3
  `).all(ownerId, since) as Array<{ content: string; metadata?: string }>;
  const texts: string[] = [];
  for (const row of rows) {
    try { if (row.metadata && JSON.parse(row.metadata).image_transcript) continue; } catch { /* ignore */ }
    if (row.content?.trim()) texts.push(row.content.trim());
  }
  return texts.reverse().join("；").slice(0, 200);
}

/**
 * 网页请求的身份解析：优先用登录态 claims 里的 openid 取回完整家庭上下文
 * （别名消歧/称呼/家庭共享召回域）——只传 owner_id 会丢掉这些。
 * admin 或无 claims（本地脚本/测试）时回退到 body 入参，行为不变。
 */
function resolveRequestIdentity(req: unknown, body: MessageIdentityInput) {
  const auth = (req as AuthedRequest).auth;
  const uid = auth && !auth.admin ? auth.claims?.uid : undefined;
  if (uid) return resolveMessageIdentity({ user_id: uid, platform: auth?.claims?.plat || "weixin" });
  return resolveMessageIdentity(body);
}

/**
 * admin 专用：全库所有家庭 + 成员，按家庭分组。playground/dashboard 的「切换用户」选择器
 * 用它渲染 <optgroup>，让 admin 能选到任意家庭的任意成员（含孩子），不只是主家庭的爸妈。
 * 同名家庭（自动开户默认叫「我的家庭」）用创建日期消歧（比 id 片段可读）。
 */
interface OwnerGroup {
  family_id: string;
  family_name: string;
  family_label: string;
  members: Array<{ id: string; label: string; created_at?: string }>;
}

function collectAllOwnerGroups(): OwnerGroup[] {
  const families = getDB().prepare("SELECT id, name, created_at FROM families ORDER BY created_at ASC").all() as Array<{ id: string; name: string; created_at: string }>;
  const nameCount: Record<string, number> = {};
  for (const f of families) nameCount[f.name] = (nameCount[f.name] || 0) + 1;
  return families.map(f => {
    const members = getDB().prepare("SELECT id, label, created_at FROM family_members WHERE family_id = ? ORDER BY CASE role WHEN 'parent' THEN 0 WHEN 'elder' THEN 1 WHEN 'child' THEN 2 ELSE 3 END, label")
      .all(f.id) as Array<{ id: string; label: string; created_at: string }>;
    const disambiguate = nameCount[f.name]! > 1;
    return {
      family_id: f.id,
      family_name: f.name,
      family_label: disambiguate ? `${f.name}·${shortMonthDay(f.created_at)}` : f.name,
      members,
    };
  }).filter(g => g.members.length > 0);
}

/**
 * admin 视角把所有家庭成员拍平给 /app：占位称呼（如多个「本人」）会撞名，
 * 重名成员的 label 带上注册日期（仍撞再退化为家庭标签），一眼看出是不同家庭的人。
 */
function flattenOwnerGroups(groups: OwnerGroup[]): Array<{ id: string; label: string }> {
  const labelCount: Record<string, number> = {};
  for (const g of groups) for (const m of g.members) labelCount[m.label] = (labelCount[m.label] || 0) + 1;
  const seen = new Set<string>();
  return groups.flatMap(g => g.members.map(m => {
    if (labelCount[m.label]! <= 1) return { id: m.id, label: m.label };
    let label = `${m.label}·${shortMonthDay(m.created_at)}`;
    if (seen.has(label)) label = `${m.label}·${g.family_label}`;
    seen.add(label);
    return { id: m.id, label };
  }));
}

/** "2026-07-01 15:05:41" → "7/1"；解析失败退回原串前 10 位。 */
function shortMonthDay(raw?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw || "");
  return m ? `${Number(m[2])}/${Number(m[3])}` : (raw || "").slice(0, 10);
}

/** owner id → 称呼映射（可按家庭收窄）。前端用它把「记录者」从裸 id 渲染成爸爸/妈妈。 */
function collectOwnerLabels(familyId?: string): Record<string, string> {
  const rows = (familyId
    ? getDB().prepare("SELECT id, label FROM family_members WHERE family_id = ? AND label IS NOT NULL AND label != ''").all(familyId)
    : getDB().prepare("SELECT id, label FROM family_members WHERE label IS NOT NULL AND label != ''").all()
  ) as Array<{ id: string; label: string }>;
  const map: Record<string, string> = {};
  for (const row of rows) map[row.id] = row.label;
  return map;
}

/** 收集请求里出现的 family_id（query + JSON body），用于家庭隔离校验。 */
function collectFamilyCandidates(req: { query?: unknown; body?: unknown }): string[] {
  const out: string[] = [];
  const pick = (src: unknown) => {
    if (!src || typeof src !== "object" || Array.isArray(src)) return;
    const v = (src as Record<string, unknown>).family_id;
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  };
  pick(req.query);
  pick(req.body);
  return out;
}

function buildConversationPlaygroundHtml() {
  const owners = resolvePlaygroundOwnerDefaults();
  const defaultDate = normalizeLocalDate();
  return readWebAsset("playground.html")
    .replaceAll("__PLAYGROUND_DAD_OWNER_ID__", escapeHtmlAttribute(owners.dadOwnerId))
    .replaceAll("__PLAYGROUND_MOM_OWNER_ID__", escapeHtmlAttribute(owners.momOwnerId))
    .replaceAll("__PLAYGROUND_DATE__", defaultDate);
}
