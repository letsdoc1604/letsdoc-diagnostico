export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { texto } = req.body;
  if (!texto || texto.trim().length < 20) {
    return res.status(400).json({ error: 'Texto muito curto. Cole a análise completa do Claude Chrome.' });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });
  }

  const prompt = `Você é um extrator de dados de perfis do Instagram médicos. 
Analise o texto abaixo — que é uma análise feita pelo Claude navegando num perfil do Instagram — e extraia todos os dados estruturados que conseguir encontrar.

TEXTO DA ANÁLISE:
"""
${texto}
"""

Responda APENAS com um JSON válido, sem markdown, sem texto antes ou depois. Use null para campos não encontrados.

{
  "handle": "string ou null — @username do perfil",
  "nome": "string ou null — nome completo do médico",
  "especialidade": "string ou null — especialidade médica",
  "cidade": "string ou null — cidade onde atua",
  "seguidores": "number ou null — número de seguidores",
  "seguindo": "number ou null — número de contas que segue",
  "posts_total": "number ou null — total de publicações",
  "bio": "string ou null — texto da bio completo",
  "tem_link_bio": "boolean ou null — se tem link na bio",
  "tem_crm": "boolean ou null — se CRM aparece na bio",
  "tem_cta_agendamento": "boolean ou null — se tem CTA para agendamento",
  "ultima_publicacao": "string ou null — quando foi a última publicação (ex: '3 dias atrás', '2 semanas')",
  "frequencia_posts": "string ou null — frequência percebida (ex: 'diário', 'semanal', 'irregular')",
  "usa_reels": "boolean ou null — se usa reels",
  "usa_carrossel": "boolean ou null — se usa carrosséis",
  "identidade_visual": "string ou null — 'consistente', 'inconsistente' ou 'sem padrão'",
  "tom_conteudo": "string ou null — tom do conteúdo (ex: 'educativo', 'institucional', 'pessoal')",
  "qualidade_foto": "string ou null — 'alta', 'média' ou 'baixa'",
  "engajamento_estimado": "string ou null — avaliação do engajamento observado",
  "pontos_fortes": ["array de strings com pontos positivos encontrados"],
  "pontos_fracos": ["array de strings com pontos negativos encontrados"],
  "observacoes": "string ou null — outras observações relevantes do texto"
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
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(500).json({ error: 'Erro ao processar análise.' });
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || '{}';

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(500).json({ error: 'Não foi possível extrair dados estruturados. Tente colar mais texto.' });
    }

    return res.status(200).json({ success: true, dados: parsed });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
}
