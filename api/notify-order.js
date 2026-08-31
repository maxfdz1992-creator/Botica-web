// Función de servidor (Vercel Serverless Function). Corre en el backend,
// nunca en el navegador, por eso aquí sí es seguro usar la llave secreta
// de Resend (RESEND_API_KEY) sin exponerla al público.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const { order, adminEmails } = req.body || {};

    if (!order || !Array.isArray(adminEmails) || adminEmails.length === 0) {
      return res.status(200).json({ skipped: true, reason: "Sin correos administrativos configurados" });
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return res.status(200).json({ skipped: true, reason: "RESEND_API_KEY no configurada" });
    }

    const itemsList = (order.items || [])
      .map((i) => `- ${i.qty} ${i.unit} ${i.name} (${i.price} c/u)`)
      .join("\n");

    const text = [
      `Nuevo pedido de ${order.buyer?.name || "cliente"}`,
      `Correo: ${order.buyer?.email || "-"}`,
      `Teléfono: ${order.buyer?.phone || "-"}`,
      `Dirección: ${order.buyer?.address || "-"}`,
      "",
      "Productos:",
      itemsList,
      "",
      `Total: $${Number(order.total || 0).toFixed(2)}`,
    ].join("\n");

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Botica <onboarding@resend.dev>",
        to: adminEmails,
        ...(order.buyer?.email ? { reply_to: order.buyer.email } : {}),
        subject: `Nuevo pedido - ${order.buyer?.name || "cliente"}`,
        text,
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
