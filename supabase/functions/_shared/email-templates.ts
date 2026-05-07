interface EmailData {
  token: string
  token_hash: string
  redirect_to?: string
  email_action_type: string
  site_url: string
  token_new?: string
  token_hash_new?: string
}

interface EmailTemplate {
  subject: string
  html: string
}

function buildCtaUrl(
  site_url: string,
  token_hash: string,
  type: string,
  redirect_to?: string,
): string {
  const base = `${site_url}/auth/callback`
  const params = new URLSearchParams({ token_hash, type })
  if (redirect_to) params.set('redirect_to', redirect_to)
  return `${base}?${params.toString()}`
}

function baseTemplate(
  title: string,
  body: string,
  ctaUrl: string,
  ctaText: string,
  token: string,
): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
body{margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
.wrap{max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);}
.header{background:#09090b;padding:28px 40px;}
.header h1{margin:0;color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.3px;}
.header span{color:#52525b;font-size:14px;}
.body{padding:36px 40px;}
.body p{margin:0 0 16px;color:#3f3f46;font-size:15px;line-height:1.6;}
.cta{display:inline-block;margin:8px 0 24px;padding:13px 28px;background:#09090b;color:#fff !important;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;}
.code{display:inline-block;background:#f4f4f5;border-radius:6px;padding:10px 18px;font-size:22px;font-weight:700;letter-spacing:4px;color:#09090b;margin:4px 0 24px;}
.divider{border:none;border-top:1px solid #e4e4e7;margin:24px 0;}
.footer{padding:20px 40px;background:#fafafa;border-top:1px solid #e4e4e7;}
.footer p{margin:0;font-size:12px;color:#a1a1aa;line-height:1.6;}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1>Zapkore <span>·</span></h1>
  </div>
  <div class="body">
    <p><strong>${title}</strong></p>
    ${body}
    <a href="${ctaUrl}" class="cta">${ctaText}</a>
    <hr class="divider"/>
    <p style="font-size:13px;color:#71717a;">Ou use este código:</p>
    <div class="code">${token}</div>
    <p style="font-size:13px;color:#71717a;">Se você não realizou esta ação, ignore este e-mail.</p>
  </div>
  <div class="footer">
    <p>Zapkore · noreply@zapkore.com.br<br/>Você recebeu este e-mail pois uma ação foi realizada na sua conta.</p>
  </div>
</div>
</body>
</html>`
}

export function renderTemplate(email_data: EmailData): EmailTemplate {
  const { token, token_hash, redirect_to, email_action_type, site_url, token_hash_new } = email_data

  switch (email_action_type) {
    case 'signup': {
      const url = buildCtaUrl(site_url, token_hash, 'signup', redirect_to)
      return {
        subject: 'Confirme seu cadastro no Zapkore',
        html: baseTemplate(
          'Confirme seu e-mail para ativar sua conta',
          '<p>Clique no botão abaixo para confirmar seu endereço de e-mail e começar a usar o Zapkore.</p><p>O link expira em 24 horas.</p>',
          url,
          'Confirmar e-mail',
          token,
        ),
      }
    }

    case 'magiclink': {
      const url = buildCtaUrl(site_url, token_hash, 'magiclink', redirect_to)
      return {
        subject: 'Seu link de acesso ao Zapkore',
        html: baseTemplate(
          'Acesse sua conta',
          '<p>Use o botão abaixo para entrar na sua conta. O link é válido por 1 hora e pode ser usado apenas uma vez.</p>',
          url,
          'Entrar no Zapkore',
          token,
        ),
      }
    }

    case 'recovery': {
      const url = buildCtaUrl(site_url, token_hash, 'recovery', redirect_to)
      return {
        subject: 'Redefinir sua senha no Zapkore',
        html: baseTemplate(
          'Solicitação de redefinição de senha',
          '<p>Recebemos uma solicitação para redefinir a senha da sua conta. Clique no botão abaixo para criar uma nova senha.</p><p>O link expira em 1 hora.</p>',
          url,
          'Redefinir senha',
          token,
        ),
      }
    }

    case 'email_change_current': {
      const url = buildCtaUrl(site_url, token_hash, 'email_change', redirect_to)
      return {
        subject: 'Confirme a troca de e-mail (endereço atual)',
        html: baseTemplate(
          'Confirme no endereço atual',
          '<p>Você solicitou a troca do seu e-mail. Confirme a alteração clicando no botão abaixo.</p>',
          url,
          'Confirmar troca',
          token,
        ),
      }
    }

    case 'email_change_new': {
      const url = buildCtaUrl(site_url, token_hash_new ?? token_hash, 'email_change', redirect_to)
      return {
        subject: 'Confirme o novo e-mail no Zapkore',
        html: baseTemplate(
          'Confirme seu novo endereço',
          '<p>Confirme seu novo e-mail clicando no botão abaixo para concluir a troca.</p>',
          url,
          'Confirmar novo e-mail',
          email_data.token_new ?? token,
        ),
      }
    }

    case 'invite': {
      const url = buildCtaUrl(site_url, token_hash, 'invite', redirect_to)
      return {
        subject: 'Você foi convidado para o Zapkore',
        html: baseTemplate(
          'Acesse sua conta',
          '<p>Você foi convidado para usar o Zapkore. Clique no botão abaixo para configurar sua conta.</p>',
          url,
          'Aceitar convite',
          token,
        ),
      }
    }

    case 'reauthentication': {
      const url = buildCtaUrl(site_url, token_hash, 'reauthentication', redirect_to)
      return {
        subject: 'Confirme sua identidade no Zapkore',
        html: baseTemplate(
          'Verificação de segurança',
          '<p>Para continuar, confirme sua identidade clicando no botão abaixo ou inserindo o código.</p>',
          url,
          'Confirmar identidade',
          token,
        ),
      }
    }

    default: {
      const url = buildCtaUrl(site_url, token_hash, email_action_type, redirect_to)
      return {
        subject: 'Ação necessária na sua conta Zapkore',
        html: baseTemplate(
          'Confirme sua ação',
          '<p>Clique no botão abaixo para confirmar a ação solicitada na sua conta.</p>',
          url,
          'Confirmar',
          token,
        ),
      }
    }
  }
}
