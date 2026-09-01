import { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "./supabaseClient";
import { Search, Plus, Minus, Trash2, ShoppingCart, X, Package, ClipboardList, Pencil, Check, MapPin, Lock, Upload, AlertTriangle, FileText, FileSpreadsheet, TrendingUp, Calendar, User, ArrowLeft, Mail } from "lucide-react";

const UNIT_TYPES = ["tableta", "cápsula", "frasco", "caja", "ampolleta", "sobre", "tubo"];
const ADMIN_PASSWORD = "botica2026";

const SEED_INVENTORY = [
  { id: "p1", name: "Paracetamol 500mg", unit: "tableta", quantity: 240, price: 1.5 },
  { id: "p2", name: "Amoxicilina 500mg", unit: "cápsula", quantity: 120, price: 3.2 },
  { id: "p3", name: "Jarabe para la tos", unit: "frasco", quantity: 18, price: 45 },
  { id: "p4", name: "Ibuprofeno 400mg", unit: "tableta", quantity: 300, price: 1.8 },
  { id: "p5", name: "Suero oral", unit: "sobre", quantity: 60, price: 8 },
];

function currency(n) {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function matchColumn(header, keywords) {
  return keywords.some((k) => normalize(header).includes(k));
}

// Convierte una matriz de filas (header + datos, todo como texto) en medicinas.
function rowsToMedicines(rows) {
  if (rows.length < 2) throw new Error("El archivo no tiene filas de datos.");

  const header = rows[0].map((h) => String(h ?? ""));
  const colIndex = {
    name: header.findIndex((h) => matchColumn(h, ["nombre", "medicina", "producto"])),
    unit: header.findIndex((h) => matchColumn(h, ["unidad"])),
    quantity: header.findIndex((h) => matchColumn(h, ["cantidad", "existencia", "stock"])),
    price: header.findIndex((h) => matchColumn(h, ["precio", "costo"])),
  };

  const missing = Object.entries(colIndex)
    .filter(([, idx]) => idx === -1)
    .map(([key]) => ({ name: "Nombre", unit: "Unidad", quantity: "Cantidad", price: "Precio" }[key]));
  if (missing.length > 0) {
    throw new Error(`No encontramos la(s) columna(s): ${missing.join(", ")}.`);
  }

  const parsed = [];
  const errors = [];
  rows.slice(1).forEach((row, i) => {
    if (!row || row.every((c) => c === undefined || String(c).trim() === "")) return;
    const name = String(row[colIndex.name] ?? "").trim();
    const unit = normalize(row[colIndex.unit] ?? "");
    const quantityRaw = String(row[colIndex.quantity] ?? "").replace(/[^\d.-]/g, "");
    const priceRaw = String(row[colIndex.price] ?? "").replace(/[^\d.-]/g, "");
    const quantity = Number(quantityRaw);
    const price = Number(priceRaw);

    if (!name) return;
    if (Number.isNaN(quantity) || Number.isNaN(price)) {
      errors.push(`Fila ${i + 2}: "${name}" tiene cantidad o precio inválido.`);
      return;
    }
    parsed.push({ name, unit: unit || "unidad", quantity, price });
  });

  return { parsed, errors };
}

async function parseDocxTable(file) {
  const mammoth = await import("mammoth");
  const arrayBuffer = await file.arrayBuffer();
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) throw new Error("No encontramos ninguna tabla en el documento.");

  const rows = Array.from(table.querySelectorAll("tr")).map((tr) =>
    Array.from(tr.querySelectorAll("td, th")).map((cell) => cell.textContent.trim())
  );
  return rowsToMedicines(rows);
}

async function parseExcelTable(file) {
  const XLSX = await import("xlsx");
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("El archivo no tiene hojas con datos.");
  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  return rowsToMedicines(rows);
}

async function parseInventoryFile(file) {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".docx")) return parseDocxTable(file);
  if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls") || lowerName.endsWith(".csv")) {
    return parseExcelTable(file);
  }
  throw new Error("Formato no reconocido. Sube un archivo .docx, .xlsx, .xls o .csv.");
}

// Datos compartidos entre TODOS los dispositivos (inventario y pedidos),
// sincronizados en tiempo real a través de Supabase.
function useSharedList(key) {
  const [items, setItems] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const { data, error } = await supabase
        .from("kv_store")
        .select("value")
        .eq("key", key)
        .maybeSingle();
      if (!mounted) return;
      if (error) {
        console.error("Error cargando", key, error);
        setItems(null);
      } else {
        setItems(data ? data.value : null);
      }
      setReady(true);
    }
    load();

    const channel = supabase
      .channel(`kv_store_${key}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "kv_store", filter: `key=eq.${key}` },
        (payload) => {
          if (!mounted) return;
          if (payload.eventType === "DELETE") return;
          setItems(payload.new.value);
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, [key]);

  const persist = async (next) => {
    setItems(next); // actualización optimista, se ve al instante en este dispositivo
    const { error } = await supabase
      .from("kv_store")
      .upsert({ key, value: next, updated_at: new Date().toISOString() });
    if (error) console.error("Error guardando", key, error);
  };

  return [items, persist, ready];
}

// Perfil del comprador: es personal de este dispositivo/navegador, no se comparte.
function useProfile() {
  const [profile, setProfile] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("botica:perfil-comprador");
      setProfile(raw ? JSON.parse(raw) : null);
    } catch {
      setProfile(null);
    } finally {
      setReady(true);
    }
  }, []);

  const save = (data) => {
    setProfile(data);
    try {
      localStorage.setItem("botica:perfil-comprador", JSON.stringify(data));
    } catch {
      // se queda en memoria si falla el guardado
    }
  };

  return [profile, save, ready];
}

export default function BoticaApp() {
  const [view, setView] = useState("comprador");
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [showPasswordGate, setShowPasswordGate] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [pendingView, setPendingView] = useState(null);
  const [inventory, setInventory, invReady] = useSharedList("inventario");
  const [orders, setOrders, ordersReady] = useSharedList("pedidos");
  const [adminEmails, setAdminEmails, adminEmailsReady] = useSharedList("admin_emails");
  const [adminPhones, setAdminPhones, adminPhonesReady] = useSharedList("admin_phones");
  const [profile, saveProfile, profileReady] = useProfile();

  function handleProtectedClick(targetView) {
    if (adminUnlocked) setView(targetView);
    else {
      setPendingView(targetView);
      setShowPasswordGate(true);
    }
  }

  useEffect(() => {
    if (invReady && inventory === null) setInventory(SEED_INVENTORY);
  }, [invReady, inventory]);
  useEffect(() => {
    if (ordersReady && orders === null) setOrders([]);
  }, [ordersReady, orders]);
  useEffect(() => {
    if (adminEmailsReady && adminEmails === null) setAdminEmails([]);
  }, [adminEmailsReady, adminEmails]);
  useEffect(() => {
    if (adminPhonesReady && adminPhones === null) setAdminPhones([]);
  }, [adminPhonesReady, adminPhones]);

  const [pendingToken, setPendingToken] = useState(() => {
    try {
      const raw = localStorage.getItem("botica:pending-verification");
      const pending = raw ? JSON.parse(raw) : null;
      return pending?.token || null;
    } catch {
      return null;
    }
  });
  const [verifyStandalone, setVerifyStandalone] = useState(null); // null | "foreign" | "error"

  function finishLocalVerification(data) {
    let existing = null;
    try {
      const raw = localStorage.getItem("botica:perfil-comprador");
      existing = raw ? JSON.parse(raw) : null;
    } catch {
      existing = null;
    }
    saveProfile({ ...existing, name: data.name, email: data.email, emailVerified: true });
    try {
      localStorage.removeItem("botica:pending-verification");
    } catch {
      // no pasa nada si no se puede limpiar
    }
    setPendingToken(null);
    supabase.from("email_verifications").delete().eq("token", data.token || pendingToken).then(() => {});
  }

  async function checkPendingVerificationNow() {
    if (!pendingToken) return false;
    const { data } = await supabase
      .from("email_verifications")
      .select("*")
      .eq("token", pendingToken)
      .maybeSingle();
    if (data?.verified) {
      finishLocalVerification({ ...data, token: pendingToken });
      return true;
    }
    return false;
  }

  // Caso A: este mismo navegador recibió el link "?verify=TOKEN" (por ejemplo,
  // si se abre desde el mismo Safari donde ya tenías la app abierta).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("verify");
    if (!token) return;

    (async () => {
      try {
        const { data } = await supabase
          .from("email_verifications")
          .select("*")
          .eq("token", token)
          .maybeSingle();

        if (data) {
          // Avisa a quien esté esperando (esta u otra pestaña/dispositivo) que ya se confirmó.
          const { data: updated, error: updateError } = await supabase
            .from("email_verifications")
            .update({ verified: true })
            .eq("token", token)
            .select();

          if (updateError || !updated || updated.length === 0) {
            setVerifyStandalone("error");
            return;
          }

          if (pendingToken === token) {
            finishLocalVerification({ ...data, token });
          } else {
            setVerifyStandalone("foreign");
          }
        } else {
          setVerifyStandalone("error");
        }
      } catch {
        setVerifyStandalone("error");
      } finally {
        params.delete("verify");
        const newUrl = window.location.pathname + (params.toString() ? `?${params}` : "");
        window.history.replaceState({}, "", newUrl);
      }
    })();
  }, []);

  // Caso B (el más común en celular): el botón del correo se abrió en Safari
  // normal, aparte de esta app instalada. Aquí nos quedamos escuchando en
  // tiempo real, y ADEMÁS volvemos a preguntar cada vez que esta app regresa
  // a primer plano — en el celular, la conexión en vivo se corta cuando la
  // app pasa a segundo plano (por ejemplo, al abrir Correo) y no siempre se
  // reconecta sola.
  useEffect(() => {
    if (!pendingToken) return;
    let cancelled = false;

    async function checkNow() {
      const { data } = await supabase
        .from("email_verifications")
        .select("*")
        .eq("token", pendingToken)
        .maybeSingle();
      if (!cancelled && data?.verified) finishLocalVerification({ ...data, token: pendingToken });
    }

    checkNow();

    function handleForeground() {
      if (document.visibilityState === "visible") checkNow();
    }
    document.addEventListener("visibilitychange", handleForeground);
    window.addEventListener("focus", handleForeground);

    const channel = supabase
      .channel(`email_verifications_${pendingToken}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "email_verifications", filter: `token=eq.${pendingToken}` },
        (payload) => {
          if (payload.new?.verified) finishLocalVerification({ ...payload.new, token: pendingToken });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleForeground);
      window.removeEventListener("focus", handleForeground);
      supabase.removeChannel(channel);
    };
  }, [pendingToken]);

  const [cart, setCart] = useState({});
  const [search, setSearch] = useState("");
  const [orderPlaced, setOrderPlaced] = useState(null);

  const list = inventory || [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) => p.name.toLowerCase().includes(q));
  }, [list, search]);

  const cartItems = Object.entries(cart)
    .map(([id, qty]) => {
      const product = list.find((p) => p.id === id);
      return product ? { ...product, qty } : null;
    })
    .filter(Boolean);

  const cartTotal = cartItems.reduce((sum, i) => sum + i.qty * i.price, 0);
  const cartCount = cartItems.reduce((sum, i) => sum + i.qty, 0);

  function addToCart(product, delta) {
    setCart((prev) => {
      const current = prev[product.id] || 0;
      const max = product.quantity;
      const next = Math.max(0, Math.min(max, current + delta));
      const copy = { ...prev };
      if (next === 0) delete copy[product.id];
      else copy[product.id] = next;
      return copy;
    });
  }

  function removeFromCart(product) {
    setCart((prev) => {
      const copy = { ...prev };
      delete copy[product.id];
      return copy;
    });
  }

  function confirmOrder(buyer, shouldSaveProfile) {
    const order = {
      id: "ord_" + Date.now(),
      buyer,
      items: cartItems.map(({ id, name, unit, qty, price }) => ({ id, name, unit, qty, price })),
      total: cartTotal,
      date: new Date().toISOString(),
    };
    setOrders([order, ...(orders || [])]);
    setInventory(
      list.map((p) => {
        const bought = cart[p.id];
        return bought ? { ...p, quantity: p.quantity - bought } : p;
      })
    );
    if (shouldSaveProfile) saveProfile({ ...profile, ...buyer });
    setCart({});
    setView("comprador");
    setOrderPlaced(order);

    // Aviso a los correos administrativos. Si falla (o no hay backend de
    // correo configurado), el pedido ya quedó guardado de todos modos.
    fetch("/api/notify-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order, adminEmails: adminEmails || [] }),
    }).catch(() => {});
  }

  if (verifyStandalone === "foreign") {
    return (
      <div className="min-h-screen bg-[#F7F6F2] flex items-center justify-center px-5 text-center">
        <div className="max-w-xs">
          <div className="w-12 h-12 rounded-full bg-[#0F3A34] text-white flex items-center justify-center mx-auto mb-4">
            <Check size={22} />
          </div>
          <div className="font-semibold text-[16px] mb-2">Correo confirmado</div>
          <p className="text-sm text-[#8A8578]">
            Ya puedes regresar a la app de Botica — ahí debería aparecer que ya iniciaste sesión, sin
            necesidad de hacer nada más aquí.
          </p>
        </div>
      </div>
    );
  }

  if (verifyStandalone === "error") {
    return (
      <div className="min-h-screen bg-[#F7F6F2] flex items-center justify-center px-5 text-center">
        <div className="max-w-xs">
          <div className="w-12 h-12 rounded-full bg-[#B3462C] text-white flex items-center justify-center mx-auto mb-4">
            <AlertTriangle size={20} />
          </div>
          <div className="font-semibold text-[16px] mb-2">Este enlace ya no es válido</div>
          <p className="text-sm text-[#8A8578]">
            Puede que ya se haya usado antes, o que haya pasado mucho tiempo. Regresa a la app e intenta
            iniciar sesión de nuevo desde "Mi perfil".
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F6F2] text-[#1E2321] font-sans">
      <header className="sticky top-0 z-30 border-b border-[#D8D3C7] bg-[#0F3A34] text-[#F7F6F2]">
        <div className="max-w-5xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="flex items-center gap-2.5 text-left"
            >
              <div className="w-8 h-8 rounded-md bg-[#E8846B] flex items-center justify-center shrink-0">
                <Package size={18} className="text-[#0F3A34]" />
              </div>
              <div>
                <div className="text-[15px] leading-tight font-semibold">Botica</div>
                <div className="text-[11px] leading-tight text-[#B9CFC8]">Inventario y ventas</div>
              </div>
            </button>
            <button
              onClick={() => setShowProfileModal(true)}
              className="w-9 h-9 rounded-full bg-[#0B2C27] flex items-center justify-center hover:bg-[#123f38] transition-colors shrink-0"
              title="Mi perfil"
            >
              <User size={16} />
            </button>
          </div>
          <div className="flex items-center gap-1 bg-[#0B2C27] rounded-lg p-1 overflow-x-auto">
            <button
              onClick={() => setView("comprador")}
              className={`shrink-0 whitespace-nowrap px-3 py-1.5 text-sm rounded-md transition-colors ${
                view === "comprador" ? "bg-[#F7F6F2] text-[#0F3A34]" : "text-[#B9CFC8] hover:text-white"
              }`}
            >
              Inventario
            </button>
            <button
              onClick={() => setView("carrito")}
              className={`relative shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${
                view === "carrito" ? "bg-[#F7F6F2] text-[#0F3A34]" : "text-[#B9CFC8] hover:text-white"
              }`}
            >
              <ShoppingCart size={13} />
              Carrito
              {cartCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[#E8846B] text-[#0F3A34] text-[10px] font-bold flex items-center justify-center">
                  {cartCount}
                </span>
              )}
            </button>
            <button
              onClick={() => handleProtectedClick("admin")}
              className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${
                view === "admin" ? "bg-[#F7F6F2] text-[#0F3A34]" : "text-[#B9CFC8] hover:text-white"
              }`}
            >
              {!adminUnlocked && <Lock size={12} />}
              Administrador
            </button>
            <button
              onClick={() => handleProtectedClick("resultados")}
              className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${
                view === "resultados" ? "bg-[#F7F6F2] text-[#0F3A34]" : "text-[#B9CFC8] hover:text-white"
              }`}
            >
              {!adminUnlocked && <Lock size={12} />}
              Resultados
            </button>
          </div>
        </div>
      </header>

      {view === "comprador" ? (
        <BuyerView
          list={filtered}
          allLoaded={invReady}
          search={search}
          setSearch={setSearch}
          cart={cart}
          addToCart={addToCart}
          removeFromCart={removeFromCart}
        />
      ) : view === "carrito" ? (
        <CartView
          items={cartItems}
          total={cartTotal}
          onChangeQty={addToCart}
          onRemove={removeFromCart}
          onBackToShop={() => setView("comprador")}
          onCheckout={() => setView("checkout")}
        />
      ) : view === "checkout" ? (
        <CheckoutView
          total={cartTotal}
          items={cartItems}
          profile={profile}
          profileReady={profileReady}
          onBack={() => setView("carrito")}
          onConfirm={confirmOrder}
        />
      ) : view === "admin" ? (
        <AdminView
          list={filtered}
          fullList={list}
          allLoaded={invReady}
          search={search}
          setSearch={setSearch}
          setInventory={setInventory}
          orders={orders || []}
          adminEmails={adminEmails || []}
          setAdminEmails={setAdminEmails}
          onLogout={() => {
            setAdminUnlocked(false);
            setView("comprador");
          }}
        />
      ) : (
        <ResultsView
          orders={orders || []}
          onLogout={() => {
            setAdminUnlocked(false);
            setView("comprador");
          }}
        />
      )}

      {orderPlaced && (
        <OrderConfirmed order={orderPlaced} onClose={() => setOrderPlaced(null)} />
      )}

      {showPasswordGate && (
        <PasswordGate
          onClose={() => setShowPasswordGate(false)}
          onSuccess={() => {
            setAdminUnlocked(true);
            setShowPasswordGate(false);
            setView(pendingView || "admin");
          }}
        />
      )}

      {showProfileModal && (
        <ProfileModal
          profile={profile}
          profileReady={profileReady}
          onClose={() => setShowProfileModal(false)}
          onSave={(data) => {
            saveProfile({ ...profile, ...data });
            setShowProfileModal(false);
          }}
          onLogout={() => saveProfile(null)}
          onVerificationSent={setPendingToken}
          onCheckNow={checkPendingVerificationNow}
        />
      )}
    </div>
  );
}

