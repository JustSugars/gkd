// 在 GET /HISTORY_API/updates 之后，添加以下路由

// ---------- 获取客户端 IP 和运营商信息 ----------
if (request.method === 'GET' && path === '/HISTORY_API/ipinfo') {
  try {
    // 获取真实 IP（Cloudflare 提供的头部）
    const ip = request.headers.get('CF-Connecting-IP') || 
               request.headers.get('X-Forwarded-For')?.split(',')[0] || 
               '未知 IP';
    // 获取运营商名称（CF-ISP 头部）
    const isp = request.headers.get('CF-ISP') || '';
    // 获取国家代码（可选）
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