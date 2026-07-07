// ============================================================
// _worker.js - 电费分摊计算器 + 游戏存档同步功能（完整版）
// ============================================================

// ---------- CORS 头 ----------
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Expires, Authorization',
};

// ---------- 原有默认值 ----------
const DEFAULT_OP_PASSWORD = '0000';
const DEFAULT_ADMIN_PREFIX = 'Admin';

// ============================================================
// 原有函数：管理员动态密钥（电费计算器用）
// ============================================================
function getDynamicAdminKey(env, prefix) {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const day = beijingTime.getUTCDate();
  const hour = beijingTime.getUTCHours();
  return `${prefix}${day}${hour}`;
}

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

async function initializeKV(env) {
  // 原有初始化
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
  // 游戏相关初始化
  const users = await env.HISTORY_KV.get('game:users', 'json');
  if (users === null) {
    await env.HISTORY_KV.put('game:users', JSON.stringify([]));
  }
  const inviteCode = await env.HISTORY_KV.get('game:invite_code');
  if (inviteCode === null) {
    await env.HISTORY_KV.put('game:invite_code', 'GAME2024');
  }
  const adminName = await env.HISTORY_KV.get('game:admin_name');
  if (adminName === null) {
    await env.HISTORY_KV.put('game:admin_name', 'Admin');
  }
  const adminPassword = await env.HISTORY_KV.get('game:admin_password');
  if (adminPassword === null) {
    await env.HISTORY_KV.put('game:admin_password', 'admin');
  }
}

// ============================================================
// 游戏同步辅助函数
// ============================================================

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifySession(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7);
  const users = await env.HISTORY_KV.get('game:users', 'json') || [];
  // 检查普通用户
  for (const username of users) {
    const userData = await env.HISTORY_KV.get(`game:user:${username}`, 'json');
    if (userData && userData.session_token === token) {
      if (Date.now() > userData.session_expires) {
        return null;
      }
      return { username, userData };
    }
  }
  // 检查管理员（不在 game:users 中）
  const adminName = await env.HISTORY_KV.get('game:admin_name') || 'Admin';
  const adminData = await env.HISTORY_KV.get(`game:user:${adminName}`, 'json');
  if (adminData && adminData.session_token === token) {
    if (Date.now() > adminData.session_expires) {
      return null;
    }
    return { username: adminName, userData: adminData };
  }
  return null;
}

// 获取管理员动态密码（使用北京时间）
async function getAdminDynamicPassword(env) {
  const suffix = await env.HISTORY_KV.get('game:admin_password') || 'admin';
  const now = new Date();
  // 转为北京时间 UTC+8
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const day = beijingTime.getUTCDate();
  const hour = beijingTime.getUTCHours();
  return `${day}${hour}${suffix}`;
}

// ============================================================
// 主 fetch 处理
// ============================================================

export default {
  async fetch(request, env) {
    await initializeKV(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ============================================================
    // 原有路由：/HISTORY_API/*
    // ============================================================

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
    // 游戏同步 API（/GAME_API/*）
    // ============================================================

    // ---------- 注册 ----------
    if (request.method === 'POST' && path === '/GAME_API/auth/register') {
      try {
        const { username, password, invite_code } = await request.json();
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

        // 检查是否与管理员重名
        const adminName = await env.HISTORY_KV.get('game:admin_name') || 'Admin';
        if (username === adminName) {
          return new Response(JSON.stringify({ success: false, message: '用户名已被保留' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // 邀请码校验
        const validInviteCode = await env.HISTORY_KV.get('game:invite_code') || 'GAME2024';
        if (!invite_code || invite_code !== validInviteCode) {
          return new Response(JSON.stringify({ success: false, message: '邀请码无效' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const users = await env.HISTORY_KV.get('game:users', 'json') || [];
        if (users.includes(username)) {
          return new Response(JSON.stringify({ success: false, message: '用户名已被注册' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const salt = Math.random().toString(36).substring(2, 10);
        const passwordHash = await hashPassword(password, salt);

        const userData = {
          username,
          password_hash: passwordHash,
          salt,
          session_token: null,
          session_expires: 0,
          created_at: Date.now()
        };
        await env.HISTORY_KV.put(`game:user:${username}`, JSON.stringify(userData));
        // 初始化空游戏列表
        await env.HISTORY_KV.put(`game:user:${username}:games`, JSON.stringify({ games: [] }));
        users.push(username);
        await env.HISTORY_KV.put('game:users', JSON.stringify(users));

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

    // ---------- 登录 ----------
    if (request.method === 'POST' && path === '/GAME_API/auth/login') {
      try {
        const { username, password } = await request.json();
        if (!username || !password) {
          return new Response(JSON.stringify({ success: false, message: '用户名和密码不能为空' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // 检查是否为管理员
        const adminName = await env.HISTORY_KV.get('game:admin_name') || 'Admin';
        if (username === adminName) {
          // 管理员密码验证（动态，使用北京时间）
          const expectedPassword = await getAdminDynamicPassword(env);
          if (password !== expectedPassword) {
            return new Response(JSON.stringify({ success: false, message: '用户名或密码错误' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          // 确保管理员有 game:user:Admin 记录
          let adminUserData = await env.HISTORY_KV.get(`game:user:${adminName}`, 'json');
          if (!adminUserData) {
            adminUserData = {
              username: adminName,
              created_at: Date.now()
            };
            await env.HISTORY_KV.put(`game:user:${adminName}`, JSON.stringify(adminUserData));
            await env.HISTORY_KV.put(`game:user:${adminName}:games`, JSON.stringify({ games: [] }));
          }
          // 生成会话 token
          const newToken = generateToken();
          const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
          adminUserData.session_token = newToken;
          adminUserData.session_expires = expires;
          adminUserData.last_login_time = Date.now();
          await env.HISTORY_KV.put(`game:user:${adminName}`, JSON.stringify(adminUserData));
          return new Response(JSON.stringify({
            success: true,
            token: newToken,
            expires: expires,
            username: adminName,
            isAdmin: true
          }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // 普通用户验证
        const userData = await env.HISTORY_KV.get(`game:user:${username}`, 'json');
        if (!userData) {
          return new Response(JSON.stringify({ success: false, message: '用户名或密码错误' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        const hashedInput = await hashPassword(password, userData.salt);
        if (hashedInput !== userData.password_hash) {
          return new Response(JSON.stringify({ success: false, message: '用户名或密码错误' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const newToken = generateToken();
        const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
        userData.session_token = newToken;
        userData.session_expires = expires;
        userData.last_login_time = Date.now();
        await env.HISTORY_KV.put(`game:user:${username}`, JSON.stringify(userData));

        return new Response(JSON.stringify({
          success: true,
          token: newToken,
          expires: expires,
          username: username,
          isAdmin: false
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
        const userData = session.userData;
        userData.session_token = null;
        userData.session_expires = 0;
        await env.HISTORY_KV.put(`game:user:${session.username}`, JSON.stringify(userData));
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // ============================================================
    // 以下接口需要登录验证
    // ============================================================

    const isGameApiPath = path.startsWith('/GAME_API/');
    if (isGameApiPath) {
      const session = await verifySession(request, env);
      if (!session) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      const currentUser = session.username;

      // ---------- 验证是否为管理员 ----------
      if (request.method === 'GET' && path === '/GAME_API/admin/verify') {
        const adminName = await env.HISTORY_KV.get('game:admin_name') || 'Admin';
        const isAdmin = (currentUser === adminName);
        return new Response(JSON.stringify({ admin: isAdmin }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // ---------- 修改当前用户密码 ----------
      if (request.method === 'POST' && path === '/GAME_API/user/change-password') {
        try {
          const { oldPassword, newPassword } = await request.json();
          const adminName = await env.HISTORY_KV.get('game:admin_name') || 'Admin';
          // 管理员修改密码后缀
          if (currentUser === adminName) {
            if (!newPassword || newPassword.length < 1) {
              return new Response(JSON.stringify({ error: '密码后缀不能为空' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
              });
            }
            await env.HISTORY_KV.put('game:admin_password', newPassword);
            return new Response(JSON.stringify({ success: true }), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          // 普通用户修改密码
          const userData = await env.HISTORY_KV.get(`game:user:${currentUser}`, 'json');
          if (!userData) {
            return new Response(JSON.stringify({ error: 'User not found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          const oldHash = await hashPassword(oldPassword, userData.salt);
          if (oldHash !== userData.password_hash) {
            return new Response(JSON.stringify({ error: '旧密码错误' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          if (newPassword.length > 9) {
            return new Response(JSON.stringify({ error: '密码不能超过9位' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          if (!/^[a-zA-Z0-9]+$/.test(newPassword)) {
            return new Response(JSON.stringify({ error: '密码只能包含数字和大小写字母' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          if (newPassword.length < 1) {
            return new Response(JSON.stringify({ error: '密码不能为空' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          const salt = Math.random().toString(36).substring(2, 10);
          const newHash = await hashPassword(newPassword, salt);
          userData.password_hash = newHash;
          userData.salt = salt;
          await env.HISTORY_KV.put(`game:user:${currentUser}`, JSON.stringify(userData));
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

      // ---------- 获取游戏列表 ----------
      if (request.method === 'GET' && path === '/GAME_API/games') {
        try {
          const games = await env.HISTORY_KV.get(`game:user:${currentUser}:games`, 'json') || { games: [] };
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
          if (!gameData.name || !gameData.gameProcessName) {
            return new Response(JSON.stringify({
              error: '缺少必要字段：name, gameProcessName'
            }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          if (!gameData.savePath && !gameData.saveFolder) {
            return new Response(JSON.stringify({
              error: '缺少存档路径字段：savePath 或 saveFolder'
            }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          let gamesData = await env.HISTORY_KV.get(`game:user:${currentUser}:games`, 'json') || { games: [] };
          if (gameData.id) {
            const index = gamesData.games.findIndex(g => g.id === gameData.id);
            if (index !== -1) {
              const existing = gamesData.games[index];
              gamesData.games[index] = {
                ...existing,
                name: gameData.name,
                gameProcessName: gameData.gameProcessName,
                saveFolder: gameData.saveFolder || existing.saveFolder || existing.savePath || '',
                savePath: gameData.savePath || existing.savePath || existing.saveFolder || '',
                filePattern: gameData.filePattern || existing.filePattern || '*.sav'
              };
            } else {
              return new Response(JSON.stringify({ error: '游戏不存在' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
              });
            }
          } else {
            const newId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
            const newGame = {
              id: newId,
              name: gameData.name,
              gameProcessName: gameData.gameProcessName,
              saveFolder: gameData.saveFolder || gameData.savePath || '',
              savePath: gameData.savePath || gameData.saveFolder || '',
              filePattern: gameData.filePattern || '*.sav',
              cloudKey: `game:user:${currentUser}:save:${newId}`,
              createdAt: Date.now()
            };
            gamesData.games.push(newGame);
            gameData.id = newId;
          }
          await env.HISTORY_KV.put(`game:user:${currentUser}:games`, JSON.stringify(gamesData));
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

      // ---------- 删除游戏配置 ----------
      const gameDeleteMatch = path.match(/^\/GAME_API\/games\/([^/]+)$/);
      if (request.method === 'DELETE' && gameDeleteMatch) {
        const gameId = gameDeleteMatch[1];
        try {
          let gamesData = await env.HISTORY_KV.get(`game:user:${currentUser}:games`, 'json') || { games: [] };
          const newGames = gamesData.games.filter(g => g.id !== gameId);
          if (newGames.length === gamesData.games.length) {
            return new Response(JSON.stringify({ error: '游戏不存在' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          gamesData.games = newGames;
          await env.HISTORY_KV.put(`game:user:${currentUser}:games`, JSON.stringify(gamesData));
          await env.HISTORY_KV.delete(`game:user:${currentUser}:save:${gameId}`);
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
          const saveData = await env.HISTORY_KV.get(`game:user:${currentUser}:save:${gameId}`, 'json');
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

      // ---------- 下载存档 ----------
      const downloadMatch = path.match(/^\/GAME_API\/save\/([^/]+)$/);
      if (request.method === 'GET' && downloadMatch) {
        const gameId = downloadMatch[1];
        try {
          const saveData = await env.HISTORY_KV.get(`game:user:${currentUser}:save:${gameId}`, 'json');
          if (!saveData || !saveData.data) {
            return new Response('Not found', { status: 404, headers: corsHeaders });
          }
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
          const binaryString = atob(data);
          const size = binaryString.length;
          const saveData = {
            data: data,
            updatedAt: updatedAt || Date.now(),
            size: size
          };
          await env.HISTORY_KV.put(`game:user:${currentUser}:save:${gameId}`, JSON.stringify(saveData));
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

      // ---------- 删除云端存档 ----------
      const deleteSaveMatch = path.match(/^\/GAME_API\/save\/([^/]+)$/);
      if (request.method === 'DELETE' && deleteSaveMatch) {
        const gameId = deleteSaveMatch[1];
        try {
          const saveData = await env.HISTORY_KV.get(`game:user:${currentUser}:save:${gameId}`, 'json');
          if (!saveData) {
            return new Response(JSON.stringify({ error: '云端存档不存在' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          await env.HISTORY_KV.delete(`game:user:${currentUser}:save:${gameId}`);
          return new Response(JSON.stringify({ success: true, deleted: true }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
      }

      // ============================================================
      // 管理员专用接口
      // ============================================================

      const adminName = await env.HISTORY_KV.get('game:admin_name') || 'Admin';
      const isAdmin = (currentUser === adminName);

      // ---------- 获取所有用户 ----------
      if (request.method === 'GET' && path === '/GAME_API/admin/users') {
        if (!isAdmin) {
          return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders });
        }
        try {
          const users = await env.HISTORY_KV.get('game:users', 'json') || [];
          const userList = [];
          // 添加管理员
          const adminData = await env.HISTORY_KV.get(`game:user:${adminName}`, 'json');
          const adminGames = await env.HISTORY_KV.get(`game:user:${adminName}:games`, 'json') || { games: [] };
          userList.push({
            username: adminName,
            isAdmin: true,
            gameCount: adminGames.games.length,
            created_at: adminData ? adminData.created_at : Date.now()
          });
          // 添加普通用户
          for (const username of users) {
            const userData = await env.HISTORY_KV.get(`game:user:${username}`, 'json');
            const gamesData = await env.HISTORY_KV.get(`game:user:${username}:games`, 'json') || { games: [] };
            userList.push({
              username: username,
              isAdmin: false,
              gameCount: gamesData.games.length,
              created_at: userData ? userData.created_at : Date.now()
            });
          }
          return new Response(JSON.stringify({ users: userList }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
      }

      // ---------- 获取所有用户的所有游戏（所有存档视图） ----------
      if (request.method === 'GET' && path === '/GAME_API/admin/all-games') {
        if (!isAdmin) {
          return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders });
        }
        try {
          const users = await env.HISTORY_KV.get('game:users', 'json') || [];
          const allGames = [];
          // 获取管理员游戏
          const adminGames = await env.HISTORY_KV.get(`game:user:${adminName}:games`, 'json') || { games: [] };
          for (const game of adminGames.games) {
            const saveData = await env.HISTORY_KV.get(game.cloudKey, 'json');
            allGames.push({
              username: adminName,
              gameId: game.id,
              gameName: game.name,
              saveFolder: game.saveFolder || game.savePath || '',
              filePattern: game.filePattern || '*.sav',
              updatedAt: saveData ? saveData.updatedAt : 0,
              size: saveData ? saveData.size : 0,
              hasSave: !!saveData
            });
          }
          // 获取普通用户游戏
          for (const username of users) {
            const gamesData = await env.HISTORY_KV.get(`game:user:${username}:games`, 'json') || { games: [] };
            for (const game of gamesData.games) {
              const saveData = await env.HISTORY_KV.get(game.cloudKey, 'json');
              allGames.push({
                username: username,
                gameId: game.id,
                gameName: game.name,
                saveFolder: game.saveFolder || game.savePath || '',
                filePattern: game.filePattern || '*.sav',
                updatedAt: saveData ? saveData.updatedAt : 0,
                size: saveData ? saveData.size : 0,
                hasSave: !!saveData
              });
            }
          }
          return new Response(JSON.stringify({ games: allGames }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
      }

      // ---------- 获取指定用户的游戏 ----------
      const userGamesMatch = path.match(/^\/GAME_API\/admin\/users\/([^/]+)\/games$/);
      if (request.method === 'GET' && userGamesMatch) {
        if (!isAdmin) {
          return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders });
        }
        const targetUser = userGamesMatch[1];
        try {
          const gamesData = await env.HISTORY_KV.get(`game:user:${targetUser}:games`, 'json') || { games: [] };
          const gamesWithTime = [];
          for (const game of gamesData.games) {
            const saveData = await env.HISTORY_KV.get(game.cloudKey, 'json');
            gamesWithTime.push({
              id: game.id,
              name: game.name,
              updatedAt: saveData ? saveData.updatedAt : 0,
              size: saveData ? saveData.size : 0,
              hasSave: !!saveData
            });
          }
          return new Response(JSON.stringify({ games: gamesWithTime }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
      }

      // ---------- 删除用户 ----------
      const deleteUserMatch = path.match(/^\/GAME_API\/admin\/users\/([^/]+)$/);
      if (request.method === 'DELETE' && deleteUserMatch) {
        if (!isAdmin) {
          return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders });
        }
        const targetUser = deleteUserMatch[1];
        if (targetUser === adminName) {
          return new Response(JSON.stringify({ error: '不能删除管理员' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        try {
          const gamesData = await env.HISTORY_KV.get(`game:user:${targetUser}:games`, 'json') || { games: [] };
          for (const game of gamesData.games) {
            await env.HISTORY_KV.delete(game.cloudKey);
          }
          await env.HISTORY_KV.delete(`game:user:${targetUser}:games`);
          await env.HISTORY_KV.delete(`game:user:${targetUser}`);
          const users = await env.HISTORY_KV.get('game:users', 'json') || [];
          await env.HISTORY_KV.put('game:users', JSON.stringify(users.filter(u => u !== targetUser)));
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

      // ---------- 修改用户 ----------
      if (request.method === 'PUT' && deleteUserMatch) {
        if (!isAdmin) {
          return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders });
        }
        const oldUsername = deleteUserMatch[1];
        if (oldUsername === adminName) {
          return new Response(JSON.stringify({ error: '不能修改管理员用户名' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        try {
          const { newUsername, newPassword } = await request.json();
          const oldUserData = await env.HISTORY_KV.get(`game:user:${oldUsername}`, 'json');
          if (!oldUserData) {
            return new Response(JSON.stringify({ error: '用户不存在' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          if (newUsername && newUsername !== oldUsername) {
            // 检查新用户名是否与管理员冲突
            if (newUsername === adminName) {
              return new Response(JSON.stringify({ error: '用户名与管理员冲突' }), {
                status: 409,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
              });
            }
            // 检查新用户名是否已被占用
            const users = await env.HISTORY_KV.get('game:users', 'json') || [];
            if (users.includes(newUsername)) {
              return new Response(JSON.stringify({ error: '用户名已被占用' }), {
                status: 409,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
              });
            }

            // ============================================================
            // 迁移数据
            // ============================================================

            // 1. 迁移游戏列表和存档
            const gamesData = await env.HISTORY_KV.get(`game:user:${oldUsername}:games`, 'json');
            if (gamesData) {
              for (const game of gamesData.games) {
                const oldCloudKey = game.cloudKey;
                const newCloudKey = `game:user:${newUsername}:save:${game.id}`;
                const saveData = await env.HISTORY_KV.get(oldCloudKey, 'json');
                if (saveData) {
                  await env.HISTORY_KV.put(newCloudKey, JSON.stringify(saveData));
                  await env.HISTORY_KV.delete(oldCloudKey);
                }
                game.cloudKey = newCloudKey;
              }
              await env.HISTORY_KV.put(`game:user:${newUsername}:games`, JSON.stringify(gamesData));
              await env.HISTORY_KV.delete(`game:user:${oldUsername}:games`);
            }

            // 2. 迁移用户数据（关键：更新内部的 username 字段）
            const newUserData = { ...oldUserData };
            newUserData.username = newUsername;  // ← 修复：更新内部 username 字段
            await env.HISTORY_KV.put(`game:user:${newUsername}`, JSON.stringify(newUserData));
            await env.HISTORY_KV.delete(`game:user:${oldUsername}`);

            // 3. 更新用户列表
            let usersList = await env.HISTORY_KV.get('game:users', 'json') || [];
            usersList = usersList.map(u => u === oldUsername ? newUsername : u);
            await env.HISTORY_KV.put('game:users', JSON.stringify(usersList));
          }

          // 修改密码（如果有）
          if (newPassword) {
            const targetUser = newUsername || oldUsername;
            const userData = await env.HISTORY_KV.get(`game:user:${targetUser}`, 'json');
            if (userData) {
              // 验证密码规则（不超过9位，仅数字大小写字母）
              if (newPassword.length > 9) {
                return new Response(JSON.stringify({ error: '密码不能超过9位' }), {
                  status: 400,
                  headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
              }
              if (!/^[a-zA-Z0-9]+$/.test(newPassword)) {
                return new Response(JSON.stringify({ error: '密码只能包含数字和大小写字母' }), {
                  status: 400,
                  headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
              }
              if (newPassword.length < 1) {
                return new Response(JSON.stringify({ error: '密码不能为空' }), {
                  status: 400,
                  headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
              }
              const salt = Math.random().toString(36).substring(2, 10);
              const newHash = await hashPassword(newPassword, salt);
              userData.password_hash = newHash;
              userData.salt = salt;
              await env.HISTORY_KV.put(`game:user:${targetUser}`, JSON.stringify(userData));
            }
          }

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

      // 如果 /GAME_API/ 路径都没匹配上，返回 404
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // ============================================================
    // 静态资源
    // ============================================================
    return env.ASSETS.fetch(request);
  }
};