// api/diagnostico.js — Vercel Serverless Function
// Variáveis de ambiente necessárias:
//   ANTHROPIC_API_KEY = sk-ant-...
//   APIFY_TOKEN = apify_api_...

const https = require('https');

// ─── APIFY INSTAGRAM SCRAPER ─────────────────────────────────────────────────
function apifyRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    const token = process.env.APIFY_TOKEN;
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.apify.com',
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 55000,
    }, (res) => {
      let out = '';
      res.on('data', chunk => out += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch { reject(new Error('Apify resposta inválida: ' + out.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Apify timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchInstagramProfile(handle) {
  // 1. Inicia o actor
  const run = await apifyRequest(
    '/v2/acts/apify~instagram-profile-scraper/runs?timeout=50&memory=256',
    'POST',
    { usernames: [handle] }
  );

  const runId = run?.data?.id;
  if (!runId) throw new Error('Apify não retornou run ID');

  // 2. Aguarda conclusão (polling)
  let status = 'RUNNING';
  let attempts = 0;
  while (status === 'RUNNING' || status === 'READY') {
    await sleep(3000);
    attempts++;
    if (attempts > 15) throw new Error('Apify demorou demais');
    const check = await apifyRequest(`/v2/actor-runs/${runId}`, 'GET');
    status = check?.data?.status;
  }

  if (status !== 'SUCCEEDED') throw new Error(`Apify falhou: ${status}`);

  // 3. Busca resultado
  const datasetId = (await apifyRequest(`/v2/actor-runs/${runId}`, 'GET'))?.data?.defaultDatasetId;
  const items = await apifyRequest(`/v2/datasets/${datasetId}/items?limit=1`, 'GET');
  const user = Array.isArray(items) ? items[0] : items?.items?.[0];

  if (!user) throw new Error('Apify não retornou dados do perfil');
  if (user.private) throw new Error('PERFIL_PRIVADO');
  if (!user.username) throw new Error('PERFIL_NAO_ENCONTRADO');

  // 4. Formata posts recentes
  const recentPosts = (user.latestPosts || []).slice(0, 9).map(p => ({
    caption:   p.caption || '',
    likes:     p.likesCount || 0,
    comments:  p.commentsCount || 0,
    isVideo:   p.type === 'Video' || p.type === 'Reel',
    timestamp: p.timestamp ? Math.floor(new Date(p.timestamp).getTime() / 1000) : 0,
  }));

  return {
    handle:     '@' + handle,
    name:       user.fullName || handle,
    bio:        user.biography || '',
    website:    user.externalUrl || '',
    followers:  user.followersCount || 0,
    following:  user.followsCount || 0,
    posts:      user.postsCount || 0,
    isVerified: user.verified || false,
    isPrivate:  user.private || false,
    profilePic: user.profilePicUrl || '',
    recentPosts,
    category:   user.businessCategoryName || '',
    isBusiness: user.isBusinessAccount || false,
    source:     'apify',
  };
}

// ─── ANTHROPIC ───────────────────────────────────────────────────────────────
function callAnthropic(apiKey, profile) {
  const blocked = profile.source === 'blocked';

  let postsContext = '';
  if (profile.recentPosts?.length > 0) {
    postsContext = '\n\nÚLTIMOS POSTS:\n' + profile.recentPosts.map((p, i) => {
      const date    = p.timestamp ? new Date(p.timestamp * 1000).toLocaleDateString('pt-BR') : '';
      const caption = p.caption ? p.caption.slice(0, 200) : '(sem legenda)';
      const eng     = (p.likes || p.comments) ? `(${p.likes} curtidas, ${p.comments} comentários)` : '';
      return `Post ${i+1}${date ? ' em ' + date : ''}${p.isVideo ? ' [Reel]' : ' [Foto]'}: "${caption}" ${eng}`;
    }).join('\n');
  }

  const engRate = profile.followers > 0 && profile.recentPosts?.length > 0
    ? ((profile.recentPosts.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0) / profile.recentPosts.length) / profile.followers * 100).toFixed(2)
    : null;

  const system = `Você é um especialista sênior em marketing digital médico com 10 anos de experiência no Brasil. Analisa perfis do Instagram com precisão clínica. Seu diagnóstico é direto, personalizado e cirúrgico. NUNCA usa frases genéricas. Responda APENAS em JSON válido. Sem markdown. Sem texto fora do JSON.`;

  const prompt = blocked
    ? `Analise o perfil médico @${profile.handle} no Instagram. Não foi possível extrair dados técnicos. Faça uma análise baseada no handle e gere recomendações estratégicas para médicos que precisam melhorar sua presença digital.\n\nRetorne exatamente este JSON:\n{"score":5.0,"scoreLabel":"Em desenvolvimento","scoreColor":"yellow","scoreTags":["Posicionamento","Consistência","CTA","Autoridade"],"attentionPoints":[{"title":"problema direto aqui","text":"2-3 frases específicas aqui"},{"title":"segundo problema","text":"explicação aqui"},{"title":"terceiro problema","text":"explicação aqui"}],"referenceProfile":{"handle":"@medico_real_brasileiro","specialty":"especialidade aqui","reason":"2 frases explicando a escolha"},"strategicAnalysis":"3-4 frases consultivas diretas aqui","quickWins":["ação concreta 1","ação concreta 2","ação concreta 3"]}`
    : `Analise este perfil de médico no Instagram:
Handle: ${profile.handle}
Nome: ${profile.name}
Bio: ${profile.bio || '(vazia)'}
Website: ${profile.website || 'nenhum'}
Seguidores: ${profile.followers.toLocaleString('pt-BR')}
Seguindo: ${profile.following.toLocaleString('pt-BR')}
Posts: ${profile.posts}
Verificado: ${profile.isVerified ? 'Sim' : 'Não'}
Business: ${profile.isBusiness ? 'Sim' : 'Não'}
Categoria: ${profile.category || 'não informada'}
${engRate ? `Engajamento estimado: ${engRate}%` : ''}
${postsContext}

Retorne exatamente este JSON:
{"score":0.0,"scoreLabel":"Em desenvolvimento","scoreColor":"yellow","scoreTags":["critério1","critério2","critério3","critério4"],"attentionPoints":[{"title":"problema direto máx 7 palavras","text":"2-3 frases específicas para este perfil"},{"title":"segundo problema","text":"explicação personalizada"},{"title":"terceiro problema","text":"explicação personalizada"}],"referenceProfile":{"handle":"@medico_real_brasileiro","specialty":"especialidade","reason":"2 frases explicando a escolha"},"strategicAnalysis":"3-4 frases consultivas diretas","quickWins":["ação concreta 1","ação concreta 2","ação concreta 3"]}`;

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

// ─── HANDLER VERCEL ──────────────────────────────────────────────────────────
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

  const apifyToken = process.env.APIFY_TOKEN;

  let profile;

  if (apifyToken) {
    try {
      profile = await fetchInstagramProfile(handle);
    } catch (e) {
      if (e.message === 'PERFIL_PRIVADO') {
        return res.status(422).json({ error: `O perfil @${handle} está privado.` });
      }
      if (e.message === 'PERFIL_NAO_ENCONTRADO') {
        return res.status(404).json({ error: `Perfil @${handle} não encontrado.` });
      }
      console.log('Apify falhou, usando fallback:', e.message);
      profile = { handle: '@' + handle, name: handle, bio: '', website: '', followers: 0, following: 0, posts: 0, isVerified: false, isPrivate: false, profilePic: '', recentPosts: [], category: '', isBusiness: false, source: 'blocked', isMock: true };
    }
  } else {
    profile = { handle: '@' + handle, name: handle, bio: '', website: '', followers: 0, following: 0, posts: 0, isVerified: false, isPrivate: false, profilePic: '', recentPosts: [], category: '', isBusiness: false, source: 'blocked', isMock: true };
  }

  try {
    const diagnosis = await callAnthropic(apiKey, profile);
    return res.status(200).json({ profile, diagnosis });
  } catch (err) {
    console.error('Erro Anthropic:', err.message);
    return res.status(500).json({ error: 'Erro ao gerar diagnóstico: ' + err.message });
  }
};
