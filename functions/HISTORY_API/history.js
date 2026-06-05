// 统一的 CORS 头（允许跨域，实际上同域请求可省略，但保留便于调试）
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * 处理所有 /HISTORY_API/history* 的请求
 * @param {Object} context - Pages Functions 上下文
 */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // 处理 OPTIONS 预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // ---------- 测试路由 ----------
  if (request.method === 'GET' && path === '/HISTORY_API/history/test') {
    return new Response('Hello from Pages Functions!', { status: 200 });
  }

  // ---------- GET /HISTORY_API/history ----------
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

  // ---------- POST /HISTORY_API/history ----------
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

  // ---------- DELETE /HISTORY_API/history/clear ----------
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

  // ---------- DELETE /HISTORY_API/history/:id ----------
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

  // 未匹配任何路由
  return new Response('Not Found', { status: 404, headers: corsHeaders });
}