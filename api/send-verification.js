// Función de servidor (Vercel Serverless Function). Manda el correo real de
// confirmación de cuenta usando Resend, con un botón que lleva de vuelta a
// la app para terminar de iniciar sesión.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const { name, email, token, appUrl } = req.body || {};

    if (!email || !token || !appUrl) {
      return res.status(400).json({ error: "Faltan datos (email, token o appUrl)" });
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return res.status(200).json({ skipped: true, reason: "RESEND_API_KEY no configurada" });
    }

    const confirmUrl = `${appUrl}?verify=${encodeURIComponent(token)}`;

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color:#0F3A34; margin-bottom: 8px;">Confirma tu correo</h2>
        <p style="color:#1E2321;">Hola ${name || ""},</p>
        <p style="color:#1E2321;">
          Para continuar e iniciar sesión en Botica, confirma tu correo con el botón de abajo.
        </p>
        <p style="text-align:center; margin: 32px 0;">
          <a href="${confirmUrl}"
             style="background:#0F3A34; color:#ffffff; padding:12px 28px; border-radius:8px;
                    text-decoration:none; font-weight:bold; display:inline-block;">
            Confirmar
          </a>
        </p>
        <p style="color:#8A8578; font-size:12px;">
          Si tú no solicitaste esto, puedes ignorar este correo.
        </p>
      </div>
    `;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Botica <onboarding@resend.dev>",
        to: [email],
        subject: "Confirma tu correo - Botica",
        html,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      return res.status(502).json({ error: "Resend rechazó el envío", detail });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
