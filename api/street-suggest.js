// Función de servidor (Vercel Serverless Function). Consulta la base pública
// de códigos postales de México (Sepomex) y regresa colonia, municipio y
// estado ya verificados. La usamos como intermediario para evitar problemas
// de CORS al llamarla directo desde el navegador.

export default async function handler(req, res) {
  const q = (req.query?.q || "").toString().replace(/\D/g, "").slice(0, 5);

  if (!q || q.length < 2) {
    return res.status(200).json({ results: [] });
  }

  try {
    const response = await fetch(
      `https://sepomex.icalialabs.com/api/v1/zip_codes?zip_code=${encodeURIComponent(q)}`
    );

    if (!response.ok) {
      return res.status(200).json({ results: [] });
    }

    const data = await response.json();
    const results = (data.zip_codes || []).map((z) => ({
      cp: z.d_codigo || z.d_cp || "",
      colonia: z.d_asenta || "",
      municipio: z.d_mnpio || "",
      estado: z.d_estado || "",
      ciudad: z.d_ciudad || "",
    }));

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(200).json({ results: [] });
  }
}
