// Función de servidor (Vercel Serverless Function). Consulta OpenStreetMap
// (Nominatim) para sugerir nombres de calles reales. A diferencia de los
// códigos postales, esto NO es una base oficial completa — la cobertura de
// calles en México varía por zona, así que esto es una ayuda/sugerencia,
// no una verificación oficial.

export default async function handler(req, res) {
  const q = (req.query?.q || "").toString().trim();
  const context = (req.query?.context || "").toString().trim();

  if (!q || q.length < 3) {
    return res.status(200).json({ results: [] });
  }

  try {
    const fullQuery = context ? `${q}, ${context}, México` : `${q}, México`;
    const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=mx&addressdetails=1&limit=6&q=${encodeURIComponent(
      fullQuery
    )}`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "BoticaApp/1.0 (https://botica-web-alpha.vercel.app)",
        "Accept-Language": "es",
      },
    });

    if (!response.ok) {
      return res.status(200).json({ results: [] });
    }

    const data = await response.json();
    const seen = new Set();
    const results = [];
    for (const item of data || []) {
      const addr = item.address || {};
      const street = addr.road || addr.pedestrian || addr.footway || addr.residential || "";
      if (!street || seen.has(street)) continue;
      seen.add(street);
      results.push({
        street,
        houseNumber: addr.house_number || "",
        neighbourhood: addr.neighbourhood || addr.suburb || "",
      });
    }

    return res.status(200).json({ results });
  } catch {
    return res.status(200).json({ results: [] });
  }
}
