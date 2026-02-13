/**
 * Agent Dashboard Cloud Relay — Cloudflare Worker
 *
 * This worker acts as a relay between:
 *   1. Your VS Code extension(s) (push state via POST /api/state)
 *   2. Your iOS app (pulls state via GET /api/state)
 *
 * Supports multiple VS Code instances pushing simultaneously. Each instance
 * is identified by its instanceId and stored separately. GET /api/state
 * returns an aggregated view of all live instances.
 *
 * Storage:
 *   - In-memory cache (per-isolate) for fast single-instance reads
 *   - KV (DASHBOARD_STATE binding) for multi-instance persistence
 *   - KV is REQUIRED for multi-instance; without it, only single-instance works
 *
 * KV Key Scheme:
 *   instance:{instanceId}     → { state, meta, updatedAt }  (TTL: 120s)
 *   instance-index            → { instances: string[] }
 *   convo:{instanceId}:{id}   → { turns, updatedAt }
 *   current                   → legacy single-instance key (backward compat)
 *
 * Setup:
 *   1. npm install -g wrangler
 *   2. wrangler login
 *   3. npx wrangler kv namespace create DASHBOARD_STATE
 *   4. Update wrangler.toml with the KV namespace ID
 *   5. wrangler deploy
 *   6. Copy the worker URL into VS Code + iOS app settings
 */

// In-memory state (resets when isolate recycles, ~every few minutes)
let cachedState = null;
let lastUpdated = null;

// In-memory conversation cache: compositeKey → { turns, updatedAt }
const conversationCache = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ─── Auth helper ─────────────────────────────────────────────────
    function checkAuth() {
      const authHeader = request.headers.get('Authorization');
      const expectedToken = env.AUTH_TOKEN || 'change-me-to-a-random-secret';
      return authHeader === `Bearer ${expectedToken}`;
    }

    // ─── POST /api/state — VS Code extension pushes state here ─────────
    if (path === '/api/state' && request.method === 'POST') {
      if (!checkAuth()) {
        return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
      }

      try {
        const body = await request.json();
        const instanceId = body._instanceMeta?.instanceId || 'default';
        const now = new Date().toISOString();

        // Always update in-memory cache (backward compat / single-instance fast path)
        cachedState = body;
        lastUpdated = now;

        // Store per-instance in KV for multi-instance aggregation
        if (env.DASHBOARD_STATE) {
          const entry = {
            state: body,
            meta: {
              ...(body._instanceMeta || {}),
              pushedAt: now,
            },
            updatedAt: now,
          };
          await env.DASHBOARD_STATE.put(
            `instance:${instanceId}`,
            JSON.stringify(entry),
            { expirationTtl: 120 }
          );

          // Update instance index
          await updateInstanceIndex(env, instanceId);

          // Also write legacy 'current' key for backward compat
          await env.DASHBOARD_STATE.put('current', JSON.stringify({
            state: body,
            updatedAt: now,
          }));
        }

        return jsonResponse({ ok: true, instanceId, updatedAt: now }, 200, corsHeaders);
      } catch (err) {
        return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);
      }
    }

    // ─── GET /api/state — iOS app pulls aggregated state ─────────────
    if (path === '/api/state' && request.method === 'GET') {
      // If KV is available, try multi-instance aggregation
      if (env.DASHBOARD_STATE) {
        const aggregated = await aggregateInstances(env);
        if (aggregated) {
          return jsonResponse({
            ...aggregated.state,
            _relay: {
              updatedAt: new Date().toISOString(),
              source: 'aggregated',
              instanceCount: aggregated.instanceCount,
            },
          }, 200, corsHeaders);
        }

        // Fall back to legacy 'current' key
        const stored = await env.DASHBOARD_STATE.get('current');
        if (stored) {
          const parsed = JSON.parse(stored);
          cachedState = parsed.state;
          lastUpdated = parsed.updatedAt;
          return jsonResponse({
            ...parsed.state,
            _relay: { updatedAt: parsed.updatedAt, source: 'kv', instanceCount: 1 },
          }, 200, corsHeaders);
        }
      }

      // Fall back to in-memory (no KV, single-instance mode)
      if (cachedState) {
        return jsonResponse({
          ...cachedState,
          _relay: { updatedAt: lastUpdated, source: 'memory', instanceCount: 1 },
        }, 200, corsHeaders);
      }

      // No state yet
      return jsonResponse({
        agents: [],
        activities: [],
        stats: { total: 0, active: 0, completed: 0, tokens: 0, estimatedCost: 0, avgDuration: '—' },
        dataSourceHealth: [],
        _relay: { updatedAt: null, source: 'empty', instanceCount: 0 },
      }, 200, corsHeaders);
    }

    // ─── POST /api/conversations — VS Code pushes conversation data ────
    if (path === '/api/conversations' && request.method === 'POST') {
      if (!checkAuth()) {
        return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
      }

      try {
        const body = await request.json();
        const { agentId, turns, instanceId } = body;
        if (!agentId) {
          return jsonResponse({ error: 'Missing agentId' }, 400, corsHeaders);
        }

        const instId = instanceId || 'default';
        const cacheKey = `${instId}:${agentId}`;

        conversationCache.set(cacheKey, {
          turns: turns || [],
          updatedAt: new Date().toISOString(),
        });

        // Also keep legacy key for backward compat
        conversationCache.set(agentId, {
          turns: turns || [],
          updatedAt: new Date().toISOString(),
        });

        if (env.DASHBOARD_STATE) {
          const convoData = JSON.stringify({
            turns: turns || [],
            updatedAt: new Date().toISOString(),
          });
          await env.DASHBOARD_STATE.put(`convo:${instId}:${agentId}`, convoData);
          // Legacy key
          await env.DASHBOARD_STATE.put(`convo:${agentId}`, convoData);
        }

        return jsonResponse({ ok: true, agentId, instanceId: instId, turnCount: (turns || []).length }, 200, corsHeaders);
      } catch (err) {
        return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);
      }
    }

    // ─── GET /api/agents/:id/conversation — iOS fetches conversation ───
    const convoMatch = path.match(/^\/api\/agents\/([^/]+)\/conversation\/?$/);
    if (convoMatch && request.method === 'GET') {
      const rawId = decodeURIComponent(convoMatch[1]);

      // Parse namespaced ID: "instanceId::agentId" or plain "agentId"
      let instanceId = 'default';
      let agentId = rawId;
      if (rawId.includes('::')) {
        const sepIdx = rawId.indexOf('::');
        instanceId = rawId.substring(0, sepIdx);
        agentId = rawId.substring(sepIdx + 2);
      }

      const cacheKey = `${instanceId}:${agentId}`;

      // Try in-memory (namespaced key)
      const cached = conversationCache.get(cacheKey);
      if (cached) {
        return jsonResponse({ agentId: rawId, turns: cached.turns }, 200, corsHeaders);
      }

      // Try KV (namespaced key)
      if (env.DASHBOARD_STATE) {
        const stored = await env.DASHBOARD_STATE.get(`convo:${instanceId}:${agentId}`);
        if (stored) {
          const parsed = JSON.parse(stored);
          conversationCache.set(cacheKey, parsed);
          return jsonResponse({ agentId: rawId, turns: parsed.turns }, 200, corsHeaders);
        }

        // Backward compat: try legacy key (no instance prefix)
        const legacy = await env.DASHBOARD_STATE.get(`convo:${agentId}`);
        if (legacy) {
          const parsed = JSON.parse(legacy);
          return jsonResponse({ agentId: rawId, turns: parsed.turns }, 200, corsHeaders);
        }
      }

      // Try in-memory legacy key
      const legacyCached = conversationCache.get(agentId);
      if (legacyCached) {
        return jsonResponse({ agentId: rawId, turns: legacyCached.turns }, 200, corsHeaders);
      }

      return jsonResponse({ agentId: rawId, turns: [] }, 200, corsHeaders);
    }

    // ─── GET /api/instances — list connected instances ────────────────
    if (path === '/api/instances' && request.method === 'GET') {
      if (!env.DASHBOARD_STATE) {
        return jsonResponse({ instances: [] }, 200, corsHeaders);
      }

      const indexRaw = await env.DASHBOARD_STATE.get('instance-index');
      if (!indexRaw) {
        return jsonResponse({ instances: [] }, 200, corsHeaders);
      }

      const { instances: ids } = JSON.parse(indexRaw);
      const result = [];
      for (const id of (ids || [])) {
        const raw = await env.DASHBOARD_STATE.get(`instance:${id}`, { cacheTtl: 5 });
        if (!raw) { continue; }
        const entry = JSON.parse(raw);
        result.push({
          instanceId: id,
          hostname: entry.meta?.hostname,
          workspace: entry.meta?.workspace,
          username: entry.meta?.username,
          agentCount: entry.state?.agents?.length || 0,
          updatedAt: entry.updatedAt,
          ageMs: Date.now() - new Date(entry.updatedAt).getTime(),
        });
      }

      return jsonResponse({ instances: result }, 200, corsHeaders);
    }

    // ─── GET /api/health — health check ────────────────────────────────
    if (path === '/api/health') {
      let instanceInfo = {};
      if (env.DASHBOARD_STATE) {
        const indexRaw = await env.DASHBOARD_STATE.get('instance-index');
        if (indexRaw) {
          const { instances } = JSON.parse(indexRaw);
          instanceInfo = { registeredInstances: instances?.length || 0 };
        }
      }
      return jsonResponse({
        status: 'ok',
        version: '0.5.0',
        relay: true,
        multiInstance: true,
        hasState: cachedState !== null,
        conversationsCached: conversationCache.size,
        lastUpdated,
        ...instanceInfo,
      }, 200, corsHeaders);
    }

    // ─── 404 ───────────────────────────────────────────────────────────
    return jsonResponse({
      error: 'Not found',
      endpoints: [
        'GET  /api/state  — fetch aggregated dashboard state from all instances',
        'POST /api/state  — push dashboard state (requires Bearer token)',
        'GET  /api/agents/:id/conversation — fetch conversation history',
        'POST /api/conversations — push conversation data (requires Bearer token)',
        'GET  /api/instances — list connected instances',
        'GET  /api/health — health check',
      ],
    }, 404, corsHeaders);
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

/**
 * Add an instanceId to the instance index if not already present.
 */
async function updateInstanceIndex(env, instanceId) {
  const raw = await env.DASHBOARD_STATE.get('instance-index');
  let index = raw ? JSON.parse(raw) : { instances: [] };
  if (!index.instances.includes(instanceId)) {
    index.instances.push(instanceId);
    await env.DASHBOARD_STATE.put('instance-index', JSON.stringify(index));
  }
}

/**
 * Aggregate state from all live instances into a single DashboardState.
 * Returns null if no instances are found.
 */
async function aggregateInstances(env) {
  const indexRaw = await env.DASHBOARD_STATE.get('instance-index');
  if (!indexRaw) { return null; }

  const { instances: instanceIds } = JSON.parse(indexRaw);
  if (!instanceIds || instanceIds.length === 0) { return null; }

  const now = Date.now();
  const STALE_MS = 60_000;
  const allAgents = [];
  const allActivities = [];
  const allHealth = [];
  const liveIds = [];

  for (const id of instanceIds) {
    const raw = await env.DASHBOARD_STATE.get(`instance:${id}`, { cacheTtl: 5 });
    if (!raw) { continue; }

    const entry = JSON.parse(raw);
    const age = now - new Date(entry.updatedAt).getTime();
    if (age > STALE_MS) { continue; }

    liveIds.push(id);
    const state = entry.state || {};
    const meta = entry.meta || {};
    const label = meta.hostname
      ? `${meta.hostname}${meta.workspace ? ' (' + meta.workspace + ')' : ''}`
      : meta.workspace || id.substring(0, 8);

    // Namespace agents
    for (const agent of (state.agents || [])) {
      allAgents.push({
        ...agent,
        id: `${id}::${agent.id}`,
        remoteHost: agent.remoteHost || label,
        location: agent.location === 'local' ? 'cloud' : agent.location,
        workspace: agent.workspace || meta.workspace || '',
      });
    }

    // Tag activities
    for (const activity of (state.activities || [])) {
      allActivities.push({
        ...activity,
        agent: liveIds.length > 1 ? `[${label}] ${activity.agent}` : activity.agent,
      });
    }

    // Merge health sources
    for (const h of (state.dataSourceHealth || [])) {
      allHealth.push({
        ...h,
        id: `${id}::${h.id}`,
        name: liveIds.length > 1 ? `${h.name} (${label})` : h.name,
      });
    }
  }

  if (liveIds.length === 0) { return null; }

  // Single-instance backward compat: if only 'default', return raw (no namespacing)
  if (liveIds.length === 1 && liveIds[0] === 'default') {
    const raw = await env.DASHBOARD_STATE.get('instance:default', { cacheTtl: 5 });
    if (raw) {
      const entry = JSON.parse(raw);
      return { state: entry.state, instanceCount: 1 };
    }
  }

  // Sort activities by timestamp descending
  allActivities.sort((a, b) => b.timestamp - a.timestamp);

  // Compute aggregate stats
  const active = allAgents.filter(a => a.status === 'running' || a.status === 'thinking' || a.status === 'paused');
  const completed = allAgents.filter(a => a.status === 'done');
  const totalTokens = allAgents.reduce((s, a) => s + (a.tokens || 0), 0);
  const totalCost = allAgents.reduce((s, a) => s + (a.estimatedCost || 0), 0);

  // Prune stale IDs from index
  if (liveIds.length !== instanceIds.length) {
    await env.DASHBOARD_STATE.put('instance-index', JSON.stringify({ instances: liveIds }));
  }

  return {
    state: {
      agents: allAgents,
      activities: allActivities.slice(0, 100),
      stats: {
        total: allAgents.length,
        active: active.length,
        completed: completed.length,
        tokens: totalTokens,
        estimatedCost: totalCost,
        avgDuration: '—',
      },
      dataSourceHealth: allHealth,
    },
    instanceCount: liveIds.length,
  };
}
