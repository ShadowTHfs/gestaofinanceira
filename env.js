// Configuração pública de ambiente.
// Localmente fica vazio → o app usa o armazenamento do navegador (localStorage).
// No Vercel este arquivo é REGERADO no build (scripts/build.mjs) com as
// variáveis SUPABASE_URL e SUPABASE_ANON_KEY do painel do Vercel.
// Nunca coloque aqui a "service_role key".
window.__ENV__ = { SUPABASE_URL: 'https://ltitnugobvghjgvsghoy.supabase.co', SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0aXRudWdvYnZnaGpndnNnaG95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzNzk5NjMsImV4cCI6MjEwODk1NTk2M30.uKOVu_GSBcX6ZrKy0Jx2Av4JFCpQASynlvoKIAuNi98' };
