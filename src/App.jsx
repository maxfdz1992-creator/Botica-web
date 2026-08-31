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
          await supabase.from("email_verifications").update({ verified: true }).eq("token", token);

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
  // tiempo real hasta que ese otro lado marque el token como confirmado.
  useEffect(() => {
    if (!pendingToken) return;
    let cancelled = false;

    (async () => {
      const { data } = await supabase
        .from("email_verifications")
        .select("*")
        .eq("token", pendingToken)
        .maybeSingle();
      if (!cancelled && data?.verified) finishLocalVerification({ ...data, token: pendingToken });
    })();

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
      <header className="border-b border-[#D8D3C7] bg-[#0F3A34] text-[#F7F6F2]">
        <div className="max-w-5xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-md bg-[#E8846B] flex items-center justify-center shrink-0">
                <Package size={18} className="text-[#0F3A34]" />
              </div>
              <div>
                <div className="text-[15px] leading-tight font-semibold">Botica</div>
                <div className="text-[11px] leading-tight text-[#B9CFC8]">Inventario y ventas</div>
              </div>
            </div>
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

function ProfileModal({ profile, profileReady, onClose, onSave, onLogout, onVerificationSent }) {
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
            correo — cuando lo hagas, esta app va a detectar la confirmación sola, sin que tengas que
            regresar aquí manualmente.
          </div>
          <p className="text-[11px] text-[#8A8578]">
            Si no lo ves en unos minutos, revisa la carpeta de spam. Puedes cerrar esta ventana mientras
            tanto, se va a actualizar sola cuando confirmes.
          </p>
        </div>
      </div>
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
  const [address, setAddress] = useState("");
  const [saveProfile, setSaveProfile] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (profileReady && profile && !prefilled) {
      setName(profile.name || "");
      setEmail(profile.email || "");
      setPhone(profile.phone || "");
      setAddress(profile.address || "");
      setPrefilled(true);
    }
  }, [profileReady, profile, prefilled]);

  const canSubmit = name.trim() && phone.trim() && address.trim();

  function handlePlaceOrder() {
    if (!canSubmit) return;
    onConfirm({ name, email, phone, address }, saveProfile);
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
        <div className="text-sm font-medium">Datos de entrega</div>
        <div>
          <label className="text-[12px] text-[#8A8578] block mb-1">Nombre completo</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[#D8D3C7] bg-white text-sm focus:outline-none focus:ring-2 focus:ring-[#0F3A34]/30"
            placeholder="Tu nombre"
          />
        </div>
        <div>
          <label className="text-[12px] text-[#8A8578] block mb-1 flex items-center gap-1">
            <Mail size={12} /> Correo electrónico (opcional)
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[#D8D3C7] bg-white text-sm focus:outline-none focus:ring-2 focus:ring-[#0F3A34]/30"
            placeholder="tu@correo.com"
          />
        </div>
        <div>
          <label className="text-[12px] text-[#8A8578] block mb-1">Teléfono</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[#D8D3C7] bg-white text-sm focus:outline-none focus:ring-2 focus:ring-[#0F3A34]/30"
            placeholder="Número para confirmar el pedido"
          />
        </div>
        <div>
          <label className="text-[12px] text-[#8A8578] block mb-1 flex items-center gap-1">
            <MapPin size={12} /> Ubicación / dirección
          </label>
          <textarea
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 rounded-lg border border-[#D8D3C7] bg-white text-sm focus:outline-none focus:ring-2 focus:ring-[#0F3A34]/30 resize-none"
            placeholder="Calle, número, colonia, referencias..."
          />
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer pt-1">
          <input
            type="checkbox"
            checked={saveProfile}
            onChange={(e) => setSaveProfile(e.target.checked)}
            className="accent-[#0F3A34]"
          />
          Guardar mis datos para mi próxima compra
        </label>
      </div>

      <div className="flex items-center justify-between mb-3 text-sm">
        <span className="text-[#8A8578]">{items.length} producto(s)</span>
        <span className="font-semibold">{currency(total)}</span>
      </div>
      <button
        onClick={handlePlaceOrder}
        disabled={!canSubmit}
        className="w-full py-2.5 rounded-lg bg-[#0F3A34] text-white font-medium text-sm hover:bg-[#0B2C27] disabled:opacity-40"
      >
        Levantar pedido
      </button>
    </main>
  );
}

function OrderConfirmed({ order, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-[#F7F6F2] rounded-xl max-w-sm w-full p-6 shadow-xl text-center">
        <div className="w-12 h-12 rounded-full bg-[#0F3A34] text-white flex items-center justify-center mx-auto mb-3">
          <Check size={22} />
        </div>
        <div className="font-semibold text-[16px] mb-1">Pedido recibido</div>
        <div className="text-sm text-[#8A8578] mb-4">
          Guardamos tu pedido a nombre de {order.buyer.name}. Total: {currency(order.total)}.
        </div>
        <button onClick={onClose} className="w-full py-2.5 rounded-lg bg-[#0F3A34] text-white text-sm font-medium hover:bg-[#0B2C27]">
          Listo
        </button>
      </div>
    </div>
  );
}

function AdminView({ list, fullList, allLoaded, search, setSearch, setInventory, orders, adminEmails, setAdminEmails, onLogout }) {
  const [tab, setTab] = useState("inventario");
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({});
  const [newProduct, setNewProduct] = useState({ name: "", unit: UNIT_TYPES[0], quantity: "", price: "" });
  const [importOpen, setImportOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  function clearInventory() {
    setInventory([]);
    setShowClearConfirm(false);
  }

  function addAdminEmail() {
    const email = newEmail.trim().toLowerCase();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return;
    if (adminEmails.includes(email)) return;
    setAdminEmails([...adminEmails, email]);
    setNewEmail("");
  }

  function removeAdminEmail(email) {
    setAdminEmails(adminEmails.filter((e) => e !== email));
  }

  function startEdit(p) {
    setEditingId(p.id);
    setDraft({ quantity: String(p.quantity), price: String(p.price) });
  }

  function saveEdit(id) {
    const qty = Number(draft.quantity);
    const price = Number(draft.price);
    if (Number.isNaN(qty) || Number.isNaN(price) || qty < 0 || price < 0) return;
    setInventory(fullList.map((p) => (p.id === id ? { ...p, quantity: qty, price } : p)));
    setEditingId(null);
  }

  function deleteProduct(id) {
    setInventory(fullList.filter((p) => p.id !== id));
  }

  function addProduct() {
    const qty = Number(newProduct.quantity);
    const price = Number(newProduct.price);
    if (!newProduct.name.trim() || Number.isNaN(qty) || Number.isNaN(price)) return;
    setInventory([
      ...fullList,
      { id: "p_" + Date.now(), name: newProduct.name.trim(), unit: newProduct.unit, quantity: qty, price },
    ]);
    setNewProduct({ name: "", unit: UNIT_TYPES[0], quantity: "", price: "" });
  }

  function applyImport(parsedItems) {
    let next = [...fullList];
    parsedItems.forEach((item) => {
      const idx = next.findIndex((p) => normalize(p.name) === normalize(item.name));
      if (idx >= 0) {
        next[idx] = { ...next[idx], unit: item.unit, quantity: item.quantity, price: item.price };
      } else {
        next.push({ id: "p_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7), ...item });
      }
    });
    setInventory(next);
    setImportOpen(false);
  }

  return (
    <>
    <main className="max-w-5xl mx-auto px-5 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-5">
        <div className="flex items-center gap-1 bg-[#EDEAE1] rounded-lg p-1 w-fit">
          <button
            onClick={() => setTab("inventario")}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${tab === "inventario" ? "bg-white shadow-sm" : "text-[#8A8578]"}`}
          >
            <Package size={14} /> Inventario
          </button>
          <button
            onClick={() => setTab("pedidos")}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${tab === "pedidos" ? "bg-white shadow-sm" : "text-[#8A8578]"}`}
          >
            <ClipboardList size={14} /> Pedidos {orders.length > 0 && `(${orders.length})`}
          </button>
          <button
            onClick={() => setTab("correos")}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${tab === "correos" ? "bg-white shadow-sm" : "text-[#8A8578]"}`}
          >
            <Mail size={14} /> Correos
          </button>
        </div>
        <div className="flex items-center gap-3">
          {tab === "inventario" && (
            <>
              <button
                onClick={() => setImportOpen(true)}
                className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-[#0F3A34] text-[#0F3A34] hover:bg-white"
              >
                <Upload size={14} /> Importar inventario
              </button>
              <button
                onClick={() => setShowClearConfirm(true)}
                className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-[#B3462C] text-[#B3462C] hover:bg-[#FBEAE4]"
              >
                <Trash2 size={14} /> Vaciar inventario
              </button>
            </>
          )}
          <button onClick={onLogout} className="text-[12px] text-[#8A8578] hover:text-[#B3462C]">
            Cerrar sesión
          </button>
        </div>
      </div>

      {tab === "inventario" ? (
        <>
          <div className="mb-4">
            <SearchBar search={search} setSearch={setSearch} placeholder="Buscar en el inventario..." />
          </div>

          <div className="border border-[#D8D3C7] rounded-xl bg-white overflow-x-auto mb-6">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="text-left text-[12px] text-[#8A8578] border-b border-[#D8D3C7]">
                  <th className="px-4 py-2.5 font-medium">Medicina</th>
                  <th className="px-4 py-2.5 font-medium">Unidad</th>
                  <th className="px-4 py-2.5 font-medium">Existencias</th>
                  <th className="px-4 py-2.5 font-medium">Precio</th>
                  <th className="px-4 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {!allLoaded ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-[#8A8578]">Cargando...</td>
                  </tr>
                ) : list.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-[#8A8578]">Sin resultados.</td>
                  </tr>
                ) : (
                  list.map((p) => {
                    const isEditing = editingId === p.id;
                    return (
                      <tr key={p.id} className="border-b border-[#EDEAE1] last:border-0">
                        <td className="px-4 py-2.5">{p.name}</td>
                        <td className="px-4 py-2.5 capitalize text-[#8A8578]">{p.unit}</td>
                        <td className="px-4 py-2.5">
                          {isEditing ? (
                            <input
                              value={draft.quantity}
                              onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
                              className="w-20 px-2 py-1 rounded border border-[#D8D3C7] text-sm"
                            />
                          ) : (
                            <span className={p.quantity <= 5 ? "text-[#B3462C] font-medium" : ""}>{p.quantity}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {isEditing ? (
                            <input
                              value={draft.price}
                              onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                              className="w-20 px-2 py-1 rounded border border-[#D8D3C7] text-sm"
                            />
                          ) : (
                            currency(p.price)
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          {isEditing ? (
                            <button onClick={() => saveEdit(p.id)} className="p-1.5 rounded hover:bg-[#EDEAE1] text-[#0F3A34]">
                              <Check size={15} />
                            </button>
                          ) : (
                            <button onClick={() => startEdit(p)} className="p-1.5 rounded hover:bg-[#EDEAE1] text-[#8A8578]">
                              <Pencil size={14} />
                            </button>
                          )}
                          <button onClick={() => deleteProduct(p.id)} className="p-1.5 rounded hover:bg-[#EDEAE1] text-[#B3462C]">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="border border-[#D8D3C7] rounded-xl bg-white p-4">
            <div className="text-sm font-medium mb-3">Agregar medicina nueva</div>
            <div className="grid sm:grid-cols-4 gap-2">
              <input
                value={newProduct.name}
                onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })}
                placeholder="Nombre"
                className="px-3 py-2 rounded-lg border border-[#D8D3C7] text-sm sm:col-span-2"
              />
              <select
                value={newProduct.unit}
                onChange={(e) => setNewProduct({ ...newProduct, unit: e.target.value })}
                className="px-3 py-2 rounded-lg border border-[#D8D3C7] text-sm capitalize"
              >
                {UNIT_TYPES.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <input
                  value={newProduct.quantity}
                  onChange={(e) => setNewProduct({ ...newProduct, quantity: e.target.value })}
                  placeholder="Cant."
                  className="w-full px-3 py-2 rounded-lg border border-[#D8D3C7] text-sm"
                />
              </div>
              <input
                value={newProduct.price}
                onChange={(e) => setNewProduct({ ...newProduct, price: e.target.value })}
                placeholder="Precio"
                className="px-3 py-2 rounded-lg border border-[#D8D3C7] text-sm"
              />
              <button
                onClick={addProduct}
                className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[#0F3A34] text-white text-sm font-medium hover:bg-[#0B2C27] sm:col-span-1"
              >
                <Plus size={14} /> Agregar
              </button>
            </div>
          </div>
        </>
      ) : tab === "correos" ? (
        <div className="max-w-md">
          <div className="border border-[#D8D3C7] rounded-xl bg-white p-4 mb-4">
            <div className="text-sm font-medium mb-1">Correos administrativos</div>
            <p className="text-[12px] text-[#8A8578] mb-3">
              Cada vez que se levante un pedido, se manda un aviso a estos correos.
            </p>
            <div className="flex gap-2">
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addAdminEmail()}
                placeholder="correo@negocio.com"
                className="flex-1 px-3 py-2 rounded-lg border border-[#D8D3C7] bg-white text-sm focus:outline-none focus:ring-2 focus:ring-[#0F3A34]/30"
              />
              <button
                onClick={addAdminEmail}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#0F3A34] text-white text-sm font-medium hover:bg-[#0B2C27]"
              >
                <Plus size={14} /> Agregar
              </button>
            </div>
          </div>

          {adminEmails.length === 0 ? (
            <div className="text-sm text-[#8A8578] text-center py-6 border border-[#D8D3C7] rounded-xl bg-white">
              Todavía no agregas ningún correo administrativo.
            </div>
          ) : (
            <div className="border border-[#D8D3C7] rounded-xl bg-white overflow-hidden">
              {adminEmails.map((email) => (
                <div key={email} className="flex items-center justify-between px-4 py-2.5 border-b border-[#EDEAE1] last:border-0">
                  <span className="text-sm">{email}</span>
                  <button
                    onClick={() => removeAdminEmail(email)}
                    className="p-1.5 rounded hover:bg-[#FBEAE4] text-[#B3462C]"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {orders.length === 0 ? (
            <div className="text-sm text-[#8A8578] text-center py-10">Todavía no hay pedidos.</div>
          ) : (
            orders.map((o) => (
              <div key={o.id} className="border border-[#D8D3C7] rounded-xl bg-white p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="font-medium text-sm">{o.buyer.name}</div>
                    {o.buyer.email && <div className="text-[12px] text-[#8A8578]">{o.buyer.email}</div>}
                    <div className="text-[12px] text-[#8A8578]">{o.buyer.phone}</div>
                    <div className="text-[12px] text-[#8A8578] flex items-center gap-1 mt-0.5">
                      <MapPin size={11} /> {o.buyer.address}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-sm">{currency(o.total)}</div>
                    <div className="text-[11px] text-[#8A8578]">{new Date(o.date).toLocaleString("es-MX")}</div>
                  </div>
                </div>
                <div className="text-[12px] text-[#8A8578] border-t border-[#EDEAE1] pt-2 mt-1">
                  {o.items.map((i) => `${i.qty} ${i.unit} ${i.name}`).join(" · ")}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </main>

    {importOpen && <ImportWordModal onClose={() => setImportOpen(false)} onApply={applyImport} />}

    {showClearConfirm && (
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
        <div className="absolute inset-0 bg-black/40" onClick={() => setShowClearConfirm(false)} />
        <div className="relative bg-[#F7F6F2] rounded-xl max-w-xs w-full p-5 shadow-xl">
          <div className="flex items-center gap-2 mb-3 text-[#B3462C]">
            <AlertTriangle size={18} />
            <div className="font-semibold">Vaciar inventario</div>
          </div>
          <p className="text-sm text-[#1E2321] mb-4">
            Esto va a borrar las {fullList.length} medicina(s) que tienes cargadas ahora mismo. No se puede
            deshacer. Los pedidos ya hechos no se ven afectados.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setShowClearConfirm(false)}
              className="flex-1 py-2 rounded-lg border border-[#D8D3C7] text-sm hover:bg-white"
            >
              Cancelar
            </button>
            <button
              onClick={clearInventory}
              className="flex-1 py-2 rounded-lg bg-[#B3462C] text-white text-sm font-medium hover:bg-[#96371F]"
            >
              Sí, borrar todo
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

const PIE_COLORS = ["#0F3A34", "#E8846B", "#5B8C7E", "#C9A227", "#B3462C", "#8A8578", "#3E6259", "#D8A47F"];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function ResultsView({ orders, onLogout }) {
  const [mode, setMode] = useState("exact"); // exact | range
  const [exactDate, setExactDate] = useState(todayStr());
  const [startDate, setStartDate] = useState(todayStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [untilPresent, setUntilPresent] = useState(true);
  const [Recharts, setRecharts] = useState(null); // null = cargando, false = no disponible

  useEffect(() => {
    let mounted = true;
    import("recharts")
      .then((mod) => {
        if (mounted) setRecharts(mod);
      })
      .catch(() => {
        if (mounted) setRecharts(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const effectiveEndDate = untilPresent ? todayStr() : endDate;

  const periodLabel =
    mode === "exact"
      ? `del ${exactDate}`
      : `del ${startDate} al ${untilPresent ? "presente" : effectiveEndDate}`;

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      const d = new Date(o.date);
      if (Number.isNaN(d.getTime())) return false;
      const oDay = d.toISOString().slice(0, 10);
      if (mode === "exact") return oDay === exactDate;
      return oDay >= startDate && oDay <= effectiveEndDate;
    });
  }, [orders, mode, exactDate, startDate, effectiveEndDate]);

  const byMedicine = useMemo(() => {
    const map = {};
    filteredOrders.forEach((o) => {
      o.items.forEach((it) => {
        if (!map[it.name]) map[it.name] = { name: it.name, unit: it.unit, quantity: 0, revenue: 0 };
        map[it.name].quantity += it.qty;
        map[it.name].revenue += it.qty * it.price;
      });
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }, [filteredOrders]);

  const totalUnits = byMedicine.reduce((sum, m) => sum + m.quantity, 0);
  const totalRevenue = byMedicine.reduce((sum, m) => sum + m.revenue, 0);

  const pieData = byMedicine.map((m) => ({ name: m.name, value: m.revenue }));

  const byCustomer = useMemo(() => {
    const map = {};
    filteredOrders.forEach((o) => {
      const key = `${normalize(o.buyer?.name || "")}|${normalize(o.buyer?.phone || "")}`;
      if (!map[key]) {
        map[key] = { name: o.buyer?.name || "Sin nombre", phone: o.buyer?.phone || "", dates: [], total: 0 };
      }
      map[key].dates.push(o.date);
      map[key].total += o.total;
    });
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [filteredOrders]);

  return (
    <main className="max-w-5xl mx-auto px-5 py-6">
      <div className="flex items-center justify-between mb-5">
        <div className="font-semibold flex items-center gap-1.5 text-[15px]">
          <TrendingUp size={16} /> Resultados de venta
        </div>
        <button onClick={onLogout} className="text-[12px] text-[#8A8578] hover:text-[#B3462C]">
          Cerrar sesión
        </button>
      </div>

      <div className="border border-[#D8D3C7] rounded-xl bg-white p-4 mb-5">
        <div className="flex items-center gap-1 bg-[#EDEAE1] rounded-lg p-1 w-fit mb-3">
          <button
            onClick={() => setMode("exact")}
            className={`px-3 py-1.5 text-sm rounded-md ${mode === "exact" ? "bg-white shadow-sm" : "text-[#8A8578]"}`}
          >
            Fecha exacta
          </button>
          <button
            onClick={() => setMode("range")}
            className={`px-3 py-1.5 text-sm rounded-md ${mode === "range" ? "bg-white shadow-sm" : "text-[#8A8578]"}`}
          >
            Rango de fechas
          </button>
        </div>

        {mode === "exact" ? (
          <div className="flex items-center gap-2">
            <Calendar size={15} className="text-[#8A8578]" />
            <input
              type="date"
              value={exactDate}
              onChange={(e) => setExactDate(e.target.value)}
              className="px-3 py-2 rounded-lg border border-[#D8D3C7] bg-white text-sm"
            />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-[#8A8578]">Desde</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="px-3 py-2 rounded-lg border border-[#D8D3C7] bg-white text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-[#8A8578]">Hasta</span>
              <input
                type="date"
                value={untilPresent ? todayStr() : endDate}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={untilPresent}
                className="px-3 py-2 rounded-lg border border-[#D8D3C7] bg-white text-sm disabled:opacity-50 disabled:bg-[#F7F6F2]"
              />
            </div>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={untilPresent}
                onChange={(e) => setUntilPresent(e.target.checked)}
                className="accent-[#0F3A34]"
              />
              Presente (hasta hoy)
            </label>
          </div>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-3 mb-6">
        <div className="border border-[#D8D3C7] rounded-xl bg-white p-4">
          <div className="text-[12px] text-[#8A8578] mb-1">Unidades vendidas ({periodLabel})</div>
          <div className="text-2xl font-semibold">{totalUnits}</div>
        </div>
        <div className="border border-[#D8D3C7] rounded-xl bg-white p-4">
          <div className="text-[12px] text-[#8A8578] mb-1">Ingresos totales ({periodLabel})</div>
          <div className="text-2xl font-semibold">{currency(totalRevenue)}</div>
        </div>
      </div>

      {byMedicine.length === 0 ? (
        <div className="text-sm text-[#8A8578] text-center py-10 border border-[#D8D3C7] rounded-xl bg-white">
          No hay ventas registradas en este periodo.
        </div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="border border-[#D8D3C7] rounded-xl bg-white p-4">
            <div className="text-sm font-medium mb-3">Participación de ingresos por medicina</div>
            {Recharts === null ? (
              <div className="h-[260px] flex items-center justify-center text-sm text-[#8A8578]">Cargando gráfica...</div>
            ) : Recharts === false ? (
              <div className="text-sm text-[#8A8578] space-y-1.5 py-2">
                {byMedicine.map((m, i) => (
                  <div key={m.name} className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full inline-block"
                        style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }}
                      />
                      {m.name}
                    </span>
                    <span>{totalRevenue > 0 ? Math.round((m.revenue / totalRevenue) * 100) : 0}%</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ width: "100%", height: 260 }}>
                <Recharts.ResponsiveContainer>
                  <Recharts.PieChart>
                    <Recharts.Pie data={pieData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={2}>
                      {pieData.map((_, i) => (
                        <Recharts.Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Recharts.Pie>
                    <Recharts.Tooltip formatter={(v) => currency(v)} />
                    <Recharts.Legend wrapperStyle={{ fontSize: 12 }} />
                  </Recharts.PieChart>
                </Recharts.ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="border border-[#D8D3C7] rounded-xl bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[12px] text-[#8A8578] border-b border-[#D8D3C7]">
                  <th className="px-4 py-2.5 font-medium">Medicina</th>
                  <th className="px-4 py-2.5 font-medium">Unidades</th>
                  <th className="px-4 py-2.5 font-medium">Precio prom.</th>
                  <th className="px-4 py-2.5 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {byMedicine.map((m) => (
                  <tr key={m.name} className="border-b border-[#EDEAE1] last:border-0">
                    <td className="px-4 py-2.5">{m.name}</td>
                    <td className="px-4 py-2.5">
                      {m.quantity} {m.unit}
                      {m.quantity === 1 ? "" : "s"}
                    </td>
                    <td className="px-4 py-2.5">{currency(m.revenue / m.quantity)}</td>
                    <td className="px-4 py-2.5 font-medium">{currency(m.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {byCustomer.length > 0 && (
        <div className="border border-[#D8D3C7] rounded-xl bg-white overflow-hidden mt-4">
          <div className="text-sm font-medium px-4 pt-4 pb-2">Clientes que compraron en este periodo</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[12px] text-[#8A8578] border-b border-[#D8D3C7]">
                <th className="px-4 py-2.5 font-medium">Cliente</th>
                <th className="px-4 py-2.5 font-medium">Teléfono</th>
                <th className="px-4 py-2.5 font-medium">Compras</th>
                <th className="px-4 py-2.5 font-medium">Fechas</th>
                <th className="px-4 py-2.5 font-medium">Total gastado</th>
              </tr>
            </thead>
            <tbody>
              {byCustomer.map((c, i) => (
                <tr key={i} className="border-b border-[#EDEAE1] last:border-0 align-top">
                  <td className="px-4 py-2.5">{c.name}</td>
                  <td className="px-4 py-2.5 text-[#8A8578]">{c.phone}</td>
                  <td className="px-4 py-2.5">{c.dates.length}</td>
                  <td className="px-4 py-2.5 text-[12px] text-[#8A8578]">
                    {c.dates
                      .map((d) => new Date(d).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" }))
                      .join(" · ")}
                  </td>
                  <td className="px-4 py-2.5 font-medium">{currency(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}


function ImportWordModal({ onClose, onApply }) {
  const [status, setStatus] = useState("idle"); // idle | loading | preview | error
  const [parsedItems, setParsedItems] = useState([]);
  const [errors, setErrors] = useState([]);
  const [errorMsg, setErrorMsg] = useState("");
  const inputRef = useRef(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus("loading");
    try {
      const { parsed, errors } = await parseInventoryFile(file);
      if (parsed.length === 0) {
        setStatus("error");
        setErrorMsg("No encontramos filas válidas para importar.");
        return;
      }
      setParsedItems(parsed);
      setErrors(errors);
      setStatus("preview");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err.message || "No pudimos leer el archivo.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-[#F7F6F2] rounded-xl max-w-lg w-full p-5 shadow-xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="font-semibold flex items-center gap-1.5">
            <Upload size={15} /> Importar inventario
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[#EDEAE1] rounded">
            <X size={16} />
          </button>
        </div>

        {status === "idle" && (
          <>
            <p className="text-sm text-[#8A8578] mb-3">
              Sube un archivo Word (.docx) o Excel (.xlsx, .xls, .csv) con una tabla que tenga las columnas
              Nombre, Unidad, Cantidad y Precio. Si una medicina ya existe (por nombre), se actualiza; si no,
              se agrega como nueva.
            </p>
            <button
              onClick={() => inputRef.current?.click()}
              className="w-full py-8 rounded-lg border-2 border-dashed border-[#D8D3C7] text-sm text-[#8A8578] hover:border-[#0F3A34] hover:text-[#0F3A34] flex flex-col items-center gap-2"
            >
              <div className="flex items-center gap-2">
                <FileText size={16} />
                <FileSpreadsheet size={16} />
              </div>
              Toca para elegir un archivo .docx, .xlsx, .xls o .csv
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".docx,.xlsx,.xls,.csv"
              onChange={handleFile}
              className="hidden"
            />
          </>
        )}

        {status === "loading" && <div className="text-sm text-[#8A8578] text-center py-10">Leyendo archivo...</div>}

        {status === "error" && (
          <div>
            <div className="flex items-start gap-2 bg-[#FBEAE4] border border-[#E8846B] rounded-lg p-3 text-sm text-[#B3462C] mb-3">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
            <button
              onClick={() => setStatus("idle")}
              className="w-full py-2.5 rounded-lg bg-[#0F3A34] text-white text-sm font-medium hover:bg-[#0B2C27]"
            >
              Intentar de nuevo
            </button>
          </div>
        )}

        {status === "preview" && (
          <div>
            <p className="text-sm mb-2">
              Encontramos <strong>{parsedItems.length}</strong> medicina(s) listas para importar.
            </p>
            {errors.length > 0 && (
              <div className="flex items-start gap-2 bg-[#FBEAE4] border border-[#E8846B] rounded-lg p-3 text-[12px] text-[#B3462C] mb-3">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <div>{errors.join(" ")}</div>
              </div>
            )}
            <div className="border border-[#D8D3C7] rounded-lg overflow-hidden mb-4 max-h-64 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] text-[#8A8578] bg-white border-b border-[#D8D3C7]">
                    <th className="px-3 py-2 font-medium">Nombre</th>
                    <th className="px-3 py-2 font-medium">Unidad</th>
                    <th className="px-3 py-2 font-medium">Cantidad</th>
                    <th className="px-3 py-2 font-medium">Precio</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedItems.map((p, i) => (
                    <tr key={i} className="border-b border-[#EDEAE1] last:border-0 bg-white">
                      <td className="px-3 py-1.5">{p.name}</td>
                      <td className="px-3 py-1.5 capitalize text-[#8A8578]">{p.unit}</td>
                      <td className="px-3 py-1.5">{p.quantity}</td>
                      <td className="px-3 py-1.5">{currency(p.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setStatus("idle")}
                className="flex-1 py-2.5 rounded-lg border border-[#D8D3C7] text-sm hover:bg-white"
              >
                Elegir otro archivo
              </button>
              <button
                onClick={() => onApply(parsedItems)}
                className="flex-1 py-2.5 rounded-lg bg-[#0F3A34] text-white text-sm font-medium hover:bg-[#0B2C27]"
              >
                Aplicar al inventario
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
