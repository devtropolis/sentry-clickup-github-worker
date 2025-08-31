// src/index.ts
// Cloudflare Worker: Sentry → (AI via GitHub Models or OpenAI) → ClickUp → (tag) → GitHub/Copilot
// Endpoints:
// - POST /webhooks/sentry?token=...     (Sentry issue alert payloads)
// - POST /webhooks/clickup?token=...    (ClickUp webhook payloads; tag → GH issue)
// - GET/PUT /admin/standards?token=...  (Manage Copilot standards text in KV)
// - GET  /health

interface Env {
  // --- KV
  STATE: KVNamespace; // groupKey → { clickup_task_id?, issue_number?, count, first_seen }

  // --- Shared inbound token(s)
  SENTRY_SHARED_TOKEN?: string;
  CLICKUP_SHARED_TOKEN?: string;
  ADMIN_TOKEN?: string;

  // --- GitHub
  GITHUB_TOKEN: string;           // required for GitHub Issues
  GITHUB_REPO: string;            // "owner/repo"
  GITHUB_LABELS?: string;         // e.g. "sentry,ai,triage"
  GITHUB_AGENT_LABEL?: string;    // e.g. "copilot-apply"
  GITHUB_ASSIGNEE?: string;       // e.g. "github-copilot"
  GITHUB_API_VERSION?: string;    // default "2022-11-28"

  // --- ClickUp
  CLICKUP_TOKEN?: string;         // task read/write scope
  CLICKUP_LIST_ID?: string;       // list to create tasks in
  CLICKUP_FIX_TAG?: string;       // default "ai-to-fix"

  // --- AI: prefer GitHub Models if present, else OpenAI
  GITHUB_MODEL_API_KEY?: string;  // PAT for GitHub Models
  GITHUB_MODEL_API_URL?: string;  // default "https://models.inference.ai.azure.com"
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;       // default "https://api.openai.com/v1"
  OPENAI_MODEL?: string;          // default "gpt-4o-mini"

  // --- Feature flags
  CREATE_GITHUB_ON_SENTRY?: string;  // "true" to also create GH on first Sentry alert
  UPDATE_CLICKUP_ON_REPEAT?: string; // "true" to add a repeat-occurrence comment (default true)

  // --- Optional severity mapping (level → GH label)
  LEVEL_LABELS_JSON?: string;     // e.g. {"error":"sev-high","warning":"sev-low"}
}

type AnyJson = Record<string, any>;
type StateRecord = { clickup_task_id?: string; issue_number?: number; count: number; first_seen: string; };
type StandardsRecord = { text: string; updated_at: string; };

const STANDARDS_KEY = "STANDARDS:TEXT";

const ok = (msg = "ok", status = 200) => new Response(msg, { status });
const err = (msg: string, status = 400) => new Response(msg, { status });
const json = (data: any, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status, headers: { "content-type": "application/json" },
});
const bool = (v: string | undefined, d = false) => (v ? v.toLowerCase() === "true" : d);
const nowIso = () => new Date().toISOString();

function ghHeaders(env: Env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "sentry-clickup-github-worker/2.0",
    "X-GitHub-Api-Version": env.GITHUB_API_VERSION || "2022-11-28",
  };
}

function openaiHeaders(env: Env) {
  return { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" };
}
function ghModelsHeaders(env: Env) {
  return { Authorization: `Bearer ${env.GITHUB_MODEL_API_KEY}`, "Content-Type": "application/json" };
}

function levelToLabel(level: string | undefined, env: Env): string | undefined {
  if (!level) return undefined;
  try { return env.LEVEL_LABELS_JSON ? JSON.parse(env.LEVEL_LABELS_JSON)[level] : undefined; }
  catch { return undefined; }
}

function parseSentry(payload: AnyJson) {
  const issueObj = payload.issue ?? payload.data?.issue ?? payload.event?.issue ?? null;
  const eventObj = payload.event ?? payload.data?.event ?? null;

  const projectSlug = payload.project_slug || payload.project?.slug || payload.project || payload.data?.issue?.project?.slug || "unknown";
  const environment =
    payload.environment ||
    eventObj?.environment ||
    (Array.isArray(eventObj?.tags) ? eventObj.tags.find((t: any) => t?.key === "environment")?.value : undefined) ||
    "unknown";

  const sentryIssueId = issueObj?.id || payload.issue_id || payload.data?.issue?.id || null;
  const title = issueObj?.title || eventObj?.title || payload.title || "Unhandled error";
  const permalink = issueObj?.permalink || payload.url || payload.issue_url || "";
  const level = payload.level || eventObj?.level;

  const framesList =
    eventObj?.exception?.values?.[0]?.stacktrace?.frames ||
    payload?.exception?.values?.[0]?.stacktrace?.frames ||
    [];

  const culprit = issueObj?.culprit;
  const message = eventObj?.message || eventObj?.exception?.values?.[0]?.value || payload?.message || "";

  return {
    projectSlug, environment, sentryIssueId, title, permalink, level, culprit, message,
    frames: (framesList as any[]).slice(-8).reverse(),
    raw: payload,
  };
}
function groupKeyFrom(p: ReturnType<typeof parseSentry>) {
  return `${p.projectSlug}:${p.environment}:${p.sentryIssueId}`;
}
function buildFramesMarkdown(frames: any[]): string {
  if (!frames?.length) return "";
  const lines = frames.map((f) => {
    const file = [f.module, f.filename].filter(Boolean).join("/");
    const line = f.lineno ? `:${f.lineno}` : "";
    const fn = f.function ? ` – ${f.function}` : "";
    return `- \`${file}${line}\`${fn}`;
  });
  return `<details><summary>Top frames</summary>\n\n${lines.join("\n")}\n\n</details>`;
}

// --------- AI: Prefer GitHub Models, fallback to OpenAI ----------
async function aiSummarize(env: Env, parsed: ReturnType<typeof parseSentry>) {
  const model = env.OPENAI_MODEL || "gpt-4o-mini";

  const prompt = [
    "You are a senior software engineer. Produce a crisp, actionable incident summary from a Sentry event.",
    "Return markdown with these sections:",
    "## Summary (2-3 sentences, plain English)",
    "## Likely Cause (bullet list)",
    "## Impact",
    "## Reproduction Steps",
    "## Suggested Fix",
    "## Extra Context",
    "",
    `**Title:** ${parsed.title}`,
    `**Project:** ${parsed.projectSlug}`,
    `**Environment:** ${parsed.environment}`,
    parsed.level ? `**Level:** ${parsed.level}` : "",
    parsed.culprit ? `**Culprit:** ${parsed.culprit}` : "",
    parsed.message ? `**Message:** ${parsed.message}` : "",
    "",
    buildFramesMarkdown(parsed.frames),
  ].filter(Boolean).join("\n");

  // 1) GitHub Models (if configured)
  if (env.GITHUB_MODEL_API_KEY) {
    const base = env.GITHUB_MODEL_API_URL || "https://models.inference.ai.azure.com";
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: ghModelsHeaders(env),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You write concise, high-signal incident reports." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
      }),
    });
    if (res.ok) {
      const data = await res.json() as AnyJson;
      return data.choices?.[0]?.message?.content || null;
    } else {
      const t = await res.text().catch(() => "");
      console.warn("GitHub Models summarize failed:", res.status, t);
    }
  }

  // 2) OpenAI (fallback)
  if (env.OPENAI_API_KEY) {
    const base = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: openaiHeaders(env),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You write concise, high-signal incident reports." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
      }),
    });
    if (res.ok) {
      const data = await res.json() as AnyJson;
      return data.choices?.[0]?.message?.content || null;
    } else {
      const t = await res.text().catch(() => "");
      console.warn("OpenAI summarize failed:", res.status, t);
    }
  }

  return null; // no provider configured or both failed
}

// --------- ClickUp ----------
async function clickupCreateOrUpdate(
  env: Env,
  groupKey: string,
  parsed: ReturnType<typeof parseSentry>,
  aiMd: string | null,
  state: StateRecord | null
) {
  if (!env.CLICKUP_TOKEN || !env.CLICKUP_LIST_ID) {
    return { created: false, task_id: undefined as string | undefined };
  }

  const base = "https://api.clickup.com/api/v2";
  const headers = { Authorization: env.CLICKUP_TOKEN, "Content-Type": "application/json" };
  const title = `[Sentry][${parsed.environment}] ${parsed.title}`;

  const description = [
    "### Links",
    parsed.permalink ? `- **Sentry Issue:** ${parsed.permalink}` : "- (No Sentry link)",
    "",
    "### AI Summary",
    aiMd ?? "_AI summary unavailable_",
    "",
    "### Context",
    `- **Project:** ${parsed.projectSlug}`,
    parsed.level ? `- **Level:** ${parsed.level}` : "",
    parsed.culprit ? `- **Culprit:** \`${parsed.culprit}\`` : "",
    "",
    buildFramesMarkdown(parsed.frames),
    "",
    `> GroupKey: \`${groupKey}\``,
  ].join("\n");

  if (!state?.clickup_task_id) {
    const res = await fetch(`${base}/list/${env.CLICKUP_LIST_ID}/task`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: title,
        description,
        tags: ["sentry", parsed.environment].filter(Boolean),
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`ClickUp create failed: ${res.status} ${t}`);
    }
    const task = await res.json();
    return { created: true, task_id: task.id as string };
  }

  if (bool(env.UPDATE_CLICKUP_ON_REPEAT, true)) {
    const res = await fetch(`${base}/task/${state.clickup_task_id}/comment`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        comment_text: [
          `New occurrence for **${title}**`,
          parsed.level ? `- Level: ${parsed.level}` : "",
          `- Seen at: ${nowIso()}`,
          parsed.permalink ? `- Sentry: ${parsed.permalink}` : "",
        ].filter(Boolean).join("\n"),
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn("ClickUp comment failed:", res.status, t);
    }
  }

  return { created: false, task_id: state.clickup_task_id };
}

async function clickupAddComment(env: Env, taskId: string, comment: string) {
  if (!env.CLICKUP_TOKEN) return;
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    method: "POST",
    headers: { Authorization: env.CLICKUP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ comment_text: comment }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.warn("ClickUp add comment failed:", res.status, t);
  }
}

// --------- GitHub ----------
async function githubCreateOrUpdateIssue(
  env: Env,
  groupKey: string,
  parsed: {
    projectSlug: string; environment: string; sentryIssueId: string | null;
    title: string; permalink: string; level?: string; culprit?: string; frames: any[];
  },
  aiMd: string | null,
  standards: StandardsRecord | null,
  existingIssueNumber?: number
) {
  const [owner, repo] = (env.GITHUB_REPO || "").split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPO must be 'owner/repo'");

  const headers = ghHeaders(env);
  const title = `[Sentry][${parsed.environment}] ${parsed.title}`;
  const levelLabel = levelToLabel(parsed.level, env);
  const baseLabels = (env.GITHUB_LABELS || "sentry").split(",").map(s => s.trim()).filter(Boolean);
  const labels = [...baseLabels];
  if (levelLabel) labels.push(levelLabel);
  if (env.GITHUB_AGENT_LABEL) labels.push(env.GITHUB_AGENT_LABEL);

  const body = [
    "## 📝 Summary",
    "Issue auto-generated from Sentry + AI review.",
    "",
    "## 🔗 Links",
    parsed.permalink ? `- **Sentry Issue:** ${parsed.permalink}` : "- (No Sentry link)",
    "",
    "## 🤖 AI Review",
    aiMd ?? "_AI summary unavailable_",
    "",
    "## 🔍 Context",
    `- **Project:** ${parsed.projectSlug}`,
    parsed.level ? `- **Level:** ${parsed.level}` : "",
    parsed.culprit ? `- **Culprit:** \`${parsed.culprit}\`` : "",
    "",
    buildFramesMarkdown(parsed.frames),
    "",
    "## 📐 Standards & Expectations",
    standards?.text || "_No standards configured yet. Use `/admin/standards` to set them._",
  ].join("\n");

  if (!existingIssueNumber) {
    const createRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title,
        body,
        labels,
        assignees: env.GITHUB_ASSIGNEE ? [env.GITHUB_ASSIGNEE] : undefined,
      }),
    });
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`GitHub create failed: ${createRes.status} ${text}`);
    }
    const created = await createRes.json() as { number: number };
    return created.number;
  }

  const patchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${existingIssueNumber}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!patchRes.ok) {
    const text = await patchRes.text();
    throw new Error(`GitHub patch failed: ${patchRes.status} ${text}`);
  }
  return existingIssueNumber;
}

// --------- Standards (KV) ----------
async function getStandards(env: Env): Promise<StandardsRecord | null> {
  const rec = await env.STATE.get(STANDARDS_KEY, "json") as StandardsRecord | null;
  return rec ?? null;
}
async function setStandards(env: Env, text: string) {
  const rec: StandardsRecord = { text, updated_at: nowIso() };
  await env.STATE.put(STANDARDS_KEY, JSON.stringify(rec));
  return rec;
}

// --------- Handlers ---------
async function handleSentry(req: Request, env: Env) {
  const url = new URL(req.url);
  if (env.SENTRY_SHARED_TOKEN && url.searchParams.get("token") !== env.SENTRY_SHARED_TOKEN) {
    return err("unauthorized", 401);
  }
  if (req.method !== "POST" || url.pathname !== "/webhooks/sentry") return ok("Worker is running");

  const payload = await req.json().catch(() => ({})) as AnyJson;
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return err("Missing GitHub config", 500);

  // Ignore empty test pings
  if (Object.keys(payload).length <= 2 && !payload.issue && !payload.event && !payload.data) {
    return ok("ok");
  }

  const parsed = parseSentry(payload);
  if (!parsed.sentryIssueId) return ok("ok (no issue id)");
  const gk = groupKeyFrom(parsed);

  const prior = await env.STATE.get(gk, "json") as StateRecord | null;
  const count = (prior?.count ?? 0) + 1;
  const firstSeen = prior?.first_seen ?? nowIso();

  // AI (best-effort)
  const aiMd = await aiSummarize(env, parsed);

  // ClickUp
  const cu = await clickupCreateOrUpdate(env, gk, parsed, aiMd, prior);

  // Save state
  const newState: StateRecord = {
    clickup_task_id: cu.task_id ?? prior?.clickup_task_id,
    issue_number: prior?.issue_number,
    count,
    first_seen: firstSeen,
  };
  await env.STATE.put(gk, JSON.stringify(newState), { expirationTtl: 60 * 60 * 24 * 90 });

  // Optionally create GH immediately
  if (bool(env.CREATE_GITHUB_ON_SENTRY, false)) {
    const standards = await getStandards(env);
    const num = await githubCreateOrUpdateIssue(env, gk, parsed, aiMd, standards, prior?.issue_number);
    await env.STATE.put(gk, JSON.stringify({ ...newState, issue_number: num }), { expirationTtl: 60 * 60 * 24 * 90 });
    if (newState.clickup_task_id) {
      await clickupAddComment(env, newState.clickup_task_id, `Created GitHub issue **#${num}** from Sentry event.`);
    }
  }

  const msg = cu.created
    ? `ClickUp task ${cu.task_id} created (occurrence ${count}).`
    : `ClickUp task ${cu.task_id ?? "(none)"} updated (occurrence ${count}).`;
  return ok(msg, cu.created ? 201 : 200);
}

async function handleClickUp(req: Request, env: Env) {
  const url = new URL(req.url);
  if (env.CLICKUP_SHARED_TOKEN && url.searchParams.get("token") !== env.CLICKUP_SHARED_TOKEN) {
    return err("unauthorized", 401);
  }
  if (req.method !== "POST") return err("Method not allowed", 405);
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return err("Missing GitHub config", 500);

  const body = await req.json().catch(() => ({})) as AnyJson;

  // Try to extract task+tags from webhook
  const task = body?.task ?? body?.event?.task ?? body;
  const taskId = task?.id || task?.task_id || body?.task_id;
  if (!taskId) return ok("no task id");

  const tags: string[] =
    (task?.tags ?? task?.tag) && Array.isArray(task?.tags ?? task?.tag)
      ? (task?.tags ?? task?.tag).map((t: any) => (typeof t === "string" ? t : t?.name)).filter(Boolean)
      : [];

  const triggerTag = (env.CLICKUP_FIX_TAG || "ai-to-fix").toLowerCase();
  const hasTrigger = tags.map((t) => (t || "").toLowerCase()).includes(triggerTag);

  if (!hasTrigger) {
    // some webhooks carry changes
    const added = body?.history_items?.[0]?.after?.tag || body?.changes?.tags?.added?.[0];
    if (!added || (added.name || added).toString().toLowerCase() !== triggerTag) {
      return ok("no trigger tag");
    }
  }

  if (!env.CLICKUP_TOKEN) return err("Missing CLICKUP_TOKEN", 500);

  // Fetch full task to get description (contains GroupKey)
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    headers: { Authorization: env.CLICKUP_TOKEN },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return err(`ClickUp get task failed: ${res.status} ${t}`, 502);
  }
  const full = await res.json() as AnyJson;
  const description: string = full?.description || "";

  const gkMatch = description.match(/GroupKey:\s*`([^`]+)`/i);
  const groupKey = gkMatch?.[1];
  if (!groupKey) return err("No GroupKey found in task description", 400);

  const state = await env.STATE.get(groupKey, "json") as StateRecord | null;

  // Reconstruct minimal parsed data
  const name = full?.name || "";
  const envMatch = name.match(/\[Sentry]\[(.+?)\]\s/);
  const envName = envMatch?.[1] || "unknown";

  const sentryUrlMatch = description.match(/\*\*Sentry Issue:\*\*\s*(\S+)/);
  const sentryUrl = sentryUrlMatch?.[1] || "";

  const parsedLite = {
    projectSlug: "unknown",
    environment: envName,
    sentryIssueId: groupKey.split(":").pop() || null,
    title: name.replace(/^\[Sentry]\[[^\]]+]\s*/, "") || "Unhandled error",
    permalink: sentryUrl,
    level: undefined as string | undefined,
    culprit: undefined as string | undefined,
    frames: [] as any[],
  };

  // Try to reuse AI summary from description
  const aiBlock = description.split("### AI Summary").pop();
  const aiMd = aiBlock ? aiBlock.trim() : null;

  const standards = await getStandards(env);
  const issueNo = await githubCreateOrUpdateIssue(
    env,
    groupKey,
    parsedLite,
    aiMd,
    standards,
    state?.issue_number
  );

  await env.STATE.put(groupKey, JSON.stringify({
    clickup_task_id: taskId,
    issue_number: issueNo,
    count: state?.count ?? 1,
    first_seen: state?.first_seen ?? nowIso(),
  }), { expirationTtl: 60 * 60 * 24 * 90 });

  await clickupAddComment(env, taskId, `Created/updated GitHub issue **#${issueNo}** for Copilot.\n\n_(Trigger: \`${triggerTag}\` tag)_`);
  return ok(`GH issue #${issueNo} created/updated from ClickUp tag.`);
}

async function handleStandards(req: Request, env: Env) {
  const url = new URL(req.url);
  if (!env.ADMIN_TOKEN || url.searchParams.get("token") !== env.ADMIN_TOKEN) {
    return err("unauthorized", 401);
  }
  if (req.method === "GET") {
    const rec = await getStandards(env);
    return json(rec ?? { text: "", updated_at: null });
  }
  if (req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { text?: string };
    if (!body.text) return err("Missing {text}", 400);
    const rec = await setStandards(env, body.text);
    return json(rec, 201);
  }
  return err("Method not allowed", 405);
}

// --------- Router ---------
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const { pathname } = new URL(req.url);
      if (pathname === "/health") return ok("ok");
      if (pathname === "/webhooks/sentry") return handleSentry(req, env);
      if (pathname === "/webhooks/clickup") return handleClickUp(req, env);
      if (pathname === "/admin/standards") return handleStandards(req, env);
      return ok("Worker is running");
    } catch (e: any) {
      console.error("Unhandled error:", e?.message || e);
      return err("Internal error", 500);
    }
  },
};
