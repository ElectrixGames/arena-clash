// This old site has moved to Bluu! Everyone who visits gets sent to the game's new home.
// The same file works for both old sites: it checks which address people typed.
const http = require('http');
const BLUU = 'https://bluucalc.onrender.com';

http.createServer((req, res) => {
  const host = String(req.headers.host || '');
  const game = host.includes('lightning') ? '/lightning-duels' : '/arena-clash';
  res.writeHead(301, { Location: BLUU + game, 'Cache-Control': 'no-cache' });
  res.end('This game moved to Bluu: ' + BLUU + game);
}).listen(process.env.PORT || 3000, () => console.log('Redirecting everyone to Bluu'));
