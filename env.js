// Configuração pública de ambiente.
// Localmente fica vazio → o app usa o armazenamento do navegador (localStorage).
// No Vercel este arquivo é REGERADO no build (scripts/build.mjs) com as
// variáveis SUPABASE_URL e SUPABASE_ANON_KEY do painel do Vercel.
// Nunca coloque aqui a "service_role key".
window.__ENV__ = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' };
