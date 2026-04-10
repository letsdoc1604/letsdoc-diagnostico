export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { texto } = req.body;
  if (!texto || texto.trim().length < 20) {
    return res.status(400).json({ error: 'Texto muito curto.' });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });
  }

  const prompt = `Você é um extrator de dados de diagnósticos de Instagram médicos.
Analise o texto abaixo — gerado por uma análise detalhada de um perfil do Instagram — e extraia TODOS os dados estruturados possíveis.

O texto pode seguir este formato estruturado:
- PERFIL: handle | nome | especialidade | cidade
- SEGUIDORES: número | POSTS: número
- NOTAS (1-10) para dimensões como: Foto de perfil, Nome e @, Bio, Link e CTA, Destaques, Feed, Qualidade dos Reels, Legendas, Engajamento, SEO do Instagram
- NOTA GERAL: 0-100 | FASE: iniciante/em crescimento/consolidado/autoridade
- TOP 5 PROBLEMAS ordenados por impacto
- TOP 3 PONTOS FORTES
- POSICIONAMENTO ATUAL e IDEAL
- ESTIMATIVA DE ALCANCE PERDIDO

TEXTO DA ANÁLISE:
"""
${texto}
"""

Responda APENAS com JSON válido, sem markdown. Use null para campos não encontrados. Arrays vazios [] quando não houver itens.

{
  "handle": "string ou null",
  "nome": "string ou null",
  "especialidade": "string ou null",
  "cidade": "string ou null",
  "seguidores": "number ou null",
  "posts_total": "number ou null",
  "bio_atual": "string ou null",
  "tem_link_bio": "boolean ou null",
  "tem_crm": "boolean ou null",
  "tem_cta": "boolean ou null",
  "ultima_publicacao": "string ou null",
  "frequencia_atual": "string ou null — ex: '3x/mês', 'diário', 'irregular'",
  "usa_reels": "boolean ou null",
  "nota_geral": "number ou null — 0 a 100",
  "fase": "string ou null — iniciante/em crescimento/consolidado/autoridade",
  "alcance_perdido": "string ou null — ex: '70%', '~60%'",
  "notas": {
    "Foto de perfil": "number ou null",
    "Nome e @": "number ou null",
    "Bio": "number ou null",
    "Link e CTA": "number ou null",
    "Destaques": "number ou null",
    "Feed": "number ou null",
    "Qualidade dos Reels": "number ou null",
    "Legendas": "number ou null",
    "Engajamento": "number ou null",
    "SEO do Instagram": "number ou null"
  },
  "comentarios_notas": {
    "Foto de perfil": "string ou null — comentário da nota",
    "Nome e @": "string ou null",
    "Bio": "string ou null",
    "Link e CTA": "string ou null",
    "Destaques": "string ou null",
    "Feed": "string ou null",
    "Qualidade dos Reels": "string ou null",
    "Legendas": "string ou null",
    "Engajamento": "string ou null",
    "SEO do Instagram": "string ou null"
  },
  "problemas": [
    { "titulo": "string", "descricao": "string", "impacto": "alto/medio/baixo" }
  ],
  "pontos_fortes": [
    { "titulo": "string", "descricao": "string" }
  ],
  "posicionamento_atual": "string ou null",
  "posicionamento_ideal": "string ou null",
  "observacoes": "string ou null"
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', response.status, err);
      return res.status(500).json({ error: 'Erro ao processar análise.' });
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || '{}';

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(500).json({ error: 'Não foi possível extrair dados. Tente colar mais texto.' });
    }

    return res.status(200).json({ success: true, dados: parsed });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
}
