// api/diagnostico.js — Vercel Serverless Function
// Variável de ambiente necessária:
//   ANTHROPIC_API_KEY = sk-ant-...

const https = require('https');

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 3) return reject(new Error('REDIRECT_LOOP'));
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
      },
      timeout: 12000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        if (loc.includes('/accounts/login') || loc.includes('/login')) return reject(new Error('BLOQUEADO_LOGIN'));
        const nextUrl = loc.startsWith('http') ? loc : `https://www.instagram.com${loc}`;
        return fetchUrl(nextUrl, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode === 404) return reject(new Error('PERFIL_NAO_ENCONTRADO'));
      if (res.statusCode === 429) return reject(new Error('RATE_LIMIT'));
      if (res.statusCode !== 200) return reject(new Error(`HTTP_${res.statusCode}`));
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 600000) res.destroy(); });
      res.on('end', () => {
        if (body.includes('"loginPage"') || body.includes('accounts/login/?next=')) return reject(new Error('BLOQUEADO_LOGIN'));
        resolve(body);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
  });
}

function decodeUnicode(str) {
  if (!str) return '';
  try {
    return str
      .replace(/\\u[\dA-Fa-f]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16)))
      .replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\//g, '/');
  } catch { return str; }
}

function parseInstagramPage(html, handle) {
  const sharedMatch = html.match(/window\._sharedData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (sharedMatch) {
    try {
      const shared = JSON.parse(sharedMatch[1]);
      const user = shared?.entry_data?.ProfilePage?.[0]?.graphql?.user;
      if (user) return extractFromGraphQL(user, handle);
    } catch (_) {}
  }
  const addMatch = html.match(/window\.__additionalDataLoaded\s*\([^,]+,\s*(\{.+?\})\s*\)\s*;/s);
  if (addMatch) {
    try {
      const d = JSON.parse(addMatch[1]);
      const user = d?.graphql?.user || d?.data?.user;
      if (user) return extractFromGraphQL(user, handle);
    } catch (_) {}
  }
  return extractFromMetaTags(html, handle);
}

function extractFromGraphQL(user, handle) {
  const posts = user.edge_owner_to_timeline_media?.edges || [];
  const recentPosts = posts.slice(0, 9).map(e => ({
    caption: decodeUnicode(e.node?.edge_media_to_caption?.edges?.[0]?.node?.text || ''),
    likes: e.node?.edge_liked_by?.count || e.node?.edge_media_preview_like?.count || 0,
    comments: e.node?.edge_media_to_comment?.count || 0,
    isVideo: e.node?.is_video || false,
    timestamp: e.node?.taken_at_timestamp || 0,
  }));
  return {
    handle: '@' + handle, name: decodeUnicode(user.full_name || handle),
    bio: decodeUnicode(user.biography || ''), website: user.external_url || '',
    followers: user.edge_followed_by?.count || 0, following: user.edge_follow?.count || 0,
    posts: user.edge_owner_to_timeline_media?.count || 0,
    isVerified: user.is_verified || false, isPrivate: user.is_private || false,
    profilePic: user.profile_pic_url_hd || user.profile_pic_url || '',
    recentPosts, category: user.category_name || '',
    isBusiness: user.is_business_account || false, source: 'graphql',
  };
}

function extractFromMetaTags(html, handle) {
  const get = p => { const m = html.match(p); return m ? decodeUnicode(m[1]) : ''; };
  const desc = get(/property="og:description"\s+content="([^"]+)"/);
  const title = get(/property="og:title"\s+content="([^"]+)"/);
  const image = get(/property="og:image"\s+content="([^"]+)"/);
  if (!desc && !title) throw new Error('NAO_CONSEGUIU_EXTRAIR');
  const fM = desc.match(/([\d,.]+[KMk]?)\s*Followers?/i) || desc.match(/([\d,.]+[KMk]?)\s*seguidores/i);
  const fgM = desc.match(/([\d,.]+[KMk]?)\s*Following/i) || desc.match(/([\d,.]+[KMk]?)\s*seguindo/i);
  const pM = desc.match(/([\d,.]+[KMk]?)\s*Posts?/i) || desc.match(/([\d,.]+[KMk]?)\s*publica/i);
  const parseNum = s => {
    if (!s) return 0; s = s.replace(/,/g,'').replace(/\./g,'');
    if (/k$/i.test(s)) return Math.round(parseFloat(s)*1000);
    if (/m$/i.test(s)) return Math.round(parseFloat(s)*1000000);
    return parseInt(s)||0;
  };
  const bioM = desc.match(/Posts\s*[-–]\s*(.+)$/is) || desc.match(/publicações\s*[-–]\s*(.+)$/is);
  const nameM = title.match(/^(.+?)\s*[\(@•]/);
  return {
    handle: '@' + handle, name: decodeUnicode(nameM?.[1]?.trim() || handle),
    bio: decodeUnicode(bioM?.[1]?.trim() || ''), website: '',
    followers: parseNum(fM?.[1]), following: parseNum(fgM?.[1]), posts: parseNum(pM?.[1]),
    isVerified: html.includes('"is_verified":true'), isPrivate: html.includes('"is_private":true'),
    profilePic: image, recentPosts: [], category: '', isBusiness: false, source: 'metatags',
  };
}

function minimalProfile(handle) {
  return {
    handle: '@' + handle, name: handle, bio: '', website: '',
    followers: 0, following: 0, posts: 0, isVerified: false, isPrivate: false,
    profilePic: '', recentPosts: [], category: '', isBusiness: false,
    source: 'blocked', isMock: true,
  };
}

function callAnthropic(apiKey, profile) {
  const blocked = profile.source === 'blocked';
  let postsContext = '';
  if (profile.recentPosts?.length > 0) {
    postsContext = '\n\nÚLTIMOS POSTS:\n' + profile.recentPosts.map((p, i) => {
      const date = p.timestamp ? new Date(p.timestamp*1000).toLocaleDateString('pt-BR') : '';
      const caption = p.caption ? p.caption.slice(0, 200) : '(sem legenda)';
      const eng = (p.likes||p.comments) ? `(${p.likes} curtidas, ${p.comments} comentários)` : '';
      return `Post ${i+1}${date?' em '+date:''}${p.isVideo?' [Reel]':' [Foto]'}: "${caption}" ${eng}`;
    }).join('\n');
  }
  const engRate = profile.followers > 0 && profile.recentPosts?.length > 0
    ? ((profile.recentPosts.reduce((s,p)=>s+(p.likes||0)+(p.comments||0),0)/profile.recentPosts.length)/profile.followers*100).toFixed(2) : null;

  const system = `Você é um especialista sênior em marketing digital médico com 10 anos de experiência no Brasil. Analisa perfis do Instagram com precisão clínica. Seu diagnóstico é direto, personalizado e cirúrgico. NUNCA usa frases genéricas. Responda APENAS em JSON válido. Sem markdown. Sem texto fora do JSON.`;

  const prompt = blocked
    ? `Analise o perfil médico @${profile.handle} no Instagram. Não foi possível extrair dados técnicos. Faça uma análise baseada no handle e gere recomendações estratégicas para médicos que precisam melhorar sua presença digital.\n\nRetorne exatamente este JSON:\n{"score":5.0,"scoreLabel":"Em desenvolvimento","scoreColor":"yellow","scoreTags":["Posicionamento","Consistência","CTA","Autoridade"],"attentionPoints":[{"title":"problema direto aqui","text":"2-3 frases específicas aqui"},{"title":"segundo problema","text":"explicação aqui"},{"title":"terceiro problema","text":"explicação aqui"}],"referenceProfile":{"handle":"@medico_real_brasileiro","specialty":"especialidade aqui","reason":"2 frases explicando a escolha"},"strategicAnalysis":"3-4 frases consultivas diretas aqui","quickWins":["ação concreta 1","ação concreta 2","ação concreta 3"]}`
    : `Analise este perfil de médico no Instagram:\nHandle: ${profile.handle}\nNome: ${profile.name}\nBio: ${profile.bio||'(vazia)'}\nWebsite: ${profile.website||'nenhum'}\nSeguidores: ${profile.followers.toLocaleString('pt-BR')}\nSeguindo: ${profile.following.toLocaleString('pt-BR')}\nPosts: ${profile.posts}\nVerificado: ${profile.isVerified?'Sim':'Não'}\nBusiness: ${profile.isBusiness?'Sim':'Não'}\nCategoria: ${profile.category||'não informada'}\n${engRate?`Engajamento: ${engRate}%`:''}\n${postsContext}\n\nRetorne exatamente este JSON:\n{"score":0.0,"scoreLabel":"Em desenvolvimento","scoreColor":"yellow","scoreTags":["critério1","critério2","critério3","critério4"],"attentionPoints":[{"title":"problema direto máx 7 palavras","text":"2-3 frases específicas para este perfil"},{"title":"segundo problema","text":"explicação personalizada"},{"title":"terceiro problema","text":"explicação personalizada"}],"referenceProfile":{"handle":"@medico_real_brasileiro","specialty":"especialidade","reason":"2 frases explicando a escolha"},"strategicAnalysis":"3-4 frases consultivas diretas","quickWins":["ação concreta 1","ação concreta 2","ação concreta 3"]}`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1800,
    system,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 25000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const clean = (parsed.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
          resolve(JSON.parse(clean));
        } catch (e) {
          reject(new Error('Resposta da IA em formato inesperado: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout na IA')); });
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  let handle;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    handle = (body?.handle || '').replace('@', '').trim().toLowerCase();
  } catch {
    return res.status(400).json({ error: 'Body inválido' });
  }

  if (!handle || !/^[a-zA-Z0-9._]{1,30}$/.test(handle)) {
    return res.status(400).json({ error: 'Handle inválido' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });

  let profile;
  try {
    const html = await fetchUrl(`https://www.instagram.com/${handle}/`);
    try { profile = parseInstagramPage(html, handle); }
    catch (e) { profile = minimalProfile(handle); }
    if (profile.isPrivate) return res.status(422).json({ error: `O perfil @${handle} está privado.` });
  } catch (e) {
    if (e.message === 'PERFIL_NAO_ENCONTRADO') {
      return res.status(404).json({ error: `Perfil @${handle} não encontrado.` });
    }
    console.log('Instagram inacessível, usando fallback:', e.message);
    profile = minimalProfile(handle);
  }

  try {
    const diagnosis = await callAnthropic(apiKey, profile);
    return res.status(200).json({ profile, diagnosis });
  } catch (err) {
    console.error('Erro Anthropic:', err.message);
    return res.status(500).json({ error: 'Erro ao gerar diagnóstico: ' + err.message });
  }
};
