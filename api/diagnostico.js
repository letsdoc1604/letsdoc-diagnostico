export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ error: 'Username é obrigatório' });
  }

  // Remove @ se vier com ele
  const handle = username.replace('@', '').trim();

  const AUTH_ID = process.env.HYPEAUDITOR_AUTH_ID;
  const AUTH_TOKEN = process.env.HYPEAUDITOR_AUTH_TOKEN;

  // Se não tiver chaves configuradas, retorna dados de demonstração
  if (!AUTH_ID || !AUTH_TOKEN) {
    return res.status(200).json({
      demo: true,
      user: {
        username: handle,
        full_name: handle,
        followers_count: 0,
        posts_count: 0,
        avg_likes: 0,
        avg_comments: 0,
        aqs: 0,
        aqs_name: 'N/A',
        er: 0,
        about: '',
        photo_url: null,
      },
      audience: {
        credibility: 0,
        notable_users_pct: 0,
        real_pct: 0,
        suspicious_pct: 0,
        mass_followers_pct: 0,
      },
      growth: {
        followers_30d: 0,
        followers_90d: 0,
      },
      content: {
        avg_reels_views: 0,
        reels_pct: 0,
        carousels_pct: 0,
        photos_pct: 0,
      },
      message: 'Configure HYPEAUDITOR_AUTH_ID e HYPEAUDITOR_AUTH_TOKEN nas variáveis de ambiente do Vercel para usar dados reais.'
    });
  }

  try {
    // Chamada para HypeAuditor API v2
    const response = await fetch(
      `https://hypeauditor.com/api/method/auditor.report?username=${handle}&v=2`,
      {
        headers: {
          'x-auth-id': AUTH_ID,
          'x-auth-token': AUTH_TOKEN,
        },
      }
    );

    // 202 = relatório sendo gerado, tenta de novo em alguns segundos
    if (response.status === 202) {
      const data = await response.json();
      return res.status(202).json({
        retry: true,
        retryAfter: data?.result?.retryTtl || 5,
        message: 'Relatório sendo gerado, tente novamente em instantes.',
      });
    }

    if (!response.ok) {
      const err = await response.text();
      console.error('HypeAuditor error:', response.status, err);

      if (response.status === 403) {
        return res.status(403).json({ error: 'Perfil privado ou sem posts suficientes.' });
      }
      if (response.status === 402) {
        return res.status(402).json({ error: 'Créditos HypeAuditor esgotados.' });
      }

      return res.status(response.status).json({ error: 'Erro ao buscar dados do perfil.' });
    }

    const raw = await response.json();
    const r = raw?.result;

    if (!r || r.report_state !== 'READY') {
      return res.status(202).json({ retry: true, retryAfter: 5 });
    }

    const u = r.user || {};
    const audience = r.audience || {};
    const media = r.media || {};
    const growth = r.subscribers_growth || {};

    // Monta resposta limpa com os campos que usamos
    const payload = {
      demo: false,
      user: {
        username: u.username || handle,
        full_name: u.full_name || handle,
        followers_count: u.followers_count || 0,
        posts_count: u.posts_count || 0,
        avg_likes: u.avg_likes || 0,
        avg_comments: u.avg_comments || 0,
        aqs: u.aqs || 0,
        aqs_name: u.aqs_name || 'N/A',
        er: u.er || 0,
        about: u.about || '',
        photo_url: u.photo_url || null,
      },
      audience: {
        credibility: audience.credibility || 0,
        real_pct: audience.real_pct || 0,
        suspicious_pct: audience.suspicious_pct || 0,
        mass_followers_pct: audience.mass_followers_pct || 0,
        notable_users_pct: audience.notable_users_pct || 0,
      },
      growth: {
        followers_30d: growth['30d'] || 0,
        followers_90d: growth['90d'] || 0,
      },
      content: {
        avg_reels_views: media.avg_video_views || 0,
        reels_pct: media.reels_pct || 0,
        carousels_pct: media.carousel_pct || 0,
        photos_pct: media.image_pct || 0,
      },
    };

    return res.status(200).json(payload);

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}
