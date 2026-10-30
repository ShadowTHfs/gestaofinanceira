// Build de produção: copia os arquivos estáticos para /dist e gera dist/env.js
// a partir das variáveis de ambiente do Vercel (Settings → Environment Variables).
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';

const OUT = 'dist';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

if (!existsSync('assets/app.css')) {
  console.error('assets/app.css não encontrado — rode "npm run build:css" antes.');
  process.exit(1);
}

cpSync('index.html', `${OUT}/index.html`);
cpSync('assets', `${OUT}/assets`, { recursive: true });
cpSync('src', `${OUT}/src`, { recursive: true, filter: (p) => !p.includes(`src/styles`) });

const env = {
  SUPABASE_URL: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
};
writeFileSync(
  `${OUT}/env.js`,
  `// Gerado automaticamente no build. Não edite.\nwindow.__ENV__ = ${JSON.stringify(env)};\n`,
);

console.log(`✔ Build pronto em /${OUT} — Supabase ${env.SUPABASE_URL ? 'CONFIGURADO' : 'não configurado (modo local)'}.`);
