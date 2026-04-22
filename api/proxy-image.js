const https = require('https');
const http = require('http');

module.exports = async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end('missing url');

  const decoded = decodeURIComponent(url);
  if (!decoded.startsWith('http')) return res.status(400).end('invalid url');

  const client = decoded.startsWith('https') ? https : http;

  client.get(decoded, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      'Referer': 'https://www.instagram.com/',
    },
    timeout: 8000,
  }, (imgRes) => {
    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    imgRes.pipe(res);
  }).on('error', () => res.status(500).end('error'));
};
