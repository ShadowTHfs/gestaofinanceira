// =============================================================================
// Configuração central do app.
// As chaves do Supabase vêm de `window.__ENV__`, definido no arquivo /env.js.
//  - Localmente: /env.js (raiz) vem vazio → o app usa localStorage.
//  - No Vercel: o build (scripts/build.mjs) gera dist/env.js a partir das
//    variáveis de ambiente SUPABASE_URL e SUPABASE_ANON_KEY.
// A ANON KEY é pública por natureza (a segurança vem do RLS no banco).
// NUNCA coloque a service_role key aqui.
// =============================================================================

const env = (typeof window !== 'undefined' && window.__ENV__) || {};

export const CONFIG = Object.freeze({
  appName: 'Finanças',
  supabaseUrl: (env.SUPABASE_URL || '').trim(),
  supabaseAnonKey: (env.SUPABASE_ANON_KEY || '').trim(),
  // Cliente oficial carregado sob demanda (só quando as chaves existirem).
  supabaseClientUrl: 'https://esm.sh/@supabase/supabase-js@2',
  storagePrefix: 'gf.v2.',
  locale: 'pt-BR',
  currency: 'BRL',
});

export const isSupabaseConfigured = () => Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
