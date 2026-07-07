// ============================================================
// _worker.js - 电费分摊 + 游戏存档同步（完整版）
// 使用两个 KV 绑定：HISTORY_KV（原有），GAME_KV（新增）
// ============================================================

// ---------- CORS 头 ----------
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Expires, Authorization',
};

// ---------- 原有默认值 ----------
const DEFAULT_OP_PASSWORD = '0000';
const DEFAULT_ADMIN_PREFIX = 'Admin';

// ---------- 原有辅助函数（管理员动态密钥等）----------
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

// ============================================================
// 新增：游戏同步相关辅助函数（使用 GAME_KV）
// ============================================================

// 生成随机 token（用于会话）
function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

// 对密码进行加盐哈希（使用 SHA-256）
async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 验证用户会话（从请求头获取 Authorization: Bearer <token>）
async function verifySession(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null; // 未提供 token
  }
  const token = authHeader.substring(7);
  // 从 GAME_KV 中查找用户，看是否匹配这个 token
  const users = await env.GAME_KV.get('game:users', 'json') || [];
  for (const username of users) {
    const userData = await env.GAME_KV.get(`game:user:${username}`, 'json');
    if (userData && userData.session_token === token) {
      // 检查是否过期
      if (Date.now() > userData.session_expires) {
        return null; // token 已过期
      }
      // 返回用户信息
      return { username, userData };
    }
  }
  return null; // 未找到匹配的 token
}

// ============================================================
// 主 fetch 处理
// ============================================================

export default {
  async fetch(request, env) {
    // 初始化原有 KV 默认值（不影响游戏相关）
    await initializeKV(env);

    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ------------------------------------------------------------
    // 原有：电费分摊相关 API（/HISTORY_API/*）
    // ------------------------------------------------------------

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

    // 获取 IP 信息
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

    // ============================================================
    // 新增：游戏同步 API（/GAME_API/*），使用 GAME_KV
    // ============================================================

    // ---------- 注册 ----------
    if (request.method === 'POST' && path === '/GAME_API/auth/register') {
      try {
        const { username, password } = await request.json();
        // 校验用户名和密码
        if (!username || !password) {
          return new Response(JSON.stringify({ success: false, message: '用户名和密码不能为空' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        if (username.length < 3 || username.length > 20 || !/^[a-zA-Z0-9_]+$/.test(username)) {
          return new Response(JSON.stringify({ success: false, message: '用户名必须为3-20位字母数字下划线' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        if (password.length < 6) {
          return new Response(JSON.stringify({ success: false, message: '密码长度至少6位' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // 检查用户名是否已存在
        const users = await env.GAME_KV.get('game:users', 'json') || [];
        if (users.includes(username)) {
          return new Response(JSON.stringify({ success: false, message: '用户名已被注册' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // 生成盐值并哈希密码
        const salt = Math.random().toString(36).substring(2, 10);
        const passwordHash = await hashPassword(password, salt);

        // 保存用户信息（初始无 session）
        const userData = {
          username,
          password_hash: passwordHash,
          salt,
          session_token: null,
          session_expires: 0,
          created_at: Date.now()
        };
        await env.GAME_KV.put(`game:user:${username}`, JSON.stringify(userData));
        // 更新用户列表
        users.push(username);
        await env.GAME_KV.put('game:users', JSON.stringify(users));

        return new Response(JSON.stringify({ success: true, message: '注册成功' }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // ---------- 登录（互斥登录） ----------
    if (request.method === 'POST' && path === '/GAME_API/auth/login') {
      try {
        const { username, password } = await request.json();
        if (!username || !password) {
          return new Response(JSON.stringify({ success: false, message: '用户名和密码不能为空' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // 获取用户信息
        const userData = await env.GAME_KV.get(`game:user:${username}`, 'json');
        if (!userData) {
          return new Response(JSON.stringify({ success: false, message: '用户名或密码错误' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // 验证密码
        const hashedInput = await hashPassword(password, userData.salt);
        if (hashedInput !== userData.password_hash) {
          return new Response(JSON.stringify({ success: false, message: '用户名或密码错误' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // 生成新 token（同时使旧 token 失效）
        const newToken = generateToken();
        const expires = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7天有效期
        userData.session_token = newToken;
        userData.session_expires = expires;
        userData.last_login_time = Date.now();
        // 可记录登录 IP（从 request 获取，可选）
        await env.GAME_KV.put(`game:user:${username}`, JSON.stringify(userData));

        return new Response(JSON.stringify({
          success: true,
          token: newToken,
          expires: expires,
          username: username
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // ---------- 验证 token ----------
    if (request.method === 'GET' && path === '/GAME_API/auth/verify') {
      const session = await verifySession(request, env);
      if (session) {
        return new Response(JSON.stringify({ valid: true, username: session.username }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } else {
        return new Response(JSON.stringify({ valid: false }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // ---------- 登出 ----------
    if (request.method === 'POST' && path === '/GAME_API/auth/logout') {
      const session = await verifySession(request, env);
      if (session) {
        // 清除该用户的 session_token
        const userData = session.userData;
        userData.session_token = null;
        userData.session_expires = 0;
        await env.GAME_KV.put(`game:user:${session.username}`, JSON.stringify(userData));
      }
      // 无论是否登录成功，都返回成功（避免泄露信息）
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // ---------- 以下所有接口都需要登录验证 ----------
    // 先验证 session
    const session = await verifySession(request, env);
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    const currentUser = session.username;

    // ---------- 获取游戏列表 ----------
    if (request.method === 'GET' && path === '/GAME_API/games') {
      try {
        const games = await env.GAME_KV.get(`game:user:${currentUser}:games`, 'json') || { games: [] };
        return new Response(JSON.stringify(games), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // ---------- 添加或更新游戏 ----------
    if (request.method === 'POST' && path === '/GAME_API/games') {
      try {
        const gameData = await request.json();
        // 简单校验
        if (!gameData.name || !gameData.launchPath || !gameData.gameProcessName || !gameData.savePath) {
          return new Response(JSON.stringify({ error: '缺少必要字段' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        // 生成唯一 id（如果已有 id 则更新）
        let gamesData = await env.GAME_KV.get(`game:user:${currentUser}:games`, 'json') || { games: [] };
        if (gameData.id) {
          // 更新已有游戏
          const index = gamesData.games.findIndex(g => g.id === gameData.id);
          if (index !== -1) {
            gamesData.games[index] = { ...gamesData.games[index], ...gameData };
          } else {
            return new Response(JSON.stringify({ error: '游戏不存在' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
        } else {
          // 新增
          const newId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
          gameData.id = newId;
          gameData.createdAt = Date.now();
          gameData.cloudKey = `game:user:${currentUser}:save:${newId}`;
          gamesData.games.push(gameData);
        }
        await env.GAME_KV.put(`game:user:${currentUser}:games`, JSON.stringify(gamesData));
        return new Response(JSON.stringify({ success: true, game: gameData }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // ---------- 删除游戏 ----------
    const deleteGameMatch = path.match(/^\/GAME_API\/games\/([^/]+)$/);
    if (request.method === 'DELETE' && deleteGameMatch) {
      const gameId = deleteGameMatch[1];
      try {
        let gamesData = await env.GAME_KV.get(`game:user:${currentUser}:games`, 'json') || { games: [] };
        const newGames = gamesData.games.filter(g => g.id !== gameId);
        if (newGames.length === gamesData.games.length) {
          return new Response(JSON.stringify({ error: '游戏不存在' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        gamesData.games = newGames;
        await env.GAME_KV.put(`game:user:${currentUser}:games`, JSON.stringify(gamesData));
        // 删除对应的存档数据
        await env.GAME_KV.delete(`game:user:${currentUser}:save:${gameId}`);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // ---------- 获取存档信息 ----------
    const infoMatch = path.match(/^\/GAME_API\/save\/info\/([^/]+)$/);
    if (request.method === 'GET' && infoMatch) {
      const gameId = infoMatch[1];
      try {
        const saveData = await env.GAME_KV.get(`game:user:${currentUser}:save:${gameId}`, 'json');
        if (saveData) {
          return new Response(JSON.stringify({
            updatedAt: saveData.updatedAt || 0,
            size: saveData.size || 0
          }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } else {
          return new Response(JSON.stringify({ updatedAt: 0, size: 0 }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // ---------- 下载存档（返回二进制） ----------
    const downloadMatch = path.match(/^\/GAME_API\/save\/([^/]+)$/);
    if (request.method === 'GET' && downloadMatch) {
      const gameId = downloadMatch[1];
      try {
        const saveData = await env.GAME_KV.get(`game:user:${currentUser}:save:${gameId}`, 'json');
        if (!saveData || !saveData.data) {
          return new Response('Not found', { status: 404, headers: corsHeaders });
        }
        // 解码 Base64 返回二进制
        const binaryString = atob(saveData.data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return new Response(bytes, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': bytes.length,
            ...corsHeaders
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // ---------- 上传存档 ----------
    if (request.method === 'POST' && downloadMatch) {
      const gameId = downloadMatch[1];
      try {
        const { data, updatedAt } = await request.json();
        if (!data) {
          return new Response(JSON.stringify({ error: '缺少存档数据' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        // 计算大小（解码后字节数）
        const binaryString = atob(data);
        const size = binaryString.length;

        const saveData = {
          data: data,
          updatedAt: updatedAt || Date.now(),
          size: size
        };
        await env.GAME_KV.put(`game:user:${currentUser}:save:${gameId}`, JSON.stringify(saveData));
        return new Response(JSON.stringify({ success: true, updatedAt: saveData.updatedAt }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // ---------- 静态资源（原有） ----------
    return env.ASSETS.fetch(request);
  }
};