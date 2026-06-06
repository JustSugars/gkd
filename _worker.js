// _worker.js - 支持管理员模式、操作密钥、历史记录共享
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Expires',
};

// 默认值
const DEFAULT_OP_PASSWORD = '0000';
const DEFAULT_ADMIN_PREFIX = 'Admin';

// 获取当前动态管理员密钥（完整）
function getDynamicAdminKey(env, prefix) {
  // 如果未传入 prefix，则从 KV 读取，但为了性能，调用前应确保已读取
  const now = new Date();
  // 转换为北京时间 UTC+8
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const day = beijingTime.getUTCDate();
  const hour = beijingTime.getUTCHours();
  return `${prefix}${day}${hour}`;
}

// 验证管理员 token（无状态，基于前缀+动态密钥+过期时间）
async function verifyAdminToken(token, expires, env) {
  if (!token || !expires) return false;
  const now = Date.now();
  if (now > parseInt(expires)) return false;
  const prefix = await env.HISTORY_KV.get('admin_key_prefix') || DEFAULT_ADMIN_PREFIX;
  const dynamicKey = getDynamicAdminKey(env, prefix);
  const data = `${dynamicKey}|${expires}`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const expectedToken = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return token === expectedToken;
}

// 初始化 KV 默认值（如果不存在）
async function initializeKV(env) {
  const opPass = await env.HISTORY_KV.get('operation_password');
  if (opPass === null) {
    await env.HISTORY_KV.put('operation_password', DEFAULT_OP_PASSWORD);
  }
  const prefix = await env.HISTORY_KV.get('admin_key_prefix');
  if (prefix === null) {
    await env.HISTORY_KV.put('admin_key_prefix', DEFAULT_ADMIN_PREFIX);
  }
  const history = await env.HISTORY_KV.get('history', 'json');
  if (history === null) {
    await env.HISTORY_KV.put('history', JSON.stringify([]));
  }
}

export default {
  async fetch(request, env) {
    await initializeKV(env); // 确保默认值存在

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 公共接口：获取 GitHub 更新记录
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

    // 获取 IP 信息（不变）
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

    // 历史记录 API（共享，无需用户ID）
    if (request.method === 'GET' && path === '/HISTORY_API/history') {
      try {
        const history = await env.HISTORY_KV.get('history', 'json');
        return new Response(JSON.stringify(history || []), {
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

    // 清空所有历史记录（需要管理员 token）
    if (request.method === 'DELETE' && path === '/HISTORY_API/history/clear') {
      const adminToken = request.headers.get('X-Admin-Token');
      const expires = request.headers.get('X-Admin-Expires');
      const isValid = await verifyAdminToken(adminToken, expires, env);
      if (!isValid) {
        return new Response(JSON.stringify({ error: 'Invalid or expired admin token' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
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

    // 删除单条记录（无需 token，但前端已有操作密钥验证）
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

    // 管理员登录验证
    if (request.method === 'POST' && path === '/HISTORY_API/admin/verify') {
      try {
        const { key } = await request.json();
        const prefix = await env.HISTORY_KV.get('admin_key_prefix') || DEFAULT_ADMIN_PREFIX;
        const expectedKey = getDynamicAdminKey(env, prefix);
        if (key === expectedKey) {
          const expires = Date.now() + 10 * 60 * 1000;
          const data = `${expectedKey}|${expires}`;
          const encoder = new TextEncoder();
          const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const token = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
          return new Response(JSON.stringify({ success: true, token, expires }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        } else {
          return new Response(JSON.stringify({ success: false }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // 修改密钥（操作密钥或管理员前缀）
    if (request.method === 'POST' && path === '/HISTORY_API/admin/change-key') {
      const adminToken = request.headers.get('X-Admin-Token');
      const expires = request.headers.get('X-Admin-Expires');
      const isValid = await verifyAdminToken(adminToken, expires, env);
      if (!isValid) {
        return new Response(JSON.stringify({ error: 'Invalid or expired admin token' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      try {
        const { type, newValue } = await request.json();
        if (type === 'operation_password') {
          if (!/^\d{4}$/.test(newValue)) {
            return new Response(JSON.stringify({ error: '操作密钥必须为4位数字' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          await env.HISTORY_KV.put('operation_password', newValue);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        } else if (type === 'admin_prefix') {
          if (!/^[A-Za-z]{1,10}$/.test(newValue)) {
            return new Response(JSON.stringify({ error: '管理员前缀必须是1-10位英文字母' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          await env.HISTORY_KV.put('admin_key_prefix', newValue);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        } else {
          return new Response(JSON.stringify({ error: 'Invalid type' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // 操作密钥验证（单条删除时）
    if (request.method === 'POST' && path === '/HISTORY_API/verify-password') {
      try {
        const { password } = await request.json();
        const stored = await env.HISTORY_KV.get('operation_password') || DEFAULT_OP_PASSWORD;
        const isValid = (password === stored);
        return new Response(JSON.stringify({ success: isValid }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // 静态资源
    return env.ASSETS.fetch(request);
  }
};