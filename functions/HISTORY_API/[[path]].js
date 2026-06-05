// 统一的 CORS 头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  // params.path 是一个数组，包含剩余的路径部分
  // 例如 /HISTORY_API/history/test -> params.path = ['test']
  //     /HISTORY_API/history/clear -> ['clear']
  //     /HISTORY_API/history/5 -> ['5']
  //     /HISTORY_API/history -> params.path = undefined 或 []
  const pathSegments = params.path || [];
  const subPath = pathSegments.length > 0 ? pathSegments[0] : null;
 // 🧪 临时调试：返回实际收到的 subPath 和原始路径
  if (request.method === 'GET' && url.pathname.startsWith('/HISTORY_API/history/test')) {
    return new Response(`Debug: subPath="${subPath}", fullPath="${url.pathname}"`, { status: 200 });
  }
  // 处理 OPTIONS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // ---------- 测试路由 ----------
  if (request.method === 'GET' && subPath === 'test') {
    return new Response('Hello from Pages Functions!', { status: 200 });
  }

  // ---------- DELETE /history/clear ----------
  if (request.method === 'DELETE' && subPath === 'clear') {
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

  // ---------- DELETE /history/:id ----------
  if (request.method === 'DELETE' && subPath && /^\d+$/.test(subPath)) {
    const id = parseInt(subPath, 10);
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

  // ---------- GET /history ---------- (根路径)
  if (request.method === 'GET' && !subPath) {
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

  // ---------- POST /history ---------- (根路径)
  if (request.method === 'POST' && !subPath) {
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

  // 未匹配
  return new Response('Not Found', { status: 404, headers: corsHeaders });
}
