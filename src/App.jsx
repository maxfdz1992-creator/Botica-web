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

function PasswordGate({ onClose, onSuccess }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  function submit() {
    if (value === ADMIN_PASSWORD) onSuccess();
    else setError(true);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-[#F7F6F2] rounded-xl max-w-xs w-full p-5 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold flex items-center gap-1.5">
            <Lock size={15} /> Acceso administrador
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[#EDEAE1] rounded">
            <X size={16} />
          </button>
        </div>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Contraseña"
          className={`w-full px-3 py-2 rounded-lg border text-sm mb-1 focus:outline-none focus:ring-2 ${
            error ? "border-[#B3462C] focus:ring-[#B3462C]/30" : "border-[#D8D3C7] focus:ring-[#0F3A34]/30"
          }`}
        />
        {error && <div className="text-[12px] text-[#B3462C] mb-2">Contraseña incorrecta.</div>}
        <button
          onClick={submit}
          className="w-full mt-2 py-2.5 rounded-lg bg-[#0F3A34] text-white text-sm font-medium hover:bg-[#0B2C27]"
        >
          Entrar
        </button>
      </div>
    </div>
  );
}

function SentScreen({ email, onClose, onCheckNow }) {
  const [checking, setChecking] = useState(false);
  const [notYet, setNotYet] = useState(false);

  async function handleCheckNow() {
    setChecking(true);
    setNotYet(false);
    try {
      const confirmed = await onCheckNow?.();
      if (!confirmed) setNotYet(true);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-[#F7F6F2] rounded-xl max-w-xs w-full p-5 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold flex items-center gap-1.5">
            <Mail size={15} /> Revisa tu correo
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[#EDEAE1] rounded">
            <X size={16} />
          </button>
        </div>
        <div className="border border-[#D8D3C7] rounded-lg bg-white p-4 mb-3 text-sm">
          Te mandamos un correo a <strong>{email}</strong> con un botón para confirmar. Tócalo desde tu
          correo — normalmente esta app detecta la confirmación sola.
        </div>
        <button
          onClick={handleCheckNow}
          disabled={checking}
          className="w-full py-2.5 rounded-lg bg-[#0F3A34] text-white text-sm font-medium hover:bg-[#0B2C27] disabled:opacity-50 mb-2"
        >
          {checking ? "Revisando..." : "Ya confirmé, revisar ahora"}
        </button>
        {notYet && (
          <p className="text-[12px] text-[#B3462C] mb-2">
            Todavía no vemos la confirmación. Si ya tocaste el botón del correo, espera unos segundos y
            vuelve a intentar.
          </p>
        )}
        <p className="text-[11px] text-[#8A8578]">Si no lo ves en unos minutos, revisa la carpeta de spam.</p>
      </div>
    </div>
  );
}

function ProfileModal({ profile, profileReady, onClose, onSave, onLogout, onVerificationSent, onCheckNow }) {
  const [step, setStep] = useState("form"); // form | sending | sent | error
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [prefilled, setPrefilled] = useState(false);
  const [editing, setEditing] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (profileReady && profile && !prefilled) {
      setName(profile.name || "");
      setEmail(profile.email || "");
      setPrefilled(true);
    }
  }, [profileReady, profile, prefilled]);

  const canSave = name.trim() && email.trim();
  const isLoggedIn = profileReady && profile?.emailVerified && !editing;

  async function sendConfirmationEmail() {
    setStep("sending");
    setErrorMsg("");
    try {
      const token =
        crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const { error: insertError } = await supabase
        .from("email_verifications")
        .insert({ token, name: name.trim(), email: email.trim().toLowerCase() });
      if (insertError) throw insertError;

      const response = await fetch("/api/send-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          token,
          appUrl: window.location.origin,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "No se pudo enviar el correo");
      if (data?.skipped) throw new Error(data.reason || "El envío de correos no está configurado");

      try {
        localStorage.setItem(
          "botica:pending-verification",
          JSON.stringify({ token, name: name.trim(), email: email.trim().toLowerCase() })
        );
      } catch {
        // si no se puede guardar, la confirmación seguirá funcionando si se
        // abre el correo desde el mismo navegador/pestaña
      }
      onVerificationSent?.(token);

      setStep("sent");
    } catch (err) {
      setErrorMsg(err.message || "Algo salió mal enviando el correo");
      setStep("error");
    }
  }

  if (isLoggedIn) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div className="relative bg-[#F7F6F2] rounded-xl max-w-xs w-full p-5 shadow-xl">
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold flex items-center gap-1.5">
              <User size={15} /> Mi perfil
            </div>
            <button onClick={onClose} className="p-1 hover:bg-[#EDEAE1] rounded">
              <X size={16} />
            </button>
          </div>
          <div className="border border-[#D8D3C7] rounded-lg bg-white p-4 mb-3">
            <div className="text-[11px] text-[#8A8578] mb-1">Sesión iniciada como</div>
            <div className="text-sm font-medium">{profile.name}</div>
            <div className="text-[12px] text-[#8A8578]">{profile.email}</div>
          </div>
          <p className="text-[12px] text-[#8A8578] mb-4">
            Tus próximas compras ya usan estos datos automáticamente.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(true)}
              className="flex-1 py-2 rounded-lg border border-[#D8D3C7] text-sm hover:bg-white"
            >
              Editar
            </button>
            <button
              onClick={onLogout}
              className="flex-1 py-2 rounded-lg border border-[#D8D3C7] text-sm text-[#B3462C] hover:bg-white"
            >
              Cerrar sesión
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "sent") {
    return (
      <SentScreen email={email} onClose={onClose} onCheckNow={onCheckNow} />
    );
  }

  if (step === "error") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div className="relative bg-[#F7F6F2] rounded-xl max-w-xs w-full p-5 shadow-xl">
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold flex items-center gap-1.5 text-[#B3462C]">
              <AlertTriangle size={15} /> No se pudo enviar
            </div>
            <button onClick={onClose} className="p-1 hover:bg-[#EDEAE1] rounded">
              <X size={16} />
            </button>
          </div>
          <p className="text-sm text-[#1E2321] mb-4">{errorMsg}</p>
          <button
            onClick={() => setStep("form")}
            className="w-full py-2.5 rounded-lg bg-[#0F3A34] text-white text-sm font-medium hover:bg-[#0B2C27]"
          >
            Volver a intentar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-[#F7F6F2] rounded-xl max-w-xs w-full p-5 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold flex items-center gap-1.5">
            <User size={15} /> Mi perfil
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[#EDEAE1] rounded">
            <X size={16} />
          </button>
        </div>
        <p className="text-[12px] text-[#8A8578] mb-3">
          Guarda tu nombre y correo para que tus próximas compras se llenen más rápido.
        </p>
        <div className="space-y-3">
          <div>
            <label className="text-[12px] text-[#8A8578] block mb-1">Nombre</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tu nombre"
              className="w-full px-3 py-2 rounded-lg border border-[#D8D3C7] bg-white text-sm focus:outline-none focus:ring-2 focus:ring-[#0F3A34]/30"
            />
          </div>
          <div>
            <label className="text-[12px] text-[#8A8578] block mb-1">Correo electrónico</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@correo.com"
              className="w-full px-3 py-2 rounded-lg border border-[#D8D3C7] bg-white text-sm focus:outline-none focus:ring-2 focus:ring-[#0F3A34]/30"
            />
          </div>
        </div>
        <button
          onClick={() => canSave && sendConfirmationEmail()}
          disabled={!canSave || step === "sending"}
          className="w-full mt-4 py-2.5 rounded-lg bg-[#0F3A34] text-white text-sm font-medium hover:bg-[#0B2C27] disabled:opacity-40"
        >
          {step === "sending" ? "Enviando..." : "Guardar"}
        </button>
      </div>
    </div>
  );
}

function SearchBar({ search, setSearch, placeholder }) {
  return (
    <div className="relative">
      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8A8578]" />
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-[#D8D3C7] bg-white text-sm placeholder-[#8A8578] focus:outline-none focus:ring-2 focus:ring-[#0F3A34]/30 focus:border-[#0F3A34]"
      />
    </div>
  );
}

function BuyerView({ list, allLoaded, search, setSearch, cart, addToCart, removeFromCart }) {
  return (
    <main className="max-w-5xl mx-auto px-5 py-6 pb-28">
      <div className="mb-5">
        <SearchBar search={search} setSearch={setSearch} placeholder="Buscar medicina por nombre..." />
      </div>

      {!allLoaded ? (
        <div className="text-sm text-[#8A8578] py-10 text-center">Cargando inventario...</div>
      ) : list.length === 0 ? (
        <div className="text-sm text-[#8A8578] py-10 text-center">No encontramos medicinas con ese nombre.</div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {list.map((p) => {
            const inCart = cart[p.id] || 0;
            const outOfStock = p.quantity <= 0;
            return (
              <div key={p.id} className="border border-[#D8D3C7] rounded-xl bg-white p-4 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-[15px]">{p.name}</div>
                    <div className="text-[12px] text-[#8A8578] capitalize">por {p.unit}</div>
                  </div>
                  <div className="text-[15px] font-semibold text-[#0F3A34]">{currency(p.price)}</div>
                </div>
                <div className="text-[12px] text-[#8A8578]">
                  {outOfStock ? (
                    <span className="text-[#B3462C]">Sin existencias</span>
                  ) : (
                    `${p.quantity} ${p.unit}${p.quantity === 1 ? "" : "s"} disponibles`
                  )}
                </div>
                <div className="flex items-center justify-between mt-1">
                  {outOfStock ? (
                    <span className="text-sm text-[#8A8578]">No disponible</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => addToCart(p, -1)}
                        disabled={inCart <= 0}
                        className="w-7 h-7 rounded-md border border-[#D8D3C7] flex items-center justify-center hover:bg-[#F7F6F2] disabled:opacity-30"
                      >
                        <Minus size={14} />
                      </button>
                      <span className="text-sm w-5 text-center">{inCart}</span>
                      <button
                        onClick={() => addToCart(p, 1)}
                        disabled={inCart >= p.quantity}
                        className="w-7 h-7 rounded-md border border-[#D8D3C7] flex items-center justify-center hover:bg-[#F7F6F2] disabled:opacity-30"
                      >
                        <Plus size={14} />
                      </button>
                      <button
                        onClick={() => removeFromCart(p)}
                        disabled={inCart <= 0}
                        className="w-7 h-7 rounded-md border border-[#D8D3C7] flex items-center justify-center hover:bg-[#FBEAE4] text-[#B3462C] disabled:opacity-30 disabled:hover:bg-transparent"
                        title="Cancelar selección"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}

function CartView({ items, total, onChangeQty, onRemove, onBackToShop, onCheckout }) {
  return (
    <main className="max-w-3xl mx-auto px-5 py-6 pb-28">
      <div className="flex items-center justify-between mb-5">
        <div className="font-semibold flex items-center gap-1.5 text-[15px]">
          <ShoppingCart size={16} /> Tu carrito
        </div>
        <button onClick={onBackToShop} className="text-sm text-[#0F3A34] hover:underline flex items-center gap-1">
          <ArrowLeft size={14} /> Seguir comprando
        </button>
      </div>

      {items.length === 0 ? (
        <div className="text-sm text-[#8A8578] text-center py-16 border border-[#D8D3C7] rounded-xl bg-white">
          Aún no agregas medicinas. Ve a la pestaña Inventario para empezar.
        </div>
      ) : (
        <div className="space-y-3 mb-6">
          {items.map((i) => (
            <div key={i.id} className="flex items-center justify-between bg-white border border-[#D8D3C7] rounded-xl p-4">
              <div>
                <div className="text-sm font-medium">{i.name}</div>
                <div className="text-[12px] text-[#8A8578] capitalize">
                  {i.qty} {i.unit}
                  {i.qty === 1 ? "" : "s"} x {currency(i.price)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onChangeQty(i, -1)}
                  className="w-7 h-7 rounded-md border border-[#D8D3C7] flex items-center justify-center hover:bg-[#F7F6F2]"
                >
                  <Minus size={14} />
                </button>
                <span className="text-sm w-5 text-center">{i.qty}</span>
                <button
                  onClick={() => onChangeQty(i, 1)}
                  disabled={i.qty >= i.quantity}
                  className="w-7 h-7 rounded-md border border-[#D8D3C7] flex items-center justify-center hover:bg-[#F7F6F2] disabled:opacity-30"
                >
                  <Plus size={14} />
                </button>
                <button
                  onClick={() => onRemove(i)}
                  className="w-7 h-7 rounded-md border border-[#D8D3C7] flex items-center justify-center hover:bg-[#FBEAE4] text-[#B3462C]"
                  title="Cancelar selección"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="border border-[#D8D3C7] rounded-xl bg-white p-4 sticky bottom-4">
        <div className="flex items-center justify-between mb-3 text-sm">
          <span className="text-[#8A8578]">Total</span>
          <span className="font-semibold text-[18px]">{currency(total)}</span>
        </div>
        <button
          onClick={onCheckout}
          disabled={items.length === 0}
          className="w-full py-2.5 rounded-lg bg-[#E8846B] text-[#0F3A34] font-medium text-sm hover:bg-[#DD7357] disabled:opacity-40"
        >
          Levantar pedido
        </button>
      </div>
    </main>
  );
}

function CheckoutView({ total, items, profile, profileReady, onBack, onConfirm }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [streetAddress, setStreetAddress] = useState("");
  const [cp, setCp] = useState("");
  const [colonia, setColonia] = useState("");
  const [estado, setEstado] = useState("");
  const [municipio, setMunicipio] = useState("");
  const [saveProfile, setSaveProfile] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

  const [cpSuggestions, setCpSuggestions] = useState([]);
  const [coloniaOptions, setColoniaOptions] = useState([]);
  const [municipioOptions, setMunicipioOptions] = useState([]);
  const [estadoOptions, setEstadoOptions] = useState([]);
  const [cpStatus, setCpStatus] = useState("idle"); // idle | checking | verified | notfound
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [streetSuggestions, setStreetSuggestions] = useState([]);
  const [showStreetSuggestions, setShowStreetSuggestions] = useState(false);
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [lat, setLat] = useState(null);
  const [lng, setLng] = useState(null);

  useEffect(() => {
    if (profileReady && profile && !prefilled) {
      setName(profile.name || "");
      setEmail(profile.email || "");
      setPhone(profile.phone || "");
      setStreetAddress(profile.streetAddress || profile.address || "");
      setCp(profile.cp || "");
      setColonia(profile.colonia || "");
      setEstado(profile.estado || "");
      setMunicipio(profile.municipio || "");
      if (profile.cp && profile.colonia) {
        setColoniaOptions([profile.colonia]);
        if (profile.municipio) setMunicipioOptions([profile.municipio]);
        if (profile.estado) setEstadoOptions([profile.estado]);
        setCpStatus("verified");
      }
      setPrefilled(true);
    }
  }, [profileReady, profile, prefilled]);

  // Busca coincidencias de código postal mientras se escribe.
  useEffect(() => {
    const digits = cp.replace(/\D/g, "").slice(0, 5);
    if (digits.length < 2) {
      setCpSuggestions([]);
      return;
    }
    setCpStatus("checking");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/postal-code?q=${digits}`);
        const data = await res.json();
        const results = data.results || [];
        setCpSuggestions(results);
        if (digits.length === 5) {
          const exact = results.filter((r) => r.cp === digits);
          if (exact.length > 0) {
            applyCpMatch(digits, exact);
          } else {
            setCpStatus("notfound");
          }
        } else {
          setCpStatus("idle");
        }
      } catch {
        setCpStatus("idle");
      }
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cp]);

  function applyCpMatch(cpValue, records) {
    const uniqueColonias = [...new Set(records.map((r) => r.colonia).filter(Boolean))];
    const uniqueMunicipios = [...new Set(records.map((r) => r.municipio).filter(Boolean))];
    const uniqueEstados = [...new Set(records.map((r) => r.estado).filter(Boolean))];
    setColoniaOptions(uniqueColonias);
    setMunicipioOptions(uniqueMunicipios);
    setEstadoOptions(uniqueEstados);
    setColonia((prev) => (uniqueColonias.includes(prev) ? prev : uniqueColonias[0] || ""));
    setMunicipio((prev) => (uniqueMunicipios.includes(prev) ? prev : uniqueMunicipios[0] || ""));
    setEstado((prev) => (uniqueEstados.includes(prev) ? prev : uniqueEstados[0] || ""));
    setCpStatus("verified");
    setShowSuggestions(false);
  }

  async function pickSuggestion(cpValue) {
    setCp(cpValue);
    setShowSuggestions(false);
    try {
      const res = await fetch(`/api/postal-code?q=${cpValue}`);
      const data = await res.json();
      const results = (data.results || []).filter((r) => r.cp === cpValue);
      if (results.length > 0) applyCpMatch(cpValue, results);
    } catch {
      // si falla, el usuario puede seguir llenando los campos a mano
    }
  }

  const uniqueCpList = useMemo(() => {
    const seen = new Set();
    const list = [];
    for (const r of cpSuggestions) {
      if (!seen.has(r.cp)) {
        seen.add(r.cp);
        list.push(r);
      }
    }
    return list.slice(0, 8);
  }, [cpSuggestions]);

  // Sugerencias de calle (OpenStreetMap) — apoyo, no verificación oficial.
  useEffect(() => {
    if (streetAddress.trim().length < 3) {
      setStreetSuggestions([]);
      return;
    }
    const context = [colonia, municipio, estado].filter(Boolean).join(", ");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/street-suggest?q=${encodeURIComponent(streetAddress)}&context=${encodeURIComponent(context)}`
        );
        const data = await res.json();
        setStreetSuggestions(data.results || []);
      } catch {
        setStreetSuggestions([]);
      }
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streetAddress, colonia, municipio, estado]);

  function pickStreetSuggestion(s) {
    setStreetAddress(s.houseNumber ? `${s.street} ${s.houseNumber}` : s.street);
    setShowStreetSuggestions(false);
  }

  function handleMapConfirm(addr, pickedLat, pickedLng) {
    setShowMapPicker(false);
    setLat(pickedLat);
    setLng(pickedLng);
    if (addr.street) setStreetAddress(`${addr.street}${addr.houseNumber ? " " + addr.houseNumber : ""}`.trim());
    if (addr.colonia) setColonia(addr.colonia);
    if (addr.municipio) setMunicipio(addr.municipio);
    if (addr.estado) setEstado(addr.estado);
    if (addr.cp) setCp(addr.cp); // esto dispara la verificación oficial del CP sola
  }

  const canSubmit =
    name.trim() && phone.trim() && streetAddress.trim() && cp.length === 5 && colonia.trim() && estado.trim() && municipio.trim();

  function handlePlaceOrder() {
    if (!canSubmit) return;
    const fullAddress = `${streetAddress}, ${colonia}, ${municipio}, ${estado}, CP ${cp}`;
    onConfirm(
      { name, email, phone, address: fullAddress, streetAddress, cp, colonia, estado, municipio, lat, lng },
      saveProfile
    );
  }

  return (
    <main className="max-w-md mx-auto px-5 py-6 pb-28">
      <div className="flex items-center justify-between mb-5">
        <div className="font-semibold text-[15px]">Datos de entrega</div>
        <button onClick={onBack} className="text-sm text-[#0F3A34] hover:underline flex items-center gap-1">
          <ArrowLeft size={14} /> Volver al carrito
        </button>
      </div>

      {profileReady && profile && (
        <div className="flex items-center gap-2 bg-white border border-[#D8D3C7] rounded-lg p-3 mb-4 text-[12px] text-[#8A8578]">
          <User size={14} className="text-[#0F3A34]" />
          Usamos tus datos guardados de {profile.name}. Puedes editarlos abajo si es necesario.
        </div>
      )}

      <div className="border border-[#D8D3C7] rounded-xl bg-white p-4 space-y-3 mb-4">
