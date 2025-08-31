// Add a minimal KVNamespace type for compatibility
interface KVNamespace {
  get(key: string, type?: "text" | "json" | "arrayBuffer" | "stream"): Promise<any>;
  put(key: string, value: string, options?: { expiration?: number; expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Env {
  STATE: KVNamespace;             // KV: groupKey → { issue_number, count, first_seen }
  GITHUB_TOKEN: string;           // GitHub PAT or App installation token
  GITHUB_REPO: string;            // "owner/repo"
  SENTRY_SHARED_TOKEN?: string;   // optional shared token (?token=...)
}

type AnyJson = Record<string, any>;

export default {
  async fetch(req: Request, env: Env) {
    const { pathname, searchParams } = new URL(req.url);

    // Optional shared token guard
    const authed = env.SENTRY_SHARED_TOKEN
      ? searchParams.get("token") === env.SENTRY_SHARED_TOKEN
      : true;
    if (!authed) return new Response("unauthorized", { status: 401 });

    // Only handle POST to /webhooks/sentry
    if (req.method !== "POST" || pathname !== "/webhooks/sentry") {
      return new Response("Worker is running");
    }

    // Parse Sentry payload
    const payload = (await req.json().catch(() => ({}))) as AnyJson;

    // Ignore tiny “integration test” pings (no issue info)
    if (Object.keys(payload).length <= 2 && !payload.issue && !payload.event && !payload.data) {
      console.log("Received test ping, ignoring.");
      return new Response("ok");
    }

    // --- Defensive config checks ---
    if (!env.GITHUB_REPO) return new Response("Missing GITHUB_REPO", { status: 500 });
    if (!env.GITHUB_TOKEN) return new Response("Missing GITHUB_TOKEN", { status: 500 });
    if (!env.STATE) return new Response("Missing KV binding STATE", { status: 500 });

    const [owner, repo] = env.GITHUB_REPO.split("/");
    if (!owner || !repo) return new Response("GITHUB_REPO must be 'owner/repo'", { status: 500 });

    // --- Normalize Sentry fields across payload shapes ---
    const issueObj = payload.issue ?? payload.data?.issue ?? payload.event?.issue ?? null;
    const eventObj = payload.event ?? payload.data?.event ?? null;

    const projectSlug =
      payload.project_slug ||
      payload.project?.slug ||
      payload.project ||
      payload.data?.issue?.project?.slug ||
      "unknown";

    const environment =
      payload.environment ||
      eventObj?.environment ||
      (Array.isArray(eventObj?.tags)
        ? (eventObj.tags.find((t: any) => t?.key === "environment")?.value as string)
        : undefined) ||
      "unknown";

    const sentryIssueId =
      issueObj?.id ||
      payload.issue_id ||
      payload.data?.issue?.id ||
      null;

    const title =
      issueObj?.title ||
      eventObj?.title ||
      payload.title ||
      "Unhandled error";

    const permalink =
      issueObj?.permalink ||
      payload.url ||
      payload.issue_url ||
      "(no Sentry link)";

    // stack frames (best-effort)
    const framesList =
      eventObj?.exception?.values?.[0]?.stacktrace?.frames ||
      payload?.exception?.values?.[0]?.stacktrace?.frames ||
      [];
    const frames = (framesList as any[])
      .slice(-4)
      .reverse()
      .map((f) => {
        const file = [f.module, f.filename].filter(Boolean).join("/");
        const line = f.lineno ? `:${f.lineno}` : "";
        const fn = f.function ? ` – ${f.function}` : "";
        return `- \`${file}${line}\`${fn}`;
      });
    const framesBlock = frames.length
      ? `<details><summary>Top frames</summary>\n\n${frames.join("\n")}\n\n</details>\n`
      : "";

    const levelLine =
      payload.level || eventObj?.level ? `**Level:** ${payload.level || eventObj?.level}` : "";
    const culpritLine =
      issueObj?.culprit ? `**Culprit:** \`${issueObj.culprit}\`` : "";

    if (!sentryIssueId) {
      console.log("Skipping — no Sentry issue id present.");
      return new Response("ok (no issue id)");
    }

    const groupKey = `${projectSlug}:${environment}:${sentryIssueId}`;

    // --- Load state from KV ---
    type State = { issue_number: number; count: number; first_seen: string };
    const state = (await env.STATE.get(groupKey, "json")) as State | null;

    const nowIso = new Date().toISOString();

    // GitHub headers (User-Agent required)
    const GH_HEADERS = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "sentry-clickup-github-worker/1.0",
      "X-GitHub-Api-Version": "2022-11-28"
    };

    // Build body with dynamic status
    const buildBody = (occurrences: number, firstSeen: string, lastSeen: string) =>
      [
        "## 📝 Summary",
        `New or repeated Sentry alert detected.`,
        "",
        "## 🔗 Links",
        `- **Sentry Issue:** ${permalink}`,
        "",
        "## 🔍 Key Details",
        `**Project:** ${projectSlug}`,
        levelLine,
        culpritLine,
        framesBlock,
        "",
        "## 📊 Status",
        `**Occurrences:** ${occurrences}  `,
        `**First seen:** ${firstSeen}  `,
        `**Last seen:** ${lastSeen}`,
        "",
        "> Raw payload omitted. Inspect in Sentry for full context."
      ]
        .filter(Boolean)
        .join("\n");

    // Create on first occurrence
    if (!state) {
      const createBody = buildBody(1, nowIso, nowIso);
      const createRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        method: "POST",
        headers: GH_HEADERS,
        body: JSON.stringify({
          title: `[Sentry][${environment}] ${title}`,
          body: createBody,
          labels: ["sentry", environment].filter(Boolean)
        })
      });
      if (!createRes.ok) {
        const text = await createRes.text();
        console.error("GitHub create failed", createRes.status, text);
        return new Response(`GitHub issue create failed: ${createRes.status} ${text}`, { status: 502 });
      }
      const created = (await createRes.json()) as { number: number };
      await env.STATE.put(
        groupKey,
        JSON.stringify({ issue_number: created.number, count: 1, first_seen: nowIso }),
        { expirationTtl: 60 * 60 * 24 * 90 }
      );
      console.log(`Created issue #${created.number} for ${groupKey}`);
      return new Response(`Created issue #${created.number}`, { status: 201 });
    }

    // Update on repeats
    const newCount = (state.count || 1) + 1;

    // Get current body to preserve edits
    const issueRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${state.issue_number}`, {
      method: "GET",
      headers: GH_HEADERS
    });
    if (!issueRes.ok) {
      const text = await issueRes.text();
      console.error("GitHub get failed", issueRes.status, text);
      return new Response(`GitHub get issue failed: ${issueRes.status} ${text}`, { status: 502 });
    }
    const issue = (await issueRes.json()) as { body: string };

    const statusRegex = /## 📊 Status[\s\S]*?(?:\n## |\n> |\n?$)/m;
    const newStatusBlock =
      [
        "## 📊 Status",
        `**Occurrences:** ${newCount}  `,
        `**First seen:** ${state.first_seen}  `,
        `**Last seen:** ${nowIso}`,
        ""
      ].join("\n");

    const updatedBody = statusRegex.test(issue.body || "")
      ? (issue.body || "").replace(statusRegex, (match) => {
          const trailing = match.match(/(\n## |\n> |\n?$)/m)?.[1] ?? "\n";
          return newStatusBlock + trailing;
        })
      : buildBody(newCount, state.first_seen, nowIso);

    const patchRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${state.issue_number}`,
      {
        method: "PATCH",
        headers: GH_HEADERS,
        body: JSON.stringify({ body: updatedBody })
      }
    );
    if (!patchRes.ok) {
      const text = await patchRes.text();
      console.error("GitHub patch failed", patchRes.status, text);
      return new Response(`GitHub patch failed: ${patchRes.status} ${text}`, { status: 502 });
    }

    await env.STATE.put(
      groupKey,
      JSON.stringify({ ...state, count: newCount }),
      { expirationTtl: 60 * 60 * 24 * 90 }
    );

    console.log(`Updated issue #${state.issue_number} (occurrences=${newCount}) for ${groupKey}`);
    return new Response(`Updated issue #${state.issue_number} (occurrences=${newCount})`);
  }
};
