// _worker.js - 完整版
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

    // 获取 GitHub 更新记录
    if (request.method === 'GET' && path === '/HISTORY_API/updates') {
      try {
        const page = parseInt(url.searchParams.get('page')) || 1;
        const perPage = 10;
        const owner = 'JustSugars';
        const repo = 'gkd';
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=${perPage}&page=${page}&sha=main`;
        const response = await fetch(apiUrl, {
          headers: { 'User-Agent': 'Cloudflare-Pages' },
        });
        if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
        const commits = await response.json();
        const hasMore = commits.length === perPage;
        const updates = commits.map(commit => ({
          sha: commit.sha.slice(0, 7),
          message: commit.commit.message.split('\n')[0],
          date: commit.commit.author.date,
        }));
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

    // 获取客户端 IP 和运营商信息
    if (request.method === 'GET' && path === '/HISTORY_API/ipinfo') {
      try {
        const ip = request.headers.get('CF-Connecting-IP') || 
                   request.headers.get('X-Forwarded-For')?.split(',')[0] || 
                   '未知 IP';
        const isp = request.headers.get('CF-ISP') || '';
        const country = request.headers.get('CF-IPCountry') || '';
        let location = '';
        if (country) location += country;
        if (isp) location += (location ? ' ' : '') + isp;
        if (!location) location = '未知位置';
        return new Response(JSON.stringify({ ip, location }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // 历史记录 API
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
        if (!Array.isArray(newHistory)) throw new Error('Data must be an array');
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

    // 静态资源
    return env.ASSETS.fetch(request);
  }
};