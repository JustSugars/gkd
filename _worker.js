// _worker.js
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ---------- 新增：获取 GitHub 更新记录（分页） ----------
    if (request.method === 'GET' && path === '/HISTORY_API/updates') {
      try {
        const page = parseInt(url.searchParams.get('page')) || 1;
        const perPage = 10;
        const owner = 'JustSugars';
        const repo = 'gkd';
        const token = env.GITHUB_TOKEN || null; // 可选

        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=${perPage}&page=${page}&sha=main`;
        const headers = {
          'User-Agent': 'Cloudflare-Pages',
          'Accept': 'application/vnd.github.v3+json',
        };
        if (token) headers['Authorization'] = `token ${token}`;

        const response = await fetch(apiUrl, { headers });
        if (!response.ok) {
          throw new Error(`GitHub API error: ${response.status}`);
        }
        const commits = await response.json();

        const updates = commits.map(commit => ({
          sha: commit.sha.slice(0, 7),
          message: commit.commit.message.split('\n')[0],
          date: commit.commit.author.date,
          url: commit.html_url,
        }));

        const hasMore = commits.length === perPage;

        return new Response(JSON.stringify({ updates, hasMore }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // ---------- 历史记录 API（保持不变） ----------
    if (request.method === 'GET' && path === '/HISTORY_API/history') {
      try {
        const data = await env.HISTORY_KV.get('history', 'json');
        return new Response(JSON.stringify(data || []), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'KV read failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    if (request.method === 'POST' && path === '/HISTORY_API/history') {
      try {
        const newHistory = await request.json();
        if (!Array.isArray(newHistory)) {
          throw new Error('Data must be an array');
        }
        await env.HISTORY_KV.put('history', JSON.stringify(newHistory));
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Invalid data' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    if (request.method === 'DELETE' && path === '/HISTORY_API/history/clear') {
      try {
        await env.HISTORY_KV.put('history', JSON.stringify([]));
        return new Response(JSON.stringify({ success: true, cleared: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Clear failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    const deleteMatch = path.match(/^\/HISTORY_API\/history\/(\d+)$/);
    if (request.method === 'DELETE' && deleteMatch) {
      const id = parseInt(deleteMatch[1], 10);
      try {
        let history = await env.HISTORY_KV.get('history', 'json');
        if (!history) history = [];
        const newHistory = history.filter(item => item.id !== id);
        if (newHistory.length === history.length) {
          return new Response(JSON.stringify({ error: 'Record not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        await env.HISTORY_KV.put('history', JSON.stringify(newHistory));
        return new Response(JSON.stringify({ success: true, deletedId: id }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Delete failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // 未匹配的路由：交给静态资源
    return env.ASSETS.fetch(request);
  }
};