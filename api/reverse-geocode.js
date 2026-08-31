// Función de servidor (Vercel Serverless Function). Convierte coordenadas
// (lat/lon) en una dirección aproximada usando OpenStreetMap (Nominatim).
// Igual que con las calles: es una ayuda, no una base de datos oficial.

export default async function handler(req, res) {
  const lat = req.query?.lat;
  const lon = req.query?.lon;

  if (!lat || !lon) {
    return res.status(200).json({ result: null });
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lon)}&addressdetails=1`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "BoticaApp/1.0 (https://botica-web-alpha.vercel.app)",
        "Accept-Language": "es",
      },
    });

    if (!response.ok) {
      return res.status(200).json({ result: null });
    }

    const data = await response.json();
    const addr = data.address || {};

    const result = {
      street: addr.road || addr.pedestrian || addr.residential || "",
      houseNumber: addr.house_number || "",
      colonia: addr.neighbourhood || addr.suburb || addr.quarter || "",
      municipio: addr.county || addr.city_district || addr.town || addr.city || addr.municipality || "",
      estado: addr.state || "",
      cp: addr.postcode || "",
      displayName: data.display_name || "",
    };

    return res.status(200).json({ result });
  } catch {
    return res.status(200).json({ result: null });
  }
}
