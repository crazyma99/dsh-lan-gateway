/**
 * The gateway's standalone login page, served for unauthenticated browser
 * navigations. Fully self-contained (inline CSS, no external requests) and
 * aware of the browser's light/dark preference. Copy is selected from the
 * Accept-Language header.
 * @module dsh-lan-gateway/login-page
 */

export const LOGIN_PATH = '/__lan_gateway_login'
export const LOGOUT_PATH = '/__lan_gateway_logout'

const ZH = {
  title: 'DeepSeek Harness',
  subtitle: '局域网访问网关',
  hint: '请输入访问凭据以继续',
  username: '用户名',
  password: '密码',
  submit: '登录',
  error: '用户名或密码错误',
  throttled: '尝试过于频繁，请稍后再试',
}

const EN = {
  title: 'DeepSeek Harness',
  subtitle: 'LAN Gateway',
  hint: 'Sign in to continue',
  username: 'Username',
  password: 'Password',
  submit: 'Sign in',
  error: 'Incorrect username or password',
  throttled: 'Too many attempts, try again later',
}

export function pickLanguage(acceptLanguage: string | undefined): 'zh' | 'en' {
  return acceptLanguage?.toLowerCase().includes('zh') === true ? 'zh' : 'en'
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** One login page document. `error` selects the failure banner copy. */
export function loginPageHtml(options: {
  lang: 'zh' | 'en'
  redirect: string
  error?: 'credentials' | 'throttled'
}): string {
  const copy = options.lang === 'zh' ? ZH : EN
  const errorText = options.error === undefined
    ? ''
    : `<p class="error" role="alert">${escapeHtml(options.error === 'credentials' ? copy.error : copy.throttled)}</p>`
  return `<!doctype html>
<html lang="${options.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(copy.title)} · ${escapeHtml(copy.subtitle)}</title>
<style>
  :root {
    --page-bg: radial-gradient(1200px 800px at 80% -10%, rgba(77,107,254,0.16), transparent 60%),
               radial-gradient(1000px 700px at -10% 110%, rgba(77,107,254,0.10), transparent 55%),
               #f5f6f8;
    --card-bg: rgba(255,255,255,0.82);
    --card-border: rgba(15,17,21,0.10);
    --text-primary: #101215;
    --text-secondary: #60646c;
    --input-bg: #ffffff;
    --input-border: rgba(15,17,21,0.16);
    --accent: #4d6bfe;
    --accent-hover: #3f5cf0;
    --button-text: #ffffff;
    --error-text: #d92d20;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page-bg: radial-gradient(1200px 800px at 80% -10%, rgba(96,165,250,0.14), transparent 60%),
                 radial-gradient(1000px 700px at -10% 110%, rgba(96,165,250,0.08), transparent 55%),
                 #101114;
      --card-bg: rgba(35,36,40,0.86);
      --card-border: rgba(255,255,255,0.10);
      --text-primary: #f2f4f7;
      --text-secondary: #a9aeb6;
      --input-bg: rgba(255,255,255,0.06);
      --input-border: rgba(255,255,255,0.14);
      --accent: #4d6bfe;
      --accent-hover: #6b84ff;
      --button-text: #ffffff;
      --error-text: #f97066;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: var(--page-bg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                 "PingFang SC", "Microsoft YaHei", sans-serif;
    color: var(--text-primary);
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: min(380px, calc(100vw - 40px));
    padding: 36px 32px 32px;
    border-radius: 20px;
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    backdrop-filter: blur(18px);
    box-shadow: 0 24px 60px rgba(10, 12, 18, 0.14);
  }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
  .mark {
    width: 38px; height: 38px; border-radius: 11px; flex-shrink: 0;
    background: linear-gradient(135deg, #4d6bfe 0%, #7c5cff 100%);
    display: flex; align-items: center; justify-content: center;
    color: #ffffff; font-size: 18px; font-weight: 700;
  }
  h1 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -0.01em; }
  .subtitle { margin: 2px 0 0; color: var(--text-secondary); font-size: 13px; }
  .hint { margin: 22px 0 16px; color: var(--text-secondary); font-size: 13px; }
  label { display: block; margin: 12px 0 4px; font-size: 12.5px; color: var(--text-secondary); }
  input {
    width: 100%; padding: 11px 13px; font-size: 14px; color: var(--text-primary);
    background: var(--input-bg);
    border: 1px solid var(--input-border); border-radius: 10px;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  button {
    width: 100%; margin-top: 20px; padding: 11px 0;
    font-size: 14.5px; font-weight: 600; color: var(--button-text);
    background: var(--accent); border: none; border-radius: 10px; cursor: pointer;
    transition: background 120ms ease, transform 80ms ease;
  }
  button:hover { background: var(--accent-hover); }
  button:active { transform: translateY(1px); }
  .error {
    margin: 14px 0 0; padding: 9px 12px; border-radius: 9px; font-size: 13px;
    color: var(--error-text);
    background: color-mix(in srgb, var(--error-text) 10%, transparent);
  }
  .footer { margin-top: 26px; text-align: center; font-size: 11.5px; color: var(--text-secondary); }
</style>
</head>
<body>
  <main class="card">
    <div class="brand">
      <div class="mark">D</div>
      <div>
        <h1>${escapeHtml(copy.title)}</h1>
        <p class="subtitle">${escapeHtml(copy.subtitle)}</p>
      </div>
    </div>
    <p class="hint">${escapeHtml(copy.hint)}</p>
    <form method="post" action="${LOGIN_PATH}" autocomplete="on">
      <input type="hidden" name="redirect" value="${escapeHtml(options.redirect)}">
      <label for="username">${escapeHtml(copy.username)}</label>
      <input id="username" name="username" type="text" required autofocus autocapitalize="off" spellcheck="false">
      <label for="password">${escapeHtml(copy.password)}</label>
      <input id="password" name="password" type="password" required>
      ${errorText}
      <button type="submit">${escapeHtml(copy.submit)}</button>
    </form>
    <p class="footer">${escapeHtml(copy.subtitle)}</p>
  </main>
</body>
</html>
`
}

/** Restrict a login redirect target to a same-origin path (no open redirect). */
export function safeRedirect(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/'
  return raw
}
