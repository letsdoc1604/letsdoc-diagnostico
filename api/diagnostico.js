// api/diagnostico.js — Vercel Serverless Function
// Variável de ambiente necessária (configure no painel da Vercel):
//   ANTHROPIC_API_KEY = sk-ant-...

const https = require('https');
const http  = require('http');

// ─── FETCH INSTAGRAM ─────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode === 404) return reject(new Error('PERFIL_NAO_ENCONTRADO'));
      if (res.statusCode !== 200) return reject(new Error(`HTTP_${res.statusCode}`));

      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 500000) res.destroy(); });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
  });
}

function decodeUnicode(str) {
  if (!str) return '';
  return str
    .replace(/\\u[\dA-Fa-f]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/');
}

function parseInstagramPage(html, handle) {
  // Tenta JSON embutido
  const sharedMatch = html.match(/window\._sharedData\s*=\s*(\{.+?\});<\/script>/s);
  if (sharedMatch) {
    try {
      const shared = JSON.parse(sharedMatch[1]);
      const user = shared?.entry_data?.ProfilePage?.[0]?.graphql?.user;
      if (user) return extractFromGraphQL(user, handle);
    } catch (_) {}
  }

  const additionalMatch = html.match(/window\.__additionalDataLoaded\([^,]+,(\{.+?\})\);<\/script>/s);
  if (additionalMatch) {
    try {
      const data = JSON.parse(additionalMatch[1]);
      const user = data?.graphql?.user || data?.data?.user;
      if (user) return extractFromGraphQL(user, handle);
    } catch (_) {}
  }

  return extractFromMetaTags(html, handle);
}

function extractFromGraphQL(user, handle) {
  const posts = user.edge_owner_to_timeline_media?.edges || [];
  const recentPosts = posts.slice(0, 9).map(e => ({
    caption:  decodeUnicode(e.node?.edge_media_to_caption?.edges?.[0]?.node?.text || ''),
    likes:    e.node?.edge_liked_by?.count || e.node?.edge_media_preview_like?.count || 0,
    comments: e.node?.edge_media_to_comment?.count || 0,
    isVideo:  e.node?.is_video || false,
    timestamp: e.node?.taken_at_timestamp || 0,
  }));

  return {
    handle:     '@' + handle,
    name:       decodeUnicode(user.full_name || handle),
    bio:        decodeUnicode(user.biography || ''),
    website:    user.external_url || '',
    followers:  user.edge_followed_by?.count || 0,
    following:  user.edge_follow?.count || 0,
    posts:      user.edge_owner_to_timeline_media?.count || 0,
    isVerified: user.is_verified || false,
    isPrivate:  user.is_private || false,
    profilePic: user.profile_pic_url_hd || user.profile_pic_url || '',
    recentPosts,
    category:   user.category_name || '',
    isBusiness: user.is_business_account || false,
    source:     'graphql',
  };
}

function extractFromMetaTags(html, handle) {
  const get = (pattern) => { const m = html.match(pattern); return m ? decodeUnicode(m[1]) : ''; };

  const description = get(/property="og:description"\s+content="([^"]+)"/);
  const title       = get(/property="og:title"\s+content="([^"]+)"/);
  const image       = get(/property="og:image"\s+content="([^"]+)"/);

  const followersMatch = description.match(/([\d,\.]+[KMk]?)\s*Followers?/i) || description.match(/([\d,\.]+[KMk]?)\s*seguidores/i);
  const followingMatch = description.match(/([\d,\.]+[KMk]?)\s*Following/i)  || description.match(/([\d,\.]+[KMk]?)\s*seguindo/i);
  const postsMatch     = description.match(/([\d,\.]+[KMk]?)\s*Posts?/i)     || description.match(/([\d,\.]+[KMk]?)\s*publica/i);

  const parseNum = (s) => {
    if (!s) return 0;
    s = s.replace(/,/g,'').replace(/\./g,'');
    if (/k$/i.test(s)) return Math.round(parseFloat(s) * 1000);
    if (/m$/i.test(s)) return Math.round(parseFloat(s) * 1000000);
    return parseInt(s) || 0;
  };

  const bioMatch  = description.match(/Posts\s*[-–]\s*(.+)$/is) || description.match(/publicações\s*[-–]\s*(.+)$/is);
  const nameMatch = title.match(/^(.+?)\s*\(/);

  if (!followersMatch) throw new Error('NAO_CONSEGUIU_EXTRAIR');

  return {
    handle:     '@' + handle,
    name:       decodeUnicode(nameMatch ? nameMatch[1].trim() : handle),
    bio:        decodeUnicode(bioMatch ? bioMatch[1].trim() : ''),
    website:    '',
    followers:  parseNum(followersMatch?.[1]),
    following:  parseNum(followingMatch?.[1]),
    posts:      parseNum(postsMatch?.[1]),
    isVerified: html.includes('"is_verified":true'),
    isPrivate:  html.includes('"is_private":true'),
    profilePic: image,
    recentPosts: [],
    category:   '',
    isBusiness: false,
    source:     'metatags',
  };
}

// ─── ANTHROPIC ───────────────────────────────────────────────────────────────
function callAnthropic(apiKey, profile) {
  let postsContext = '';
  if (profile.recentPosts?.length > 0) {
    postsContext = '\n\nÚLTIMOS POSTS:\n' + profile.recentPosts.map((p, i) => {
      const date    = p.timestamp ? new Date(p.timestamp * 1000).toLocaleDateString('pt-BR') : '';
      const caption = p.caption ? p.caption.slice(0, 200) : '(sem legenda)';
      const eng     = p.likes || p.comments ? `(${p.likes} curtidas, ${p.comments} comentários)` : '';
      return `Post ${i+1}${date?' em '+date:''}${p.isVideo?' [Reel/Vídeo]':' [Foto]'}: "${caption}" ${eng}`;
    }).join('\n');
  }

  const engRate = profile.followers > 0 && profile.recentPosts?.length > 0
    ? ((profile.recentPosts.reduce((s,p) => s + (p.likes||0) + (p.comments||0), 0) / profile.recentPosts.length) / profile.followers * 100).toFixed(2)
    : null;

  const system = `Você é um especialista sênior em marketing digital médico com 10 anos de experiência no Brasil. Analisa perfis do Instagram com precisão clínica — não como copywriter genérico, mas como quem conhece o comportamento de pacientes nas redes, as nuances do CFM e o que separa um médico que gera consultas de um que apenas tem seguidores. Seu diagnóstico é direto, personalizado e cirúrgico. NUNCA usa frases genéricas sem ancorar no perfil específico. Responda APENAS em JSON válido. Sem markdown. Sem texto fora do JSON.`;

  const prompt = `Analise este perfil de médico no Instagram:

Handle: ${profile.handle}
Nome: ${profile.name}
Bio: ${profile.bio || '(vazia)'}
Website na bio: ${profile.website || 'nenhum'}
Seguidores: ${profile.followers.toLocaleString('pt-BR')}
Seguindo: ${profile.following.toLocaleString('pt-BR')}
Posts: ${profile.posts}
Verificado: ${profile.isVerified ? 'Sim' : 'Não'}
Business/Creator: ${profile.isBusiness ? 'Sim' : 'Não'}
Categoria: ${profile.category || 'não informada'}
${engRate ? `Taxa de engajamento estimada: ${engRate}%` : ''}
${postsContext}

Retorne JSON com esta estrutura EXATA:
{
  "score": <0-10 com uma casa decimal>,
  "scoreLabel": "<Crítico | Abaixo da média | Em desenvolvimento | Competitivo | Autoridade Digital>",
  "scoreColor": "<red|yellow|green>",
  "scoreTags": ["<critério 1>","<critério 2>","<critério 3>","<critério 4>"],
  "attentionPoints": [
    { "title": "<problema direto, máx 7 palavras>", "text": "<2-3 frases específicas para este perfil>" },
    { "title": "<problema 2>", "text": "<explicação personalizada>" },
    { "title": "<problema 3>", "text": "<explicação personalizada>" }
  ],
  "referenceProfile": {
    "handle": "@<médico brasileiro real ativo no Instagram>",
    "specialty": "<especialidade>",
    "reason": "<por que foi escolhido para este médico, 2 frases>"
  },
  "strategicAnalysis": "<insight que o médico provavelmente não percebe sozinho. 3-4 frases. Tom consultivo, começa forte e direto.>",
  "quickWins": ["<ação concreta para fazer esta semana>","<ação 2>","<ação 3>"]
}`;

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
          const text  = parsed.content?.[0]?.text || '';
          const clean = text.replace(/```json|```/g, '').trim();
          resolve(JSON.parse(clean));
        } catch (e) {
          reject(new Error('Resposta da IA em formato inesperado'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout na IA')); });
    req.write(body);
    req.end();
  });
}

// ─── HANDLER VERCEL ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método não permitido' });

  // Parse body
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
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada nas variáveis de ambiente da Vercel' });
  }

  try {
    // 1. Busca Instagram
    let html;
    try {
      html = await fetchUrl(`https://www.instagram.com/${handle}/`);
    } catch (e) {
      if (e.message === 'PERFIL_NAO_ENCONTRADO') {
        return res.status(404).json({ error: `Perfil @${handle} não encontrado. Verifique o @ digitado.` });
      }
      throw e;
    }

    let profile;
    try {
      profile = parseInstagramPage(html, handle);
    } catch (e) {
      if (e.message === 'NAO_CONSEGUIU_EXTRAIR') {
        return res.status(422).json({ error: 'Não foi possível ler os dados deste perfil. Pode estar privado ou o Instagram bloqueou temporariamente. Tente novamente em alguns minutos.' });
      }
      throw e;
    }

    if (profile.isPrivate) {
      return res.status(422).json({ error: `O perfil @${handle} está configurado como privado. O diagnóstico funciona apenas com perfis públicos.` });
    }

    // 2. Gera diagnóstico
    const diagnosis = await callAnthropic(apiKey, profile);

    return res.status(200).json({ profile, diagnosis });

  } catch (err) {
    console.error('Erro:', err.message);
    return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
  }
};
