import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Serve static files from root directory
app.use(express.static(__dirname));

// Mirror the Vercel serverless function locally, so food search behaves the
// same in `npm run dev` as it does in production. Must be registered before
// the catch-all below, or it would be answered with index.html.
app.get('/api/off-search', async (req, res) => {
  const { default: offSearch } = await import('./api/off-search.js');
  return offSearch(req, res);
});

// Photo payloads are base64 and run well past Express's default 100kb limit.
// Registered for every method (not just POST) so a stray GET gets the same 405
// here as it would from the Vercel function, rather than falling through to the
// SPA catch-all below.
app.all('/api/gemini', express.json({ limit: '8mb' }), async (req, res) => {
  const { default: gemini } = await import('./api/gemini.js');
  return gemini(req, res);
});

// Fallback to index.html for client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
