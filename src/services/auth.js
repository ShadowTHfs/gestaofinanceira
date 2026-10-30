// =============================================================================
// AUTENTICAÇÃO (Supabase Auth — e-mail e senha)
// Só funciona quando o Supabase está configurado (ver env.js / Vercel).
// =============================================================================
import { getSupabase } from './supabaseClient.js';
import { CONFIG } from '../config.js';

const client = () => {
  const c = getSupabase();
  if (!c) throw new Error('Supabase não está configurado.');
  return c;
};

/** Traduz as mensagens do Supabase Auth para português. */
export function authErrorMessage(error) {
  const m = (error?.message || String(error || '')).toLowerCase();
  if (m.includes('invalid login credentials')) return 'E-mail ou senha incorretos.';
  if (m.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar — veja a mensagem que enviamos para sua caixa de entrada.';
  if (m.includes('user already registered') || m.includes('already been registered')) return 'Este e-mail já tem cadastro. Use "Entrar".';
  if (m.includes('password should be at least') || m.includes('weak password')) return 'A senha precisa ter pelo menos 6 caracteres (use letras e números).';
  if (m.includes('unable to validate email') || m.includes('invalid format') || m.includes('email address') && m.includes('invalid')) return 'E-mail inválido.';
  if (m.includes('rate limit') || m.includes('too many') || m.includes('security purposes')) return 'Muitas tentativas. Aguarde um minuto e tente de novo.';
  if (m.includes('signups not allowed')) return 'Novos cadastros estão desativados neste projeto.';
  if (m.includes('same password') || m.includes('different from the old')) return 'A nova senha precisa ser diferente da atual.';
  if (m.includes('failed to fetch') || m.includes('network')) return 'Sem conexão com o servidor. Verifique sua internet.';
  if (m.includes('provider is not enabled') || m.includes('unsupported provider')) return 'O login com Google ainda não está ativado no Supabase (Authentication → Sign In / Providers → Google).';
  if (m.includes('access_denied') || m.includes('access denied')) return 'Login com Google cancelado.';
  if (m.includes('redirect') && m.includes('not allowed')) return 'Endereço de retorno não autorizado: adicione o site em Authentication → URL Configuration → Redirect URLs.';
  return 'Não foi possível concluir. Tente novamente.';
}

export async function getCurrentUser() {
  const { data } = await client().auth.getSession();
  return data?.session?.user ?? null;
}

/** callback(event, user) — eventos: SIGNED_IN, SIGNED_OUT, PASSWORD_RECOVERY, TOKEN_REFRESHED, USER_UPDATED, INITIAL_SESSION */
export function onAuthChange(callback) {
  const { data } = client().auth.onAuthStateChange((event, session) => {
    // Não fazer chamadas ao Supabase dentro deste callback (recomendação oficial):
    setTimeout(() => callback(event, session?.user ?? null), 0);
  });
  return () => data.subscription.unsubscribe();
}

export async function signIn(email, password) {
  const { data, error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

/** Retorna { user, needsConfirmation } */
export async function signUp(email, password) {
  const { data, error } = await client().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
  // Com "Confirm email" ligado no Supabase, não vem sessão: precisa confirmar.
  // Se o e-mail já existir, o Supabase devolve um usuário sem identidades.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error('User already registered');
  }
  return { user: data.user, needsConfirmation: !data.session };
}

export async function sendPasswordReset(email) {
  const { error } = await client().auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if (error) throw error;
}

export async function updatePassword(password) {
  const { error } = await client().auth.updateUser({ password });
  if (error) throw error;
}

/** Quais logins sociais estão ativos no projeto (endpoint público do Supabase). */
export async function getEnabledProviders() {
  try {
    const res = await fetch(`${CONFIG.supabaseUrl}/auth/v1/settings`, { headers: { apikey: CONFIG.supabaseAnonKey } });
    if (!res.ok) return {};
    const data = await res.json();
    return data?.external || {};
  } catch {
    return {};
  }
}

/** Redireciona para o Google; ao voltar, a sessão é detectada automaticamente. */
export async function signInWithGoogle() {
  const { error } = await client().auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin, queryParams: { prompt: 'select_account' } },
  });
  if (error) throw error;
}

/** Erro devolvido na URL depois de voltar do Google (ex.: cancelou). Limpa a URL. */
export function consumeAuthErrorFromUrl() {
  const params = new URLSearchParams(`${window.location.search.slice(1)}&${window.location.hash.slice(1)}`);
  const desc = params.get('error_description') || params.get('error');
  if (!desc) return null;
  window.history.replaceState({}, document.title, window.location.pathname);
  return desc.replace(/\+/g, ' ');
}

export async function signOut() {
  const { error } = await client().auth.signOut();
  if (error) throw error;
}
