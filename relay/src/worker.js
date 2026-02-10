/**
 * Agent Dashboard Cloud Relay — Cloudflare Worker
 *
 * This worker acts as a simple relay between:
 *   1. Your VS Code extension (pushes state via POST /api/state)
 *   2. Your iOS app (pulls state via GET /api/state)
 *
 * State is stored in-memory (per-isolate) for speed, with optional KV backup.
 * Free tier: 100,000 requests/day, which is plenty for polling every 3 seconds.
 *
 * Setup:
 *   1. npm install -g wrangler
 *   2. wrangler login
 *   3. wrangler deploy
 *   4. Copy the worker URL and paste it in:
 *      - VS Code: agentDashboard.cloudRelayUrl setting
 *      - iOS app: Settings > Cloud Relay URL
 */

// In-memory state (resets when isolate recycles, ~every few minutes)
let cachedState = null;
let lastUpdated = null;

// In-memory conversation cache: agentId → { turns, updatedAt }
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

    // ─── POST /api/state — VS Code extension pushes state here ─────────
    if (path === '/api/state' && request.method === 'POST') {
      // Verify auth token
      const authHeader = request.headers.get('Authorization');
      const expectedToken = env.AUTH_TOKEN || 'change-me-to-a-random-secret';

      if (authHeader !== `Bearer ${expectedToken}`) {
        return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
      }

      try {
        const body = await request.json();
        cachedState = body;
        lastUpdated = new Date().toISOString();

        // Optional: persist to KV for durability across isolate restarts
        if (env.DASHBOARD_STATE) {
          await env.DASHBOARD_STATE.put('current', JSON.stringify({
            state: body,
            updatedAt: lastUpdated,
          }));
        }

        return jsonResponse({ ok: true, updatedAt: lastUpdated }, 200, corsHeaders);
      } catch (err) {
        return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);
      }
    }

    // ─── GET /api/state — iOS app pulls state from here ────────────────
    if (path === '/api/state' && request.method === 'GET') {
      // Try in-memory first
      if (cachedState) {
        return jsonResponse({
          ...cachedState,
          _relay: { updatedAt: lastUpdated, source: 'memory' }
        }, 200, corsHeaders);
      }

      // Fall back to KV
      if (env.DASHBOARD_STATE) {
        const stored = await env.DASHBOARD_STATE.get('current');
        if (stored) {
          const parsed = JSON.parse(stored);
          cachedState = parsed.state;
          lastUpdated = parsed.updatedAt;
          return jsonResponse({
            ...parsed.state,
            _relay: { updatedAt: parsed.updatedAt, source: 'kv' }
          }, 200, corsHeaders);
        }
      }

      // No state yet
      return jsonResponse({
        agents: [],
        activities: [],
        stats: { total: 0, active: 0, completed: 0, tokens: 0, estimatedCost: 0, avgDuration: '—' },
        dataSourceHealth: [],
        _relay: { updatedAt: null, source: 'empty' }
      }, 200, corsHeaders);
    }

    // ─── POST /api/conversations — VS Code pushes conversation data ────
    if (path === '/api/conversations' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      const expectedToken = env.AUTH_TOKEN || 'change-me-to-a-random-secret';

      if (authHeader !== `Bearer ${expectedToken}`) {
        return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
      }

      try {
        const body = await request.json();
        // body: { agentId: string, turns: ConversationTurn[] }
        const { agentId, turns } = body;
        if (!agentId) {
          return jsonResponse({ error: 'Missing agentId' }, 400, corsHeaders);
        }

        conversationCache.set(agentId, {
          turns: turns || [],
          updatedAt: new Date().toISOString(),
        });

        // Persist to KV if available
        if (env.DASHBOARD_STATE) {
          await env.DASHBOARD_STATE.put(`convo:${agentId}`, JSON.stringify({
            turns: turns || [],
            updatedAt: new Date().toISOString(),
          }));
        }

        return jsonResponse({ ok: true, agentId, turnCount: (turns || []).length }, 200, corsHeaders);
      } catch (err) {
        return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);
      }
    }

    // ─── GET /api/agents/:id/conversation — iOS fetches conversation ───
    const convoMatch = path.match(/^\/api\/agents\/([^/]+)\/conversation\/?$/);
    if (convoMatch && request.method === 'GET') {
      const agentId = decodeURIComponent(convoMatch[1]);

      // Try in-memory first
      const cached = conversationCache.get(agentId);
      if (cached) {
        return jsonResponse({ agentId, turns: cached.turns }, 200, corsHeaders);
      }

      // Fall back to KV
      if (env.DASHBOARD_STATE) {
        const stored = await env.DASHBOARD_STATE.get(`convo:${agentId}`);
        if (stored) {
          const parsed = JSON.parse(stored);
          conversationCache.set(agentId, parsed);
          return jsonResponse({ agentId, turns: parsed.turns }, 200, corsHeaders);
        }
      }

      // No conversation found — return empty (not 404, to match extension behavior)
      return jsonResponse({ agentId, turns: [] }, 200, corsHeaders);
    }

    // ─── GET /api/health — health check ────────────────────────────────
    if (path === '/api/health') {
      return jsonResponse({
        status: 'ok',
        version: '0.4.0',
        relay: true,
        hasState: cachedState !== null,
        conversationsCached: conversationCache.size,
        lastUpdated,
      }, 200, corsHeaders);
    }

    // ─── 404 ───────────────────────────────────────────────────────────
    return jsonResponse({
      error: 'Not found',
      endpoints: [
        'GET  /api/state  — fetch latest dashboard state',
        'POST /api/state  — push dashboard state (requires Bearer token)',
        'GET  /api/agents/:id/conversation — fetch conversation history',
        'POST /api/conversations — push conversation data (requires Bearer token)',
        'GET  /api/health — health check',
      ]
    }, 404, corsHeaders);
  },
};

function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}
